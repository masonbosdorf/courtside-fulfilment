/* node --test tests/ — pick-lib + pick-crypto on fixtures (no network). */
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../pick-lib');
const { encryptJSON, decryptJSON } = require('../pick-crypto');
const Z = L.compileZones(require('../zones.json'));

let clock = Date.parse('2026-09-15T00:00:00Z');
const order = (no, lines, extra) => Object.assign({
  no, at: new Date(clock += 60000).toISOString(), type: 'standard', method: 'Standard', state: 'VIC',
  so: { id: '1', tranid: 'SO' + no }, ifDone: false, hold: false, pickupReady: false,
  shipTo: { name: 'Test' }, billTo: { name: 'Test' },
  lines: lines.map(([sku, qty, cls]) => ({ sku, qty, cls: cls || 'fw', desc: sku, size: '', parent: sku })),
}, extra || {});
const pool = (orders, bins) => ({ v: 1, asOf: '2026-09-15T12:00:00+10:00', orders, bins });
const binsOf = o => o.stops.map(s => `${s.bin}×${s.qty}`);

test('zoneOf maps every bin family from zones.json', () => {
  const z = b => (L.zoneOf(b, Z) || {}).id || null;
  assert.equal(z('A-001-01'), 'A1');
  assert.equal(z('A-025-04-012'), 'A1');
  assert.equal(z('A-026-01'), 'A2');
  assert.equal(z('A-100-02'), 'A4');
  assert.equal(z('A-183-02-029'), 'A7');
  assert.equal(z('B-003-02'), 'B');
  assert.equal(z('C - Warehouse'), 'C');
  assert.equal(z('D-020-04-048'), 'D');
  assert.equal(z('1F-02-033'), '1F');
  assert.equal(z('NE-13'), 'NE');
  assert.equal(z('SNEAKERLAB'), 'OTHER');
  assert.equal(z('LEBRON'), 'OTHER');
  assert.equal(z('Sales Floor'), 'SF');
  assert.equal(L.zoneOf('Sales Floor', Z).lastResort, true);
  assert.equal(z('RECEIVING'), null);
  assert.equal(z('QUAR'), null);
  assert.equal(z(''), null);
});

test('walk order: zone order, then numeric parts', () => {
  const bins = ['Sales Floor', 'D-001-01', 'A-100-01', 'A-002-01-010', 'NE-02', 'A-002-01-002', 'B-001-01', 'A-010-01', '1F-01-001', 'LEBRON'];
  const sorted = bins.slice().sort((a, b) => (L.walkKey(a, Z) < L.walkKey(b, Z) ? -1 : 1));
  assert.deepEqual(sorted, ['A-002-01-002', 'A-002-01-010', 'A-010-01', 'A-100-01', 'B-001-01', 'D-001-01', '1F-01-001', 'NE-02', 'LEBRON', 'Sales Floor']);
});

test('anchor zone keeps a multi-line order in one zone', () => {
  const p = pool([order('1', [['X', 1], ['Y', 1]])], { X: [['A-003-01', 1], ['D-005-01', 5]], Y: [['D-006-01', 2]] });
  const r = L.planOrders(p, null, Z).ready[0];
  assert.deepEqual(binsOf(r), ['D-005-01×1', 'D-006-01×1']);
  assert.equal(r.zone, 'D');
  assert.deepEqual(r.zones, ['D']);
});

test('one bin covering the qty beats splitting; the other bin becomes the backup', () => {
  const p = pool([order('1', [['Z', 2]])], { Z: [['A-001-01', 1], ['A-002-01', 3]] });
  const r = L.planOrders(p, null, Z).ready[0];
  assert.deepEqual(binsOf(r), ['A-002-01×2']);
  assert.equal(r.stops[0].backup, 'A-001-01');
});

test('splits across bins when no single bin covers the qty', () => {
  const p = pool([order('1', [['V', 3]])], { V: [['A-001-01', 1], ['A-004-01', 2]] });
  assert.deepEqual(binsOf(L.planOrders(p, null, Z).ready[0]), ['A-001-01×1', 'A-004-01×2']);
});

