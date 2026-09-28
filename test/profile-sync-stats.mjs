import test from 'node:test';
import assert from 'node:assert/strict';

for (const browser of ['chrome', 'firefox']) {
  test(`${browser} sync reports counts from the portable encrypted vault`, async () => {
    const { ProfileSyncManager, profileVaultSummary } = await import(`../src/${browser}/src/profile-sync.js`);
    const values = {
      providers: {
        openai: { configured: true, apiKey: 'private-key' },
        anthropic: { configured: false },
        webgpu: { type: 'webgpu', configured: true },
      },
      activeProvider: 'openai',
      profileEnabled: true,
      profileText: 'Saved profile text',
      wb_user_memory_v1: { records: [
        { id: 'first', text: 'Prefers concise answers' },
        { id: 'second', text: 'Works in Istanbul' },
      ] },
      profileSyncEnabled: true,
      profileSyncToken: 'scoped-token',
    };
    const manager = new ProfileSyncManager({ get: async () => values, set: async () => {} });
    const local = await manager.localVault();
    assert.deepEqual(profileVaultSummary(local), {
      version: 1, provider_count: 1, memory_count: 2, profile_count: 1,
    });
    assert.deepEqual(profileVaultSummary({
      ...local,
      memory: { records: [
        { id: 'first', text: 'Prefers concise answers' },
        { id: 'duplicate', text: 'Prefers concise answers' },
      ] },
      profile: { text: '   ' },
    }), { version: 1, provider_count: 1, memory_count: 1, profile_count: 0 });
    let uploaded;
    manager.request = async (path, options) => {
      if (options?.method === 'PUT') {
        uploaded = JSON.parse(options.body);
        return { body: { revision: 1 } };
      }
      const error = new Error('No vault');
      error.status = 404;
      throw error;
    };
    manager.password = 'test password';
    await manager.runSync({ create: true });
    assert.deepEqual(uploaded.summary, {
      version: 1, provider_count: 1, memory_count: 2, profile_count: 1,
    });
    assert.equal(JSON.stringify(uploaded.envelope).includes('private-key'), false);
    assert.equal(JSON.stringify(uploaded.summary).includes('Saved profile text'), false);
  });
}
