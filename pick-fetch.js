/* pick-fetch.js — builds the ENCRYPTED pick pool that picks.html (Pick Waves) reads.
   Shopify: every open, paid, unshipped or partly-shipped shipping + pick-up order, with ship and
            bill addresses and only the lines still to fulfil.
   NetSuite: sales order (+ tranid) and item-fulfilment status per order; Loc 2 bin on-hand,
             parent (the Stock Finder thumbnail key) and class per SKU.
   The pool is encrypted with FS_PICK_KEY (pick-crypto.js) because the repo is public.
   Never writes a partial pool: any fetch failure exits non-zero and leaves the previous file.

   Usage:
     FS_PICK_KEY=… node pick-fetch.js <pick-pool.enc> [--plain <pool.json>]
                                      [--waves <waves/index.json> --seed <fulfilment-seed.js>]
       --plain         also write the UNENCRYPTED pool — local debugging only, never commit it
       --waves/--seed  write the no-PII wave progress summary into seed.waves */
const fs = require('fs');
const path = require('path');
const { graphql } = require('./shopify');
const { suiteql } = require('./netsuite');
const { encryptJSON } = require('./pick-crypto');
const PickLib = require('./pick-lib');

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const OUT = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : null;
const PLAIN = flag('--plain');
const WAVES = flag('--waves');
const SEED = flag('--seed');
const KEY = process.env.FS_PICK_KEY || '';

const TZ = 'Australia/Melbourne';
const EXPRESS = /express|overnight|priorit|next[\s-]?day|expedit/i;   // same rule as shopify-fetch.js
const wait = ms => new Promise(r => setTimeout(r, ms));

function melbourneNow() {
  const now = new Date();
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const o = {}; for (const p of f.formatToParts(now)) o[p.type] = p.value;
  const off = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
    .formatToParts(now).find(x => x.type === 'timeZoneName').value.replace('GMT', '') || '+10:00';
  return `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}:${o.second}${off}`;
}

// ------------------------------------------------------------------ Shopify

async function gql(query, variables) {
  for (let i = 0; ; i++) {
    try { return await graphql(query, variables); }
    catch (e) {
      if (i < 5 && /THROTTLED|HTTP 429/i.test(e.message)) { await wait(2000 * (i + 1)); continue; }
      throw e;
    }
  }
}

const ADDR = 'name company address1 address2 city provinceCode zip countryCodeV2 phone';
const ORDER_SEL = `id name createdAt note customAttributes{ key value } shippingLine{ title }
  shippingAddress{ ${ADDR} } billingAddress{ ${ADDR} }
  lineItems(first:50){ nodes{ sku title variantTitle unfulfilledQuantity requiresShipping product{ tags } } }
  fulfillmentOrders(first:10){ nodes{ status deliveryMethod{ methodType } } }`;

async function ordersFor(q) {
  const out = [];
  let after = null;
  do {
    const d = await gql(`query($q:String!,$a:String){ orders(first:50, after:$a, query:$q){
      nodes{ ${ORDER_SEL} } pageInfo{ hasNextPage endCursor } } }`, { q, a: after });
    out.push(...d.orders.nodes);
    after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
  } while (after);
  return out;
}

const addr = a => a ? {
  name: a.name || '', company: a.company || '', a1: a.address1 || '', a2: a.address2 || '',
  city: a.city || '', state: a.provinceCode || '', zip: a.zip || '', country: a.countryCodeV2 || '',
  phone: a.phone || '',
} : null;

const tagCls = tags => {
  const t = new Set((tags || []).map(x => String(x).toUpperCase()));
  return t.has('FOOTWEAR') ? 'fw' : t.has('APPAREL') ? 'app' : t.has('ACCESSORIES') ? 'acc' : 'oth';
};

// ------------------------------------------------------------------ NetSuite