test('a short order takes nothing, so the next order still gets the stock', () => {
  const p = pool([order('1', [['W', 2]]), order('2', [['W', 1]])], { W: [['A-001-01', 1]] });
  const r = L.planOrders(p, null, Z);
  assert.equal(r.exceptions[0].no, '1');
  assert.match(r.exceptions[0].reason, /Short: W needs 2, 1 in bins/);
  assert.deepEqual(binsOf(r.ready[0]), ['A-001-01×1']);
});

test('oldest order wins the last unit', () => {
  const p = pool([order('1', [['U', 1]]), order('2', [['U', 1]])], { U: [['A-001-01', 1]] });
  const r = L.planOrders(p, null, Z);
  assert.deepEqual(r.ready.map(o => o.no), ['1']);
  assert.deepEqual(r.exceptions.map(o => o.no), ['2']);
});

test('open waves lock their orders and hold their units until fulfilled or released', () => {
  const o1 = order('1', [['T', 1]]), o2 = order('2', [['T', 1]]);
  const bins = { T: [['A-001-01', 1]] };
  const index = { waves: [{ id: 'W-260915-01', createdAt: '2026-09-15T01:00:00Z', orders: [{ no: '1', lines: [['T', 'A-001-01', 1]] }], releasedAt: null }] };

  let r = L.planOrders(pool([o1, o2], bins), index, Z);
  assert.deepEqual(r.waved.map(o => [o.no, o.wave]), [['1', 'W-260915-01']]);
  assert.equal(r.exceptions[0].no, '2');                     // its unit is held by the wave

  r = L.planOrders(pool([Object.assign({}, o1, { ifDone: true }), o2], bins), index, Z);
  assert.deepEqual(r.ready.map(o => o.no), ['2']);          // fulfilled → hold released

  r = L.planOrders(pool([o2], bins), index, Z);
  assert.deepEqual(r.ready.map(o => o.no), ['2']);          // shipped/cancelled → hold released

  const released = { waves: [Object.assign({}, index.waves[0], { releasedAt: '2026-09-15T02:00:00Z' })] };
  r = L.planOrders(pool([o1, o2], bins), released, Z);
  assert.deepEqual(r.waved, []);
  assert.deepEqual(r.ready.map(o => o.no), ['1']);
});

test('Sales Floor bin is only a last resort, and flagged', () => {
  const p = pool([order('1', [['S1', 1]]), order('2', [['S2', 1]])],
    { S1: [['Sales Floor', 3], ['A-050-01', 1]], S2: [['Sales Floor', 3]] });
  const r = L.planOrders(p, null, Z);
  assert.deepEqual(binsOf(r.ready[0]), ['A-050-01×1']);
  assert.equal(r.ready[0].lastResort, false);
  assert.deepEqual(binsOf(r.ready[1]), ['Sales Floor×1']);
  assert.equal(r.ready[1].zone, 'SF');
  assert.equal(r.ready[1].lastResort, true);
});

test('excluded bins are never picked from', () => {
  const p = pool([order('1', [['R', 1]])], { R: [['RECEIVING', 5]] });
  assert.equal(L.planOrders(p, null, Z).exceptions[0].reason, 'Short: R needs 1, 0 in bins');
});

test('exceptions: not in NetSuite, on hold, pickup already ready; fulfilled orders are done', () => {
  const bins = { K: [['A-001-01', 9]] };
  const r = L.planOrders(pool([
    order('1', [['K', 1]], { so: null }),
    order('2', [['K', 1]], { hold: true }),
    order('3', [['K', 1]], { type: 'pickup', pickupReady: true }),
    order('4', [['K', 1]], { ifDone: true }),
  ], bins), null, Z);
  assert.deepEqual(r.exceptions.map(o => o.reason), ['Not in NetSuite yet', 'On hold in Shopify', 'Pickup already marked ready']);
  assert.deepEqual(r.done.map(o => o.no), ['4']);
  assert.equal(r.ready.length, 0);
});

