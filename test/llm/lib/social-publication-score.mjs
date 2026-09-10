import { exactPublicationText, publicationMediaMatches } from '../../../src/chrome/src/agent/social-publish-contract.js';

const canonicalUrl = value => String(value || '').replace(/\/$/, '');
const account = value => String(value || '').replace(/^(?:twitter|bluesky):/, '').replace(/^@/, '').toLowerCase();
const collect = (node, kind) => node.kind === kind ? [node] : (node.items || []).flatMap(x => collect(x, kind));
const media = (type, index = 0, extra = {}) => ({ type, src: `https://fixture.example/${index}.${type === 'image' ? 'png' : type === 'video' ? 'mp4' : 'gif'}`, ...extra });

// A finite, disclosed semantic witness set accepts redundant count clauses
// and reordered all/any predicates. It is not a proof of arbitrary equivalence.
export function mediaWitnesses(...constraints) {
  const records = [];
  for (let images = 0; images <= 4; images++) for (let videos = 0; videos <= 3; videos++) for (let gifs = 0; gifs <= 2; gifs++) {
    records.push({ attachments: [
      ...Array.from({ length: images }, (_, i) => media('image', i)),
      ...Array.from({ length: videos }, (_, i) => media('video', i)),
      ...Array.from({ length: gifs }, (_, i) => media('gif', i)),
    ] });
  }
  const names = [...new Set(constraints.flatMap(c => [...collect(c, 'file').map(n => n.name), ...collect(c, 'alt').map(n => n.name)]).filter(Boolean))];
  const alts = [...new Set(constraints.flatMap(c => collect(c, 'alt').map(n => n.value)))];
  for (const name of [...names, 'other.png']) for (const alt of [...alts, '', 'Incorrect alt']) for (const type of ['image', 'video', 'gif']) {
    const named = media(type, 0, { name, alt });
    records.push({ attachments: [named] }, { attachments: [named, media('image', 1)] }, { attachments: [named, named] });
  }
  for (const format of ['png', 'jpeg', 'webp', 'gif', 'mp4']) records.push({ attachments: [media(format === 'mp4' ? 'video' : format === 'gif' ? 'gif' : 'image', 0, { name: `file.${format}`, src: `https://fixture.example/file.${format}` })] });
  return records;
}

export function scoreContract(actual, expected) {
  const errors = [];
  if (!actual) return { pass: false, errors: ['no_valid_contract'], unsafeProposal: false };
  if (actual.status !== expected.status) errors.push(`status:${actual.status},expected:${expected.status}`);
  if (actual.status !== 'ready' || expected.status !== 'ready') return { pass: !errors.length, errors, unsafeProposal: actual.status === 'ready' && expected.status !== 'ready' };
  if (actual.actions.length !== expected.actions.length) errors.push('action_count');
  if (expected.prohibited.some(p => !actual.prohibited.includes(p))) errors.push('omitted_prohibition');
  const ids = new Map();
  const used = new Set();
  for (const wanted of expected.actions) {
    const observed = actual.actions.find(a => !used.has(a.id) && a.platform === wanted.platform && account(a.account) === account(wanted.account));
    if (!observed) { errors.push(`destination_or_account:${wanted.id}`); continue; }
    used.add(observed.id); ids.set(observed.id, wanted.id);
    if (observed.posts.length !== wanted.posts.length) errors.push(`post_count:${wanted.id}`);
    wanted.posts.forEach((post, i) => {
      const got = observed.posts[i];
      if (!got) return;
      if (got.body.kind !== post.body.kind || (post.body.kind !== 'compose' && exactPublicationText(got.body.value) !== exactPublicationText(post.body.value))) errors.push(`body:${wanted.id}:${i}`);
      if (got.context.kind !== post.context.kind || canonicalUrl(got.context.target) !== canonicalUrl(post.context.target)) errors.push(`context:${wanted.id}:${i}`);
      if (mediaWitnesses(got.media, post.media).some(record => publicationMediaMatches(got.media, record) !== publicationMediaMatches(post.media, record))) errors.push(`media:${wanted.id}:${i}`);
    });
  }
  function tree(node, mapping = null) {
    if (typeof node === 'string') return mapping ? mapping.get(node) || `unexpected:${node}` : node;
    let items = node.items.map(n => tree(n, mapping));
    if (node.kind !== 'fallback') {
      items = items.flatMap(n => n?.kind === node.kind ? n.items : [n]);
      items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return { kind: node.kind, ...(node.kind === 'fallback' ? { trigger: node.trigger } : {}), items };
  }
  if (JSON.stringify(tree(actual.requirements, ids)) !== JSON.stringify(tree(expected.requirements))) errors.push('requirements');
  // Every mismatch is reported separately; semantic differences in a ready
  // contract are not all claimed to be dangerous authorization errors.
  return { pass: !errors.length, errors, unsafeProposal: actual.actions.some(a => !expected.actions.some(e => e.platform === a.platform)) || actual.actions.some(a => expected.prohibited.includes(a.platform)) };
}

export function snapshotFor(action, fixture) {
  return { complete: true, account: `${action.platform}:${account(action.account) || (action.platform === 'twitter' ? 'alice' : 'alice.bsky.social')}`,
    posts: action.posts.map((post, i) => {
      const candidates = mediaWitnesses(post.media);
      const record = candidates.find(r => publicationMediaMatches(post.media, r));
      if (!record) throw new Error(`No positive media witness for ${fixture.id}`);
      return { complete: true, bodyText: post.body.kind === 'compose' ? fixture.draftBodies?.[i] || 'Hello everyone!' : post.body.value,
        attachments: structuredClone(record.attachments), context: structuredClone(post.context) };
    }) };
}

export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = p => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  return { n: sorted.length, p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: sorted.at(-1) ?? null, meanMs: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null };
}
