// Optional, extension-owned MemCode connection. Never expose tokens to the
// model, a skill manifest, page scripts, or the portable settings export.
export const MEMCODE_CONNECTION_KEY = 'wb_memcode_oauth_v1';
export const MEMCODE_RECALL_ENABLED_KEY = 'wb_memcode_recall_enabled';
const ISSUER = 'https://memory.memcode.in';
const RESOURCE = 'https://memory.memcode.in';
const ENDPOINT = 'https://memory.memcode.in/v2/memory/search';
const SCOPES = 'memory:read';

function base64url(bytes) {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomValue(cryptoApi, length = 32) {
  return base64url(cryptoApi.getRandomValues(new Uint8Array(length)));
}

async function checkedJson(response) {
  if (!response.ok) throw new Error(`MemCode returned HTTP ${response.status}.`);
  return response.json();
}

export function createMemcodeRecall({ storage, identity, fetcher = fetch, cryptoApi = crypto, now = Date.now }) {
  let refreshInFlight = null;
  let generation = 0;
  let lifecycleOwner = null;
  let recallRevision = 0;
  let settledRecallRevision = 0;
  let mutation = Promise.resolve();
  const read = async () => (await storage.get(MEMCODE_CONNECTION_KEY))[MEMCODE_CONNECTION_KEY] || null;
  const mutate = operation => {
    const next = mutation.catch(() => {}).then(operation);
    mutation = next;
    return next;
  };
  const sameConnection = (a, b) => !!a && !!b && a.clientId === b.clientId
    && a.accountId === b.accountId && a.refreshToken === b.refreshToken;
  const requireGeneration = expected => {
    if (expected !== generation) throw new Error('MemCode connection changed during this request.');
  };
  const withLifecycle = async operation => {
    const owner = ++generation;
    lifecycleOwner = owner;
    try { return await operation(owner); }
    finally { if (lifecycleOwner === owner) lifecycleOwner = null; }
  };
  const requireStableConnection = () => {
    if (lifecycleOwner !== null) throw new Error('MemCode connection is changing. Retry after it finishes.');
    if (settledRecallRevision !== recallRevision) throw new Error('MemCode recall setting is changing. Retry after it finishes.');
  };
  const requireRecall = async lease => {
    const values = await storage.get([MEMCODE_CONNECTION_KEY, MEMCODE_RECALL_ENABLED_KEY]);
    requireGeneration(lease.generation);
    requireStableConnection();
    if (lease.recallRevision !== recallRevision || values[MEMCODE_RECALL_ENABLED_KEY] !== true
        || !sameConnection(values[MEMCODE_CONNECTION_KEY], lease.connection)) {
      throw new Error('MemCode connection or recall setting changed during this request.');
    }
  };

  async function tokenRequest(fields) {
    return checkedJson(await fetcher(`${ISSUER}/auth/mcp/oauth/token`, {
      method: 'POST', credentials: 'omit',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, resource: RESOURCE }),
    }));
  }

  function tokenBundle(clientId, redirectUri, data) {
    if (!data?.access_token || !data?.refresh_token || data?.token_type?.toLowerCase() !== 'bearer') {
      throw new Error('MemCode returned an incomplete OAuth token response.');
    }
    if (data.resource !== RESOURCE || data.scope !== SCOPES) {
      throw new Error('MemCode did not return a read-only token for the expected resource.');
    }
    return {
      clientId, redirectUri, accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: now() + Math.max(0, Number(data.expires_in) || 0) * 1000,
    };
  }

  async function connect() {
    return withLifecycle(async owner => {
      const redirectUri = identity.getRedirectURL('memcode');
      if (!redirectUri?.startsWith('https://')) throw new Error('A secure browser-extension redirect is required.');
      const client = await checkedJson(await fetcher(`${ISSUER}/auth/mcp/oauth/register`, {
        method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'WebBrain', software_id: 'webbrain', redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
          token_endpoint_auth_method: 'none', application_type: 'native', scope: SCOPES,
        }),
      }));
      if (!client?.client_id) throw new Error('MemCode did not register the OAuth client.');
      requireGeneration(owner);
      const verifier = randomValue(cryptoApi, 48);
      const challenge = base64url(new Uint8Array(await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      requireGeneration(owner);
      const state = randomValue(cryptoApi);
      const url = new URL('https://app.memcode.in/oauth/authorize');
      url.search = new URLSearchParams({
        response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri,
        scope: SCOPES, resource: RESOURCE, state,
        code_challenge: challenge, code_challenge_method: 'S256',
      }).toString();
      const callback = new URL(await identity.launchWebAuthFlow({ url: url.href, interactive: true }));
      requireGeneration(owner);
      const expected = new URL(redirectUri);
      if (callback.origin !== expected.origin || callback.pathname !== expected.pathname
        || callback.searchParams.get('state') !== state) throw new Error('MemCode OAuth redirect did not match this connection.');
      if (callback.searchParams.get('iss') !== `${ISSUER}/`) throw new Error('MemCode OAuth issuer did not match.');
      if (callback.searchParams.has('error')) throw new Error('MemCode sign-in was denied or cancelled.');
      const code = callback.searchParams.get('code');
      if (!code) throw new Error('MemCode OAuth redirect contained no code.');
      const data = await tokenRequest({
        grant_type: 'authorization_code', code, client_id: client.client_id,
        redirect_uri: redirectUri, code_verifier: verifier,
      });
      const bundle = tokenBundle(client.client_id, redirectUri, data);
      requireGeneration(owner);
      const account = await checkedJson(await fetcher(`${ISSUER}/auth/mcp/oauth/userinfo`, {
        method: 'GET', credentials: 'omit', headers: { Authorization: `Bearer ${bundle.accessToken}` },
      }));
      if (!account?.sub || account.resource !== RESOURCE || account.scope !== SCOPES) {
        throw new Error('MemCode did not confirm the expected read-only account.');
      }
      bundle.accountId = String(account.sub).slice(0, 128);
      await mutate(async () => {
        requireGeneration(owner);
        await storage.set({ [MEMCODE_CONNECTION_KEY]: bundle, [MEMCODE_RECALL_ENABLED_KEY]: false });
      });
      requireGeneration(owner);
      // A new connection does not silently enable recall or remote writes.
      return status();
    });
  }

  async function disconnect() {
    return withLifecycle(async owner => {
      const connection = await read();
      await mutate(async () => {
        if (owner !== generation) return;
        await storage.remove(MEMCODE_CONNECTION_KEY);
        await storage.set({ [MEMCODE_RECALL_ENABLED_KEY]: false });
      });
      if (owner !== generation) return { ...await status(), revocationFailed: false };
      let revocationFailed = false;
      if (connection?.refreshToken && connection?.clientId) {
        try {
          const response = await fetcher(`${ISSUER}/auth/mcp/oauth/revoke`, {
            method: 'POST', credentials: 'omit',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: connection.refreshToken,
              client_id: connection.clientId, token_type_hint: 'refresh_token' }),
          });
          revocationFailed = !response.ok;
        } catch { revocationFailed = true; }
      }
      if (owner !== generation) return { ...await status(), revocationFailed };
      return { connected: false, recallEnabled: false, revocationFailed };
    });
  }

  async function status() {
    const [connection, setting] = await Promise.all([
      read(), storage.get(MEMCODE_RECALL_ENABLED_KEY),
    ]);
    return { connected: !!connection, accountId: connection?.accountId || null,
      recallEnabled: !!connection && setting[MEMCODE_RECALL_ENABLED_KEY] === true };
  }

  async function setRecallEnabled(enabled) {
    const owner = generation, revision = ++recallRevision;
    try {
      const connection = await read();
      requireGeneration(owner);
      if (enabled === true && !connection) throw new Error('Connect MemCode before enabling recall.');
      await mutate(async () => {
        requireGeneration(owner);
        if (revision !== recallRevision) throw new Error('MemCode recall setting changed during this request.');
        const current = await read();
        requireGeneration(owner);
        if (revision !== recallRevision || (connection ? !sameConnection(connection, current) : !!current)) {
          throw new Error('MemCode connection or recall setting changed during this request.');
        }
        await storage.set({ [MEMCODE_RECALL_ENABLED_KEY]: enabled === true && !!connection });
      });
      const result = await status();
      requireGeneration(owner);
      if (revision !== recallRevision) throw new Error('MemCode recall setting changed during this request.');
      return result;
    } finally {
      if (revision === recallRevision) settledRecallRevision = revision;
    }
  }

  async function accessToken() {
    const owner = generation;
    const connection = await read();
    requireGeneration(owner);
    if (!connection) throw new Error('Connect MemCode in Settings first.');
    if (connection.expiresAt > now() + 60_000) return { token: connection.accessToken, connection, generation: owner };
    if (!refreshInFlight || refreshInFlight.generation !== owner
        || !sameConnection(refreshInFlight.connection, connection)) {
      const refresh = { generation: owner, connection, promise: null };
      refreshInFlight = refresh;
      refresh.promise = (async () => {
        try {
          const data = await tokenRequest({ grant_type: 'refresh_token',
            refresh_token: connection.refreshToken, client_id: connection.clientId });
          const next = tokenBundle(connection.clientId, connection.redirectUri, data);
          next.accountId = connection.accountId || null;
          await mutate(async () => {
            requireGeneration(owner);
            if (!sameConnection(await read(), connection)) {
              throw new Error('MemCode connection changed during token refresh.');
            }
            requireGeneration(owner);
            await storage.set({ [MEMCODE_CONNECTION_KEY]: next });
          });
          requireGeneration(owner);
          return { token: next.accessToken, connection: next, generation: owner };
        } catch (error) {
          // Permanent invalid-grant failures need reconnection; temporary
          // network failures keep the refresh credential for a later retry.
          if (/HTTP (400|401)\b/.test(error.message || '')) {
            await mutate(async () => {
              if (owner !== generation) return;
              const current = await read();
              if (owner !== generation || !sameConnection(current, connection)) return;
              await storage.remove(MEMCODE_CONNECTION_KEY);
              await storage.set({ [MEMCODE_RECALL_ENABLED_KEY]: false });
            });
          }
          throw error;
        }
      })().finally(() => { if (refreshInFlight === refresh) refreshInFlight = null; });
    }
    return refreshInFlight.promise;
  }

  async function recall(query, { signal } = {}) {
    signal?.throwIfAborted();
    const owner = generation, revision = recallRevision;
    const current = await status();
    if (!current.recallEnabled) return { success: false, error: 'MemCode recall is disabled in Settings.' };
    const text = String(query || '').trim();
    if (!text || text.length > 300) return { success: false, error: 'Recall query must be 1–300 characters.' };
    try {
      requireGeneration(owner);
      requireStableConnection();
      const lease = { ...await accessToken(), recallRevision: revision };
      requireGeneration(owner);
      await requireRecall(lease);
      signal?.throwIfAborted();
      const response = await checkedJson(await fetcher(ENDPOINT, {
        signal,
        method: 'POST', credentials: 'omit',
        headers: { Authorization: `Bearer ${lease.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: text, mode: 'memories', top_k: 5,
          include_original_chunks: false }),
      }));
      await requireRecall(lease);
      if (response?.status === 'error') throw new Error('MemCode recall failed.');
      signal?.throwIfAborted();
      const results = response?.data?.results;
      if (!Array.isArray(results)) throw new Error('MemCode returned an invalid search response.');
      const snippets = results.slice(0, 5).map(item => ({
        domain: String(item?.domain || 'memory').slice(0, 32),
        content: String(item?.content || '').slice(0, 800),
      }));
      return { success: true, source: 'MemCode', results: snippets };
    } catch (error) {
      return { success: false, error: error.message || 'MemCode recall is unavailable.' };
    }
  }

  return { connect, disconnect, status, setRecallEnabled, recall };
}