test('order class and units are derived', () => {
  const r = L.planOrders(pool([order('1', [['F', 1, 'fw'], ['G', 2, 'app']])], { F: [['A-001-01', 1]], G: [['A-002-01', 2]] }), null, Z).ready[0];
  assert.equal(r.units, 3);
  assert.equal(r.cls, 'mixed');
  assert.equal(L.unitBucket(r.units), '2-3');
});

test('filter by zone/ship/units and sort express first then walk order', () => {
  const bins = { P: [['A-010-01', 5]], Q: [['A-002-01', 5]], E: [['A-020-01', 5]], FAR: [['D-001-01', 5]] };
  const ready = L.planOrders(pool([
    order('s1', [['P', 1]]),
    order('s2', [['Q', 1]]),
    order('e1', [['E', 1]], { type: 'express' }),
    order('d1', [['FAR', 2]]),
  ], bins), null, Z).ready;

  assert.deepEqual(L.selectWave(ready, { zone: 'A1', sort: [{ key: 'express' }] }).map(o => o.no), ['e1', 's2', 's1']);
  assert.deepEqual(L.selectWave(ready, { zone: 'A1', filters: { ship: ['standard'] } }).map(o => o.no), ['s2', 's1']);
  assert.deepEqual(L.selectWave(ready, { zone: 'D', filters: { units: ['2-3'] } }).map(o => o.no), ['d1']);
  assert.deepEqual(L.selectWave(ready, { zone: 'A1', sort: [{ key: 'date', dir: 'desc' }], max: 2 }).map(o => o.no), ['e1', 's2']);
  assert.deepEqual(L.selectWave(ready, { filters: { sku: 'fa' } }).map(o => o.no), ['d1']);
});

test('All zones: every ready order, walk order across zones, labelled on the wave', () => {
  const bins = { P: [['A-010-01', 5]], Q: [['D-002-01', 5]], R: [['A-002-01', 5]], S: [['NE-03', 5]] };
  const ready = L.planOrders(pool([order('d', [['Q', 1]]), order('a10', [['P', 1]]), order('ne', [['S', 1]]), order('a2', [['R', 1]])], bins), null, Z).ready;
  const all = L.selectWave(ready, { zone: L.ALL });
  assert.deepEqual(all.map(o => o.no), ['a2', 'a10', 'd', 'ne']);
  assert.equal(L.selectWave(ready, { zone: L.ALL, max: 2 }).length, 2);
  assert.deepEqual(L.selectWave(ready, { zone: L.ALL, filters: { sku: 'Q' } }).map(o => o.no), ['d']);
  const { record, slips } = L.buildWave(all, { id: 'W-1', zone: L.ALL, createdAt: '2026-09-15T03:00:00Z', Z });
  assert.equal(record.zoneLabel, 'All zones');
  assert.equal(slips.zoneLabel, 'All zones');
  assert.equal(record.count, 4);
});

test('wave ids count up per Melbourne day', () => {
  const index = { waves: [{ id: 'W-260915-01' }, { id: 'W-260914-07' }] };
  assert.equal(L.nextWaveId(index, '2026-09-15T03:00:00Z'), 'W-260915-02');
  assert.equal(L.nextWaveId(index, '2026-09-14T15:30:00Z'), 'W-260915-02');   // 01:30 Melbourne
  assert.equal(L.nextWaveId(index, '2026-09-16T01:00:00Z'), 'W-260916-01');
  assert.equal(L.nextWaveId(null, '2026-09-16T01:00:00Z'), 'W-260916-01');
});

