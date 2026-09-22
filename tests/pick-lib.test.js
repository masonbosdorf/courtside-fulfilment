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

test('customer names: first or last name, company, accents, blank query', () => {
  const o = order('1', [['X', 1]], { shipTo: { name: 'Yuhe Chen' }, billTo: { name: 'Zoë Ng', company: 'Hoops Pty Ltd' } });
  assert.equal(L.custName(o), 'Yuhe Chen');
  for (const q of ['YUHE', 'yuhe', 'chen', 'Chen Yuhe', 'yu', 'zoe', 'ZOE NG', 'hoops', 'ltd'])
    assert.equal(L.matchCustomer(o, q), true, `should match ${q}`);
  for (const q of ['yuhi', 'chenx', 'smith', 'yuhe smith'])
    assert.equal(L.matchCustomer(o, q), false, `should not match ${q}`);
  assert.equal(L.matchCustomer(o, '   '), true);                 // blank = no filter
  assert.equal(L.custName(order('2', [['X', 1]], { shipTo: null, billTo: null })), '');
  assert.equal(L.custName(order('3', [['X', 1]], { shipTo: { name: '', company: 'Hoops' }, billTo: null })), 'Hoops');
});

test('customer filter narrows a wave to matching names', () => {
  const bins = { X: [['A-001-01', 9]] };
  const ready = L.planOrders(pool([
    order('1', [['X', 1]], { shipTo: { name: 'Yuhe Chen' } }),
    order('2', [['X', 1]], { shipTo: { name: 'Mason Bosdorf' } }),
    order('3', [['X', 1]], { shipTo: { name: 'Chen Wei' } }),
  ], bins), null, Z).ready;
  assert.deepEqual(L.selectWave(ready, { zone: 'A1', filters: { cust: 'chen' } }).map(o => o.no), ['1', '3']);
  assert.deepEqual(L.selectWave(ready, { zone: 'A1', filters: { cust: 'yuhe' } }).map(o => o.no), ['1']);
  assert.deepEqual(L.selectWave(ready, { zone: 'A1', filters: { cust: '' } }).map(o => o.no), ['1', '2', '3']);
  assert.deepEqual(L.selectWave(ready, { zone: 'A1', filters: { cust: 'nobody' } }), []);
});

test('wave name and picker: trimmed, capped, and still no customer data in the register', () => {
  const ready = L.planOrders(pool([order('1', [['X', 1]], { shipTo: { name: 'Yuhe Chen' } })], { X: [['A-001-01', 1]] }), null, Z).ready;
  const base = { zone: 'A1', createdAt: '2026-09-16T03:00:00Z', Z };
  const { record, slips } = L.buildWave(ready, Object.assign({}, base, { id: 'W-260916-01', name: '  Morning   run  ', picker: '  Nick  ' }));
  assert.equal(record.name, 'Morning run');
  assert.equal(record.picker, 'Nick');
  assert.equal(slips.name, 'Morning run');
  assert.equal(slips.picker, 'Nick');
  assert.equal(JSON.stringify(record).includes('Yuhe'), false);       // public register stays PII-free
  assert.equal(slips.orders[0].shipTo.name, 'Yuhe Chen');             // encrypted slips still carry it

  const long = L.buildWave(ready, Object.assign({}, base, { id: 'W-2', name: 'y'.repeat(80), picker: 'p'.repeat(60) }));
  assert.equal(long.record.name.length, L.MAX_NAME);
  assert.equal(long.record.picker.length, L.MAX_PICKER);

  const none = L.buildWave(ready, Object.assign({}, base, { id: 'W-3' }));
  assert.equal(none.record.name, '');
  assert.equal(none.record.picker, '');
});

test('waveSummary carries name and picker, blank for waves saved before the feature', () => {
  const p = pool([order('1', [['X', 1]])], {});
  const s = L.waveSummary({ waves: [
    { id: 'W-260916-01', name: 'Express first', picker: 'Nick', zone: 'A1', zoneLabel: 'A-001–025',
      createdAt: '2026-09-16T03:00:00Z', units: 1, orders: [{ no: '1', lines: [] }], releasedAt: null },
    { id: 'W-260916-02', zone: 'A2', createdAt: '2026-09-16T03:00:00Z', units: 1,
      orders: [{ no: '1', lines: [] }], releasedAt: null },
  ] }, p, '2026-09-16T04:00:00Z');
  assert.deepEqual(s.map(x => [x.id, x.name, x.picker]), [['W-260916-01', 'Express first', 'Nick'], ['W-260916-02', '', '']]);
});

