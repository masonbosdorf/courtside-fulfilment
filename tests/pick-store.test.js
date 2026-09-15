/* node --test tests/pick-store.test.js — the store contract, run against LocalStore and against
   GitHubStore talking to a fake GitHub Contents API (no network, no token). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHubStore, LocalStore, b64encode, b64decode } = require('../pick-store');

// minimal GitHub Contents API: branch-scoped files, sha checks, raw vs JSON accept, auth
function fakeGitHub(token, seed) {
  let n = 0;
  const files = {};
  const sha = () => 'sha' + (++n);
  for (const [k, v] of Object.entries(seed || {})) files[k] = { text: v, sha: sha() };
  const res = (status, body, raw) => ({
    ok: status < 300, status,
    json: async () => body,
    text: async () => (raw != null ? raw : JSON.stringify(body)),
  });
  const calls = [];
  async function fetch(u, init) {
    calls.push({ method: init.method, u, cache: init.cache });
    if (init.headers.Authorization !== 'Bearer ' + token) return res(401, { message: 'Bad credentials' });
    const url = new URL(u);
    const m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
    const path = decodeURIComponent(m[1]);
    if (init.method === 'GET') {
      const f = files[url.searchParams.get('ref') + ':' + path];
      if (!f) return res(404, { message: 'Not Found' });
      if (/raw/.test(init.headers.Accept)) return res(200, null, f.text);
      return res(200, { sha: f.sha, encoding: 'base64', content: Buffer.from(f.text).toString('base64').replace(/(.{60})/g, '$1\n') });
    }
    const b = JSON.parse(init.body);
    const k = b.branch + ':' + path, f = files[k];
    if (f && !b.sha) return res(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
    if (f && b.sha !== f.sha) return res(409, { message: `${path} does not match ${b.sha}` });
    const s = sha();
    files[k] = { text: Buffer.from(b.content, 'base64').toString('utf8'), sha: s };
    return res(f ? 200 : 201, { content: { sha: s } });
  }
  return { fetch, files, calls };
}

const makers = {
  LocalStore: () => ({ store: LocalStore({ poolText: 'POOL' }) }),
  GitHubStore: () => {
    const gh = fakeGitHub('tok', { 'pick-data:pick-pool.enc': 'POOL' });
    return { store: GitHubStore({ repo: 'o/r', token: 'tok', fetch: gh.fetch }), gh };
  },
};

for (const [name, make] of Object.entries(makers)) {
  test(`${name}: pool, empty register, create, lock, waves`, async () => {
    const { store } = make();
    assert.equal(await store.getPool(), 'POOL');

    const empty = await store.getIndex();
    assert.deepEqual(empty, { index: { v: 1, updated: null, waves: [] }, sha: null });

    const idx1 = { v: 1, updated: 'x', waves: [{ id: 'W-260915-01', orders: [{ no: '1', lines: [['SKU', 'A-001-01', 1]] }] }] };
    const r1 = await store.putIndex(idx1, null, 'first');
    assert.ok(r1.sha);
    const got = await store.getIndex();
    assert.deepEqual(got.index, idx1);
    assert.equal(got.sha, r1.sha);

    // a stale sha loses: this is the lock that stops two devices taking the same orders
    await assert.rejects(store.putIndex({ v: 1, waves: [] }, 'stale-sha'), e => e.code === 'CONFLICT');
    // writing over an existing register without a sha loses too
    await assert.rejects(store.putIndex({ v: 1, waves: [] }, null), e => e.code === 'CONFLICT');
    const r2 = await store.putIndex({ v: 1, waves: [] }, r1.sha);
    assert.notEqual(r2.sha, r1.sha);

    // wave files are create-only and round-trip exactly, including non-ASCII
    const enc = '{"v":1,"ct":"Zoë — ✓ 吴"}';
    await store.putWave('W-260915-01', enc);
    assert.equal(await store.getWave('W-260915-01'), enc);
    await assert.rejects(store.putWave('W-260915-01', 'again'), e => e.code === 'CONFLICT');
    await assert.rejects(store.getWave('W-nope'), e => e.code === 'NOT_FOUND');
  });
}

test('GitHubStore: token errors, branches, no-store caching', async () => {
  const gh = fakeGitHub('right', { 'pick-data:pick-pool.enc': 'POOL' });
  const bad = GitHubStore({ repo: 'o/r', token: 'wrong', fetch: gh.fetch });
  await assert.rejects(bad.getPool(), e => e.code === 'AUTH');
  await assert.rejects(bad.getIndex(), e => e.code === 'AUTH');   // AUTH is not swallowed as "no register yet"

  const s = GitHubStore({ repo: 'o/r', token: 'right', fetch: gh.fetch });
  await s.putIndex({ v: 1, waves: [] }, null);
  await s.putWave('W-1', 'x');
  assert.ok(gh.files['waves:waves/index.json'], 'register lives on the waves branch');
  assert.ok(gh.files['waves:waves/W-1.enc'], 'wave files live on the waves branch');
  assert.ok(gh.calls.every(c => c.cache === 'no-store'), 'every call bypasses the HTTP cache');

  const noPool = GitHubStore({ repo: 'o/r', token: 'right', fetch: fakeGitHub('right').fetch });
  await assert.rejects(noPool.getPool(), e => e.code === 'NOT_FOUND');
});

test('GitHubStore maps 403 to FORBIDDEN with a useful message', async () => {
  const fetch403 = async () => ({ ok: false, status: 403, json: async () => ({ message: 'Resource not accessible by personal access token' }) });
  const s = GitHubStore({ repo: 'o/r', token: 't', fetch: fetch403 });
  await assert.rejects(s.putWave('W-1', 'x'), e => e.code === 'FORBIDDEN' && /Contents: Read and write/.test(e.message));
  const fetchRate = async () => ({ ok: false, status: 403, json: async () => ({ message: 'API rate limit exceeded' }) });
  await assert.rejects(GitHubStore({ repo: 'o/r', token: 't', fetch: fetchRate }).getPool(), e => /rate limit/.test(e.message));
});

test('base64 helpers are UTF-8 safe', () => {
  const s = 'Zoë Ng 吴 — “quoted” 🎉';
  assert.equal(b64decode(b64encode(s)), s);
  assert.equal(b64decode(b64encode(s).replace(/(.{10})/g, '$1\n')), s);
});
