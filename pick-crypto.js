/* pick-crypto.js — encrypt/decrypt the pick pool and wave slips. The repo is PUBLIC, so anything
   with a customer name or address is only ever committed through this.
   Same file in node (pick-fetch.js, tests) and the browser (picks.html): Web Crypto only.
     PBKDF2-SHA256 (210k iterations, random 16-byte salt) → AES-GCM-256 (random 12-byte IV),
     payload gzipped first when CompressionStream exists (node ≥18, every current browser).
   Envelope: {"v":1,"alg":"A256GCM","kdf":"PBKDF2-SHA256","it":210000,"z":1,"salt","iv","ct"} (base64)
   Node:    const { encryptJSON, decryptJSON } = require('./pick-crypto');
   Browser: PickCrypto.encryptJSON(obj, pass) / PickCrypto.decryptJSON(text, pass) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PickCrypto = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const C = globalThis.crypto;
  const ITER = 210000;
  const te = new TextEncoder(), td = new TextDecoder();

  function b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(s) {
    const b = atob(s), u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  }
  async function pipe(u8, stream) {
    return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer());
  }
  async function deriveKey(pass, salt, iterations, usage) {
    const base = await C.subtle.importKey('raw', te.encode(String(pass)), 'PBKDF2', false, ['deriveKey']);
    return C.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      base, { name: 'AES-GCM', length: 256 }, false, [usage]);
  }

  async function encryptJSON(obj, pass) {
    if (!pass) throw new Error('no passphrase');
    let data = te.encode(JSON.stringify(obj)), z = 0;
    if (typeof CompressionStream === 'function') { data = await pipe(data, new CompressionStream('gzip')); z = 1; }
    const salt = C.getRandomValues(new Uint8Array(16));
    const iv = C.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pass, salt, ITER, 'encrypt');
    const ct = new Uint8Array(await C.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
    return JSON.stringify({ v: 1, alg: 'A256GCM', kdf: 'PBKDF2-SHA256', it: ITER, z, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
  }

  async function decryptJSON(text, pass) {
    const e = typeof text === 'string' ? JSON.parse(text) : text;
    if (!e || e.v !== 1 || e.alg !== 'A256GCM') throw new Error('unknown encrypted format');
    let data;
    try {
      const key = await deriveKey(pass, unb64(e.salt), e.it || ITER, 'decrypt');
      data = new Uint8Array(await C.subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.iv) }, key, unb64(e.ct)));
    } catch (err) {
      throw new Error('wrong passphrase (or the file is damaged)');
    }
    if (e.z) data = await pipe(data, new DecompressionStream('gzip'));
    return JSON.parse(td.decode(data));
  }

  return { encryptJSON, decryptJSON };
});