test('waveSummary reports archived waves, and the public seed leaves them out', () => {
  const p = pool([order('1', [['X', 1]])], {});
  const w = (id, archivedAt) => ({ id, zone: 'A1', createdAt: '2026-09-16T03:00:00Z', units: 1,
    orders: [{ no: '1', lines: [] }], releasedAt: '2026-09-16T03:30:00Z', archivedAt: archivedAt || null });
  const s = L.waveSummary({ waves: [w('W-1'), w('W-2', '2026-09-16T04:00:00Z')] }, p, '2026-09-16T05:00:00Z');
  assert.deepEqual(s.map(x => [x.id, x.archived]), [['W-1', false], ['W-2', true]]);
  assert.equal(s[1].archivedAt, '2026-09-16T04:00:00Z');
  assert.equal(s[0].archivedAt, null);
  // pick-fetch.js writes exactly this into the public seed
  assert.deepEqual(s.filter(x => !x.archived).map(x => x.id), ['W-1']);
  // a longer window is how the archived view reaches older waves
  const old = { waves: [w('W-OLD', '2026-09-16T04:00:00Z')] };
  old.waves[0].createdAt = '2026-01-01T03:00:00Z';
  assert.equal(L.waveSummary(old, p, '2026-09-16T05:00:00Z').length, 0);
  assert.equal(L.waveSummary(old, p, '2026-09-16T05:00:00Z', 3650).length, 1);
});

test('searchOrders finds an order by name or number and says where it is', () => {
  const bins = { X: [['A-001-01', 9]] };
  const orders = [
    order('55084', [['X', 1]], { shipTo: { name: 'Yuhe Chen' } }),
    order('55085', [['X', 1]], { shipTo: { name: 'Mason Bosdorf' } }),
    order('55086', [['X', 1]], { shipTo: { name: 'Chen Wei' }, so: null }),
    order('55087', [['X', 1]], { shipTo: { name: 'Anna Chen' }, ifDone: true }),
  ];
  const index = { waves: [{ id: 'W-260916-01', name: 'Morning run', picker: 'Nick',
    createdAt: '2026-09-16T03:00:00Z', units: 1,
    orders: [{ no: '55085', lines: [['X', 'A-001-01', 1]] }], releasedAt: null }] };
  const plan = L.planOrders(pool(orders, bins), index, Z);

  const rows = L.searchOrders(plan, 'chen', index);
  assert.deepEqual(rows.map(r => [r.no, r.status]), [['55084', 'ready'], ['55086', 'exception'], ['55087', 'done']]);
  assert.equal(rows[0].cust, 'Yuhe Chen');
  assert.equal(rows[1].reason, 'Not in NetSuite yet');

  const mason = L.searchOrders(plan, 'mason', index)[0];
  assert.deepEqual([mason.status, mason.wave, mason.waveName, mason.picker], ['waved', 'W-260916-01', 'Morning run', 'Nick']);

  assert.deepEqual(L.searchOrders(plan, '#55084', index).map(r => r.no), ['55084']);
  assert.deepEqual(L.searchOrders(plan, '5508', index).map(r => r.no).sort(), ['55084', '55085', '55086', '55087']);
  assert.deepEqual(L.searchOrders(plan, '', index), []);
  assert.deepEqual(L.searchOrders(plan, '  ', index), []);
  assert.deepEqual(L.searchOrders(null, 'chen', index), []);
});

