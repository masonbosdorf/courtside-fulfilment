/* pick-store.js — where Pick Waves reads the pool and reads/writes waves. Same interface twice:

   GitHubStore (production, browser) — GitHub REST Contents API with the fine-grained token
     getPool()                 GET  contents/pick-pool.enc?ref=pick-data        (raw, encrypted)
     getIndex()                GET  contents/waves/index.json?ref=waves         → {index, sha}
     putIndex(index, sha, msg) PUT  contents/waves/index.json  (sha = the lock) → {sha}
     getWave(id)               GET  contents/waves/<id>.enc?ref=waves           (raw, encrypted)
     putWave(id, text, msg)    PUT  contents/waves/<id>.enc    (create-only)
     delWave(id, msg)          DEL  contents/waves/<id>.enc    → false if already gone

   LocalStore (dev + tests) — the same contract over memory or localStorage with simulated shas.

   Errors carry err.code: CONFLICT (someone saved first / id taken) · AUTH (token rejected) ·
   FORBIDDEN (token lacks permission, or rate limit) · NOT_FOUND · HTTP.
   Node: require('./pick-store'). Browser: window.PickStore. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PickStore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const te = new TextEncoder(), td = new TextDecoder();
  const b64encode = s => {
    const u = te.encode(String(s));
    let b = '';
    for (let i = 0; i < u.length; i += 0x8000) b += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(b);
  };
  const b64decode = s => {
    const b = atob(String(s).replace(/\s/g, ''));
    const u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return td.decode(u);
  };
  const emptyIndex = () => ({ v: 1, updated: null, waves: [] });
  const fail = (code, message) => Object.assign(new Error(message), { code });

  function GitHubStore(opts) {
    const repo = opts.repo, token = opts.token;
    const api = opts.api || 'https://api.github.com';
    const doFetch = opts.fetch || ((u, i) => fetch(u, i));
    const poolBranch = opts.poolBranch || 'pick-data';
    const wavesBranch = opts.wavesBranch || 'waves';
    const url = (path, ref) => `${api}/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}` +
      (ref ? `?ref=${encodeURIComponent(ref)}` : '');

    async function call(method, u, o) {
      o = o || {};
      const headers = {
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
        Accept: o.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      };
      if (o.body) headers['Content-Type'] = 'application/json';
      const res = await doFetch(u, { method, cache: 'no-store', headers, body: o.body ? JSON.stringify(o.body) : undefined });
      if (res.ok) return o.raw ? res.text() : res.json();
      let msg = '';
      try { msg = (await res.json()).message || ''; } catch (e) { /* no body */ }
      if (res.status === 401) throw fail('AUTH', 'GitHub rejected the token — it has expired or been revoked.');
      if (res.status === 403) throw fail('FORBIDDEN', /rate limit/i.test(msg)
        ? 'GitHub rate limit reached — wait a minute and try again.'
        : `This token can't do that — it needs Contents: Read and write on ${repo}.`);
      if (res.status === 404) throw fail('NOT_FOUND', msg || 'Not found');
      if (res.status === 409 || (res.status === 422 && /sha/i.test(msg))) throw fail('CONFLICT', 'Someone else saved at the same moment.');
      throw fail('HTTP', `GitHub ${res.status}${msg ? ': ' + msg : ''}`);
    }

    return {
      kind: 'github',
      getPool: () => call('GET', url('pick-pool.enc', poolBranch), { raw: true }),
      async getIndex() {
        try {
          const j = await call('GET', url('waves/index.json', wavesBranch));
          return { index: JSON.parse(b64decode(j.content)), sha: j.sha };
        } catch (e) {
          if (e.code === 'NOT_FOUND') return { index: emptyIndex(), sha: null };
          throw e;
        }
      },
      async putIndex(index, sha, message) {
        const body = { message: message || 'Update wave register', branch: wavesBranch,
          content: b64encode(JSON.stringify(index, null, 1) + '\n') };
        if (sha) body.sha = sha;
        const j = await call('PUT', url('waves/index.json'), { body });
        return { sha: j.content.sha };
      },
      getWave: id => call('GET', url(`waves/${id}.enc`, wavesBranch), { raw: true }),
      async putWave(id, text, message) {
        await call('PUT', url(`waves/${id}.enc`), { body: { message: message || `Wave ${id}`, branch: wavesBranch, content: b64encode(text) } });
      },
      // permanent: the encrypted slips (which hold the addresses) go with the register entry.
      // false = there was nothing to delete, which is not an error.
      async delWave(id, message) {
        let sha;
        try { sha = (await call('GET', url(`waves/${id}.enc`, wavesBranch))).sha; }
        catch (e) { if (e.code === 'NOT_FOUND') return false; throw e; }
        await call('DELETE', url(`waves/${id}.enc`), { body: { message: message || `Delete wave ${id}`, branch: wavesBranch, sha } });
        return true;
      },
    };
  }

  function LocalStore(opts) {
    opts = opts || {};
    const key = opts.key || 'pw_dev_store';
    const storage = opts.storage || null;
    let files = {};
    try { if (storage) files = JSON.parse(storage.getItem(key) || '{}'); } catch (e) { files = {}; }
    let n = 0;
    const persist = () => { if (storage) try { storage.setItem(key, JSON.stringify(files)); } catch (e) { /* quota */ } };
    const newSha = () => `local-${++n}-${Date.now().toString(36)}`;

    return {
      kind: 'local',
      async getPool() {
        if (opts.poolText != null) return opts.poolText;
        if (!opts.poolUrl) throw fail('NOT_FOUND', 'No dev pool configured');
        const r = await (opts.fetch || fetch)(opts.poolUrl, { cache: 'no-store' });
        if (!r.ok) throw fail('NOT_FOUND', 'Dev pool not found: ' + opts.poolUrl);
        return r.text();
      },
      async getIndex() {
        const f = files['waves/index.json'];
        return f ? { index: JSON.parse(f.text), sha: f.sha } : { index: emptyIndex(), sha: null };
      },
      async putIndex(index, sha) {
        const f = files['waves/index.json'];
        if ((f && f.sha !== sha) || (!f && sha)) throw fail('CONFLICT', 'Someone else saved at the same moment.');
        const s = newSha();
        files['waves/index.json'] = { text: JSON.stringify(index), sha: s };
        persist();
        return { sha: s };
      },
      async getWave(id) {
        const f = files[`waves/${id}.enc`];
        if (!f) throw fail('NOT_FOUND', 'Wave file missing: ' + id);
        return f.text;
      },
      async putWave(id, text) {
        if (files[`waves/${id}.enc`]) throw fail('CONFLICT', 'Wave id already used: ' + id);
        files[`waves/${id}.enc`] = { text, sha: newSha() };
        persist();
      },
      async delWave(id) {
        const k = `waves/${id}.enc`;
        if (!files[k]) return false;
        delete files[k];
        persist();
        return true;
      },
      reset() { files = {}; persist(); },
    };
  }

  return { GitHubStore, LocalStore, b64encode, b64decode };
});