const sq = s => "'" + String(s).replace(/'/g, "''") + "'";

// IN-list queries in chunks; a chunk that hits the 1000-row page limit is split and re-run
async function inChunks(values, size, build) {
  const run = async vals => {
    const rows = await suiteql(build(vals.map(sq).join(',')));
    if (rows.length >= 1000 && vals.length > 1) {
      const h = vals.length >> 1;
      return (await run(vals.slice(0, h))).concat(await run(vals.slice(h)));
    }
    return rows;
  };
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(...await run(values.slice(i, i + size)));
  return out;
}

const nsCls = c => (/FOOT/i.test(c) ? 'fw' : /APPAR/i.test(c) ? 'app' : /ACCESS/i.test(c) ? 'acc' : '');

function sizeOf(sku, parent, variantTitle) {
  const S = String(sku || ''), P = String(parent || '');
  if (P && S.toUpperCase().startsWith(P.toUpperCase() + '-')) return S.slice(P.length + 1);
  const vt = String(variantTitle || '').split('/')[0].trim();
  return vt && vt !== 'Default Title' ? vt : '';
}

// ------------------------------------------------------------------ main

async function main() {
  if (!OUT) throw new Error('usage: node pick-fetch.js <pick-pool.enc> [--plain pool.json] [--waves index.json --seed seed.js]');
  if (!KEY) throw new Error('FS_PICK_KEY is not set');
  const t0 = Date.now();

  // 1. Shopify — shipping + pick-up unshipped, plus anything partly shipped
  const BASE = 'status:open financial_status:paid';
  const [ship, pick, partial] = [
    await ordersFor(`${BASE} fulfillment_status:unshipped delivery_method:shipping`),
    await ordersFor(`${BASE} fulfillment_status:unshipped delivery_method:pick-up`),
    await ordersFor(`${BASE} fulfillment_status:partial`),
  ];
  const byId = new Map();
  for (const n of ship) byId.set(n.id, { n, pickup: false });
  for (const n of pick) byId.set(n.id, { n, pickup: true });
  for (const n of partial) if (!byId.has(n.id)) {
    const types = (n.fulfillmentOrders.nodes || []).map(f => f.deliveryMethod && f.deliveryMethod.methodType);
    if (types.includes('SHIPPING') || types.includes('PICK_UP')) byId.set(n.id, { n, pickup: types.includes('PICK_UP') && !types.includes('SHIPPING') });
  }

  const orders = [...byId.values()].map(({ n, pickup }) => {
    const fos = (n.fulfillmentOrders.nodes || []).map(f => f.status);
    const title = (n.shippingLine && n.shippingLine.title) || '';
    return {
      no: String(n.name).replace(/^#/, ''), gid: n.id, at: n.createdAt,
      type: pickup ? 'pickup' : EXPRESS.test(title) ? 'express' : 'standard',
      method: title || (pickup ? 'Store pickup' : ''),
      state: (n.shippingAddress && n.shippingAddress.provinceCode) || (n.billingAddress && n.billingAddress.provinceCode) || '',
      note: n.note || '',
      // only customer-facing attributes (gift messages, delivery instructions) — the rest are
      // tracking ids from apps (bct, _heatVid, cart-id, seller-id, Channel …) and don't belong on a slip
      attrs: (n.customAttributes || [])
        .filter(a => a.value && !String(a.key).startsWith('_') && /gift|message|note|instruction|deliver/i.test(a.key))
        .map(a => [a.key, a.value]),
      hold: fos.includes('ON_HOLD'),
      pickupReady: pickup && fos.includes('IN_PROGRESS'),
      shipTo: addr(n.shippingAddress), billTo: addr(n.billingAddress),
      lines: (n.lineItems.nodes || [])
        .filter(l => l.requiresShipping !== false && (l.unfulfilledQuantity || 0) > 0)
        .map(l => ({ sku: l.sku || '', qty: l.unfulfilledQuantity, desc: l.title || '', vt: l.variantTitle || '',
                     tagCls: tagCls(l.product && l.product.tags) })),
      so: null, ifDone: false,
    };
  });

  // 2. NetSuite — sales order + fulfilment status per order
  const refs = orders.map(o => '#' + o.no);
  const soRows = refs.length ? await inChunks(refs, 150, list =>
    `SELECT so.id AS id, so.tranid AS tranid, so.otherrefnum AS ref FROM transaction so
     WHERE so.recordtype='salesorder' AND so.otherrefnum IN (${list}) ORDER BY so.id`) : [];
  const doneRows = refs.length ? await inChunks(refs, 150, list =>
    `SELECT DISTINCT so.otherrefnum AS ref FROM transaction so WHERE so.recordtype='salesorder'
     AND so.otherrefnum IN (${list}) AND EXISTS (SELECT 1 FROM nexttransactionlinelink l
     JOIN transaction iff ON iff.id=l.nextdoc WHERE l.previousdoc=so.id AND iff.recordtype='itemfulfillment')`) : [];
  const soByRef = new Map();
  for (const r of soRows) if (!soByRef.has(String(r.ref).trim())) soByRef.set(String(r.ref).trim(), { id: String(r.id), tranid: r.tranid || '' });
  const doneSet = new Set(doneRows.map(r => String(r.ref).trim()));
  for (const o of orders) { o.so = soByRef.get('#' + o.no) || null; o.ifDone = doneSet.has('#' + o.no); }

  // 3. NetSuite — Loc 2 bins + item parent/class for every SKU still to pick
  const skus = [...new Set(orders.flatMap(o => o.lines.map(l => l.sku)).filter(Boolean))];
  const itemRows = skus.length ? await inChunks(skus, 150, list =>
    `SELECT i.itemid AS sku, BUILTIN.DF(i.parent) AS parent, BUILTIN.DF(i.class) AS cls, i.isinactive AS inactive
     FROM item i WHERE i.itemid IN (${list}) ORDER BY i.id`) : [];
  const binRows = skus.length ? await inChunks(skus, 150, list =>
    `SELECT i.itemid AS sku, BUILTIN.DF(ibq.bin) AS bin, ibq.onhand AS onhand
     FROM itembinquantity ibq JOIN item i ON i.id = ibq.item JOIN bin b ON b.id = ibq.bin
     WHERE b.location = 2 AND b.isinactive = 'F' AND ibq.onhand > 0 AND i.itemid IN (${list})
     ORDER BY ibq.item, ibq.bin`) : [];

  const meta = new Map();                     // prefer the active record when a SKU exists twice
  for (const r of itemRows) {
    const cur = meta.get(r.sku);
    if (!cur || (cur.inactive === 'T' && r.inactive !== 'T')) meta.set(r.sku, r);
  }
  const binsBySku = new Map();                // duplicate item records → add their stock together
  for (const r of binRows) {
    if (!binsBySku.has(r.sku)) binsBySku.set(r.sku, new Map());
    const m = binsBySku.get(r.sku);
    m.set(r.bin, (m.get(r.bin) || 0) + Number(r.onhand || 0));
  }
  const bins = {};
  for (const [sku, m] of binsBySku) bins[sku] = [...m].map(([bin, q]) => [bin, q]);

  for (const o of orders) {
    o.lines = o.lines.map(l => {
      const m = meta.get(l.sku) || {};
      const parent = m.parent || l.sku;
      return { sku: l.sku, qty: l.qty, desc: l.desc, size: sizeOf(l.sku, m.parent, l.vt),
               cls: nsCls(m.cls) || l.tagCls, parent };
    });
  }

  const pool = { v: 1, asOf: melbourneNow(), orders, bins };

  // 4. encrypt + write (and optional plaintext for local debugging)
  const enc = await encryptJSON(pool, KEY);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, enc);
  const plainText = JSON.stringify(pool);
  if (PLAIN) fs.writeFileSync(path.resolve(PLAIN), plainText);

  // 5. optional: no-PII wave progress into the public seed
  let waveNote = '';
  if (WAVES && SEED) {
    let index = { waves: [] };
    try { index = JSON.parse(fs.readFileSync(path.resolve(WAVES), 'utf8')); } catch (e) { /* no register yet */ }
    const seedPath = path.resolve(SEED);
    const text = fs.readFileSync(seedPath, 'utf8');
    const header = text.startsWith('/*') ? text.slice(0, text.indexOf('*/') + 2) + '\n' : '';
    global.window = {};
    new Function('window', text)(global.window);
    const s = global.window.SEED;
    s.waves = PickLib.waveSummary(index, pool, pool.asOf);
    fs.writeFileSync(seedPath, header + 'window.SEED = ' + JSON.stringify(s) + ';\n');
    waveNote = ` waves=${s.waves.length}`;
  }

  const count = f => orders.filter(f).length;
  console.log(`pick-fetch OK: orders=${orders.length} (standard ${count(o => o.type === 'standard')}, express ${count(o => o.type === 'express')}, pickup ${count(o => o.type === 'pickup')}) ` +
    `lines=${orders.reduce((n, o) => n + o.lines.length, 0)} skus=${skus.length} binRows=${binRows.length} ` +
    `notInNS=${count(o => !o.so)} ifDone=${count(o => o.ifDone)} hold=${count(o => o.hold)} pickupReady=${count(o => o.pickupReady)} ` +
    `plain=${(plainText.length / 1024).toFixed(1)}KB enc=${(enc.length / 1024).toFixed(1)}KB${waveNote} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error('pick-fetch ERROR: ' + e.message); process.exit(1); });