test('customer query: comma-separated include, and "-" to exclude', () => {
  const bins = { X: [['A-001-01', 9]] };
  const ready = L.planOrders(pool([
    order('1', [['X', 1]], { shipTo: { name: 'Jake Stone' } }),
    order('2', [['X', 1]], { shipTo: { name: 'Yuhe Wang' } }),
    order('3', [['X', 1]], { shipTo: { name: 'Anna Chen' } }),
    order('4', [['X', 1]], { shipTo: { name: 'Jake Morrison' } }),
  ], bins), null, Z).ready;
  const pickNos = cust => L.selectWave(ready, { zone: 'A1', filters: { cust } }).map(o => o.no);

  // include: either name, and both Jakes come along
  assert.deepEqual(pickNos('Jake, Yuhe'), ['1', '2', '4']);
  assert.deepEqual(pickNos('jake,yuhe'), ['1', '2', '4']);          // spacing and case are free
  assert.deepEqual(pickNos('Yuhe'), ['2']);

  // exclude: everyone but those
  assert.deepEqual(pickNos('-jake, -yuhe'), ['3']);
  assert.deepEqual(pickNos('-jake'), ['2', '3']);

  // mixed — this is the case Mason asked for: "Yuhe, Mason, -jake"
  assert.deepEqual(pickNos('Jake, -Stone'), ['4']);
  assert.deepEqual(pickNos('Jake, Yuhe, -wang'), ['1', '4']);

  // a multi-word term still needs every word
  assert.deepEqual(pickNos('jake stone'), ['1']);
  assert.deepEqual(pickNos('jake stone, yuhe'), ['1', '2']);

  // degenerate input filters nothing rather than everything
  for (const q of ['', '  ', ',', ' , , ', '-', '- , -']) assert.deepEqual(pickNos(q), ['1', '2', '3', '4'], JSON.stringify(q));

  const p = L.parseCustomerQuery('Jake, -yuhe wang');
  assert.deepEqual(p.inc, [['jake']]);
  assert.deepEqual(p.exc, [['yuhe', 'wang']]);
});

test('waveDetail labels every order, and recheck is the same answer filtered', () => {
  const orders = [order('1', [['X', 1]]), order('2', [['Y', 1]]), order('3', [['Z', 1]]), order('4', [['Q', 2]])];
  const bins = { X: [['A-001-01', 5]], Y: [['A-002-01', 5]], Z: [['A-003-01', 5]], Q: [['A-004-01', 2]] };
  const ready = L.planOrders(pool(orders, bins), null, Z).ready;
  const { record, slips } = L.buildWave(ready, { id: 'W-1', zone: 'A1', createdAt: '2026-09-15T03:00:00Z', Z });
  const index = { waves: [record] };

  const later = pool([
    orders[0],                                          // unchanged → open
    Object.assign({}, orders[1], { ifDone: true }),     // fulfilled
    Object.assign({}, orders[3], {}),                   // still open
  ], Object.assign({}, bins, { Q: [['A-004-01', 1]] })); // a POS sale took one of Q's two units
  later.orders.push(Object.assign({}, orders[2], { lines: [{ sku: 'Z', qty: 2, cls: 'fw' }] }));  // edited

  const d = L.waveDetail(slips, later, index);
  assert.deepEqual(d.orders.map(o => [o.no, o.status]),
    [['1', 'open'], ['2', 'fulfilled'], ['3', 'changed'], ['4', 'open']]);
  assert.deepEqual([d.counts.total, d.counts.open, d.counts.fulfilled, d.counts.changed, d.counts.gone], [4, 2, 1, 1, 0]);
  assert.match(d.orders[1].reason, /fulfilled/);
  assert.match(d.orders[2].reason, /changed/);

  // the bin behind #4 lost a unit, so that stop is flagged to check; #1's is not
  assert.equal(d.orders[0].stops[0].check, false);
  assert.equal(d.orders[3].stops[0].check, true);
  assert.equal(d.counts.flagged, 1);
  assert.equal(d.orders[0].cust, 'Test');            // the detail view needs the customer

  const r = L.recheck(slips, later, index);
  assert.deepEqual(r.orders.map(o => o.no), ['1', '4']);
  assert.deepEqual(r.dropped.map(x => x.no), ['2', '3']);
  assert.equal(r.orders[1].stops[0].check, true);    // same flag through both paths
});

test('waveDetail: an order that has left Shopify is gone, not changed', () => {
  const orders = [order('1', [['X', 1]])];
  const bins = { X: [['A-001-01', 5]] };
  const ready = L.planOrders(pool(orders, bins), null, Z).ready;
  const { slips } = L.buildWave(ready, { id: 'W-2', zone: 'A1', createdAt: '2026-09-15T03:00:00Z', Z });
  const d = L.waveDetail(slips, pool([], bins), { waves: [] });
  assert.deepEqual(d.orders.map(o => o.status), ['gone']);
  assert.match(d.orders[0].reason, /No longer open in Shopify/);
  assert.equal(d.counts.gone, 1);
});
