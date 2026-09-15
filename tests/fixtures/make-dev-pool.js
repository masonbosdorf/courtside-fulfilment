/* node tests/fixtures/make-dev-pool.js <out.enc> [passphrase=dev] [--plain out.json]
   A deterministic SYNTHETIC pick pool for developing and self-testing picks.html — no real
   customers. Real style codes are used only so Stock Finder thumbnails render. */
const fs = require('fs');
const path = require('path');
const { encryptJSON } = require('../../pick-crypto');

const out = process.argv[2];
const pass = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'dev';
const plainAt = process.argv.indexOf('--plain');
if (!out) { console.error('usage: node tests/fixtures/make-dev-pool.js <out.enc> [passphrase] [--plain out.json]'); process.exit(1); }

let seed = 20260915;
const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const p = (n, w) => String(n).padStart(w, '0');
const weighted = pairs => { let r = rnd() * pairs.reduce((s, x) => s + x[1], 0); for (const [v, w] of pairs) { if ((r -= w) < 0) return v; } return pairs[0][0]; };

// [parent, description, class, sizes, bin family]
const STYLES = [
  ['FZ5198-480', 'NIKE LEGEND DRI-FIT TEE - YOUTH', 'app', ['S', 'M', 'L', 'XL'], 'apparelFront'],
  ['IQ8249-525', 'NIKE JA DRI-FIT GAME SHORT - YOUTH', 'app', ['S', 'M', 'L'], 'apparelBack'],
  ['NB1-53YSHE79-SEMBLK', 'SE MELBOURNE PHOENIX YOUTH PRIMARY SHORTS-BLACK', 'app', ['10', '12', '14'], 'apparelBack'],
  ['NB1-53MTSD91-SEMBLK', 'SE MELBOURNE PHOENIX LIFESTYLE S/S T-SHIRT-BLACK', 'app', ['S', 'M', 'L', 'XL'], 'mezz'],
  ['305381-007', 'AIR JORDAN 8 RETRO "CHROME"', 'fw', ['8', '9', '10', '10.5', '11', '12'], 'footwear'],
  ['IU6793-800', 'NIKE BOOK 2 EP', 'fw', ['9', '10', '11', '12.5'], 'footwear'],
  ['IO6257-001', 'NIKE KOBE VIII PROTRO', 'fw', ['10', '11', '13'], 'footwear'],
  ['SWZ_005', 'SNEAKER LAB SNEAKER WIPES 12 DOY', 'acc', ['Misc'], 'sneakerlab'],
  ['70957769', 'NEW ERA 9FORTY CAP', 'acc', ['OSFA'], 'newEra'],
  ['2662101', 'PUMA LAMELO TRUCKER CAP', 'acc', ['MISC'], 'accessories'],
];
const binFor = fam => {
  switch (fam) {
    case 'apparelFront': return `A-${p(int(1, 39), 3)}-${p(int(1, 4), 2)}-${p(int(1, 40), 3)}`;
    case 'apparelBack': return `A-${p(int(160, 183), 3)}-${p(int(1, 4), 2)}-${p(int(1, 40), 3)}`;
    case 'footwear': return `A-${p(int(40, 119), 3)}-${p(int(1, 4), 2)}`;
    case 'accessories': return rnd() < 0.5 ? `A-${p(int(120, 139), 3)}-${p(int(1, 4), 2)}-${p(int(1, 30), 3)}` : `D-${p(int(1, 20), 3)}-${p(int(1, 4), 2)}`;
    case 'mezz': return `1F-${p(int(1, 9), 2)}-${p(int(1, 112), 3)}`;
    case 'newEra': return `NE-${p(int(1, 40), 2)}`;
    case 'sneakerlab': return 'SNEAKERLAB';
    default: return 'B-001-01';
  }
};

const bins = {};
const skus = [];
for (const [parent, desc, cls, sizes, fam] of STYLES) {
  for (const size of sizes) {
    const sku = `${parent}-${size}`;
    const n = rnd() < 0.25 ? 2 : 1;
    bins[sku] = [];
    for (let i = 0; i < n; i++) bins[sku].push([binFor(fam), int(1, 5)]);
    if (rnd() < 0.08) bins[sku].push(['Sales Floor', int(1, 3)]);
    skus.push({ sku, parent, desc, cls, size });
  }
}
// a few SKUs with no warehouse stock at all → "short" exceptions
for (const s of skus.slice(0, 2)) bins[s.sku] = [];

const STATES = [['VIC', 40], ['NSW', 25], ['QLD', 14], ['WA', 8], ['SA', 6], ['TAS', 3], ['ACT', 2], ['NT', 2]];
const now = Date.now();
const orders = [];
for (let i = 1; i <= 72; i++) {
  const type = weighted([['standard', 70], ['express', 12], ['pickup', 18]]);
  const nLines = weighted([[1, 65], [2, 25], [3, 10]]);
  const chosen = new Map();
  while (chosen.size < nLines) { const s = pick(skus); chosen.set(s.sku, s); }
  const state = type === 'pickup' ? '' : weighted(STATES);
  const name = `Test Customer ${p(i, 2)}`;
  const addr = { name, company: '', a1: `${int(1, 250)} Sample Street`, a2: '', city: 'Testville', state: state || 'VIC', zip: String(int(3000, 3999)), country: 'AU', phone: '0400 000 000' };
  orders.push({
    no: String(90000 + i), gid: 'gid://shopify/Order/test' + i,
    at: new Date(now - int(10, 5 * 24 * 60) * 60000).toISOString(),
    type, method: type === 'express' ? 'Express' : type === 'pickup' ? 'CourtSide' : 'Standard', state,
    note: rnd() < 0.08 ? 'Please double-box — gift.' : '', attrs: [],
    hold: rnd() < 0.02, pickupReady: type === 'pickup' && rnd() < 0.3,
    shipTo: type === 'pickup' ? null : addr, billTo: addr,
    lines: [...chosen.values()].map(s => ({ sku: s.sku, qty: rnd() < 0.12 ? 2 : 1, desc: s.desc, size: s.size, cls: s.cls, parent: s.parent })),
    so: rnd() < 0.96 ? { id: String(700000 + i), tranid: 'SO00' + (90000 + i) } : null,
    ifDone: rnd() < 0.1,
  });
}

const pool = { v: 1, asOf: new Date(now - 4 * 60000).toISOString(), synthetic: true, orders, bins };
(async () => {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, await encryptJSON(pool, pass));
  if (plainAt > 0) fs.writeFileSync(process.argv[plainAt + 1], JSON.stringify(pool, null, 1));
  console.log(`dev pool: ${orders.length} orders, ${Object.keys(bins).length} SKUs → ${out} (passphrase "${pass}")`);
})();