test('buildWave: register has no customer data; slips carry route + addresses', () => {
  const ready = L.planOrders(pool([order('1', [['X', 2]])], { X: [['A-001-01', 1], ['A-003-01', 1]] }), null, Z).ready;
  const { record, slips } = L.buildWave(ready, { id: 'W-260915-01', zone: 'A1', createdAt: '2026-09-15T03:00:00Z', Z });
  assert.deepEqual(record.orders, [{ no: '1', lines: [['X', 'A-001-01', 1], ['X', 'A-003-01', 1]] }]);
  assert.equal(record.zoneLabel, 'A-001–025');
  assert.equal(JSON.stringify(record).includes('Test'), false);
  assert.equal(slips.orders[0].seq, 1);
  assert.equal(slips.orders[0].shipTo.name, 'Test');
  assert.equal(slips.orders[0].so, 'SO1');
});

test('recheck drops shipped/fulfilled/edited orders and flags bins that no longer hold the units', () => {
  const orders = [order('1', [['X', 1]]), order('2', [['Y', 1]]), order('3', [['Z', 1]]), order('4', [['Q', 2]])];
  const bins = { X: [['A-001-01', 5]], Y: [['A-002-01', 5]], Z: [['A-003-01', 5]], Q: [['A-004-01', 2]] };
  const ready = L.planOrders(pool(orders, bins), null, Z).ready;
  const { record, slips } = L.buildWave(ready, { id: 'W-1', zone: 'A1', createdAt: '2026-09-15T03:00:00Z', Z });
  const index = { waves: [record] };

  const later = pool([
    orders[0],                                          // unchanged
    Object.assign({}, orders[1], { ifDone: true }),     // fulfilled
    Object.assign({}, orders[3], {}),                   // #3 gone (shipped/cancelled)
  ], Object.assign({}, bins, { Q: [['A-004-01', 1]] })); // a POS sale took one of Q's two units
  later.orders.push(Object.assign({}, orders[2], { lines: [{ sku: 'Z', qty: 2, cls: 'fw' }] }));  // #3 back but edited

  const r = L.recheck(slips, later, index);
  assert.deepEqual(r.orders.map(o => o.no), ['1', '4']);
  assert.deepEqual(r.dropped.map(d => d.no), ['2', '3']);
  assert.match(r.dropped[0].reason, /fulfilled/);
  assert.match(r.dropped[1].reason, /changed/);
  assert.equal(r.orders[0].stops[0].check, false);
  assert.equal(r.orders[1].stops[0].check, true);
});

test('waveSummary states', () => {
  const now = '2026-09-18T03:00:00Z';
  const p = pool([order('1', [['X', 1]]), order('2', [['X', 1]], { ifDone: true })], {});
  const w = (id, createdAt, nos, releasedAt) => ({ id, zone: 'A1', createdAt, units: nos.length, orders: nos.map(no => ({ no, lines: [] })), releasedAt: releasedAt || null });
  const s = L.waveSummary({ waves: [
    w('open', '2026-09-17T03:00:00Z', ['1', '2']),
    w('done', '2026-09-17T03:00:00Z', ['2', '9']),
    w('stale', '2026-09-14T03:00:00Z', ['1']),
    w('released', '2026-09-17T03:00:00Z', ['1'], '2026-09-17T04:00:00Z'),
    w('old', '2026-08-01T03:00:00Z', ['1']),
  ] }, p, now);
  assert.deepEqual(s.map(x => [x.id, x.state, x.done, x.orders]), [
    ['open', 'open', 1, 2], ['done', 'done', 2, 2], ['stale', 'stale', 0, 1], ['released', 'released', 0, 1]]);
});

test('crypto: round-trip, wrong passphrase rejected, nothing readable in the envelope', async () => {
  const secret = { orders: [{ shipTo: { name: 'Jane Citizen', a1: '12 Test Street' } }] };
  const enc = await encryptJSON(secret, 'correct horse battery staple');
  assert.equal(enc.includes('Jane'), false);
  assert.equal(enc.includes('Test Street'), false);
  assert.deepEqual(await decryptJSON(enc, 'correct horse battery staple'), secret);
  await assert.rejects(decryptJSON(enc, 'wrong'), /wrong passphrase/);
  const again = await encryptJSON(secret, 'correct horse battery staple');
  assert.notEqual(again, enc);                                  // fresh salt + IV every time
});
