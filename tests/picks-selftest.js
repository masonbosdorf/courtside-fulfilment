/* picks-selftest.js — end-to-end run of picks.html against a LocalStore + the synthetic dev pool.
   Loaded only by picks.html?dev=1&selftest=1. Writes results to <pre id="selftest"> and sets
   document.title to SELFTEST:PASS / SELFTEST:FAIL. Never runs against GitHub. */
(async () => {
  const results = [];
  const ok = (name, cond, detail) => results.push({ name, ok: !!cond, detail: detail == null ? '' : String(detail) });
  const A = window.App, S = A.S, L = A.PickLib;
  const opts = (zone, max, extra) => Object.assign({ zone, filters: {}, sort: [{ key: 'stop' }], max }, extra || {});
  try {
    await A.load();
    ok('pool decrypts and plans', S.pool.orders.length > 0 && S.plan, `${S.pool.orders.length} orders · ready ${S.plan.ready.length} · exceptions ${S.plan.exceptions.length} · done ${S.plan.done.length}`);
    ok('exceptions carry reasons', S.plan.exceptions.every(o => o.reason), S.plan.exceptions.map(o => o.reason.split(':')[0]).join(' | '));

    const byZone = {};
    for (const o of S.plan.ready) (byZone[o.zone] = byZone[o.zone] || []).push(o.no);
    const zone = Object.keys(byZone).sort((a, b) => byZone[b].length - byZone[a].length)[0];
    const zoneOrders = byZone[zone].slice();
    ok('busiest zone has 3+ ready orders', zoneOrders.length >= 3, `${zone}: ${zoneOrders.length}`);

    // builder UI renders a preview for that zone
    A.openBuilder(zone);
    await new Promise(r => setTimeout(r, 50));
    const sum = document.getElementById('b-sum');
    ok('builder preview renders', sum && /\d+ orders?/.test(sum.textContent), sum && sum.textContent.trim());
    const rows = document.querySelectorAll('#b-list tbody tr').length;
    ok('preview lists the capped selection', rows === Math.min(zoneOrders.length, 40), `${rows} rows`);
    A.closeBuilder();

    // two waves back to back in the same zone
    const w1 = await A.saveWave(opts(zone, 2));
    const w2 = await A.saveWave(opts(zone, 500));
    const n1 = w1.record.orders.map(o => o.no), n2 = w2.record.orders.map(o => o.no);
    ok('wave 1 took 2 orders', n1.length === 2, `${w1.record.id}: ${n1.join(', ')}`);
    ok('wave 2 took the rest of the zone', n2.length === zoneOrders.length - 2, `${w2.record.id}: ${n2.length}`);
    ok('no order is in both waves', !n1.some(n => n2.includes(n)));
    ok('wave ids count up', w2.record.id > w1.record.id, `${w1.record.id} → ${w2.record.id}`);
    ok('register holds both waves', S.index.waves.length === 2);
    ok('waved orders left the ready list', !S.plan.ready.some(o => n1.includes(o.no) || n2.includes(o.no)));
    const held = [...L.reservations(S.index, S.pool).res.values()].reduce((a, b) => a + b, 0);
    ok('bin holds equal the waved units', held === w1.record.units + w2.record.units, `${held} units held`);
    const walk = w2.record.orders.map(o => L.walkKey(o.lines[0][1], S.Z));
    ok('slips come out in walk order', walk.every((k, i) => i === 0 || walk[i - 1] <= k));
    ok('register has no customer data', !/Test Customer|Sample Street/.test(JSON.stringify(S.index)));

    // print + reprint
    const p1 = await A.printWave(w1.record.id, { capture: true });
    ok('print: one page per 1–5 line order', p1.slips === 2 && p1.pages === 2, `${p1.pages} pages · ${p1.slips} slips · ${p1.fileName}`);
    const p1b = await A.printWave(w1.record.id, { capture: true });
    ok('reprint matches', p1b.pages === p1.pages && p1b.slips === p1.slips && p1b.dropped.length === 0);
    const p2 = await A.printWave(w2.record.id, { capture: true });
    ok('print wave 2', p2.slips === n2.length && p2.pages >= p2.slips, `${p2.pages} pages · ${p2.slips} slips`);

    // release
    await A.releaseWave(w1.record.id, { noConfirm: true });
    ok('release stamps the wave', !!S.index.waves.find(w => w.id === w1.record.id).releasedAt);
    ok('released orders are ready again', n1.every(n => S.plan.ready.some(o => o.no === n)));
    ok('wave list shows released', L.waveSummary(S.index, S.pool).find(x => x.id === w1.record.id).state === 'released');

    // race: another device registers a wave (taking one of our orders) between our read and our write
    const realPut = S.store.putIndex;
    let injected = false;
    S.store.putIndex = async (index, sha, msg) => {
      if (!injected) {
        injected = true;
        const cur = await S.store.getIndex();
        const other = { id: 'W-OTHER-01', createdAt: new Date().toISOString(), zone, zoneLabel: zone, count: 1, units: 1,
          orders: [{ no: n1[0], lines: [] }], releasedAt: null };
        await realPut(Object.assign({}, cur.index, { waves: cur.index.waves.concat(other) }), cur.sha, 'other device');
      }
      return realPut(index, sha, msg);
    };
    const w3 = await A.saveWave(opts(zone, 500));
    S.store.putIndex = realPut;
    const n3 = w3.record.orders.map(o => o.no);
    ok('race: the order the other device took is not in our wave', injected && !n3.includes(n1[0]), n3.join(', '));
    ok('race: our wave still saved with what was left', n3.length === 1 && n3[0] === n1[1]);
    ok('race: register keeps both devices\' waves', S.index.waves.some(w => w.id === 'W-OTHER-01') && S.index.waves.some(w => w.id === w3.record.id));

    // nothing left in that zone → a clear error, nothing written
    const before = S.index.waves.length;
    let emptyErr = null;
    try { await A.saveWave(opts(zone, 500)); } catch (e) { emptyErr = e; }
    ok('empty selection is refused', emptyErr && /No orders match/.test(emptyErr.message) && S.index.waves.length === before, emptyErr && emptyErr.message);

    // a filtered wave: express only, anywhere
    const exp = S.plan.ready.filter(o => o.type === 'express');
    if (exp.length) {
      const z = exp[0].zone;
      const w4 = await A.saveWave(opts(z, 500, { filters: { ship: ['express'] } }));
      ok('filter: express-only wave has only express orders', w4.record.orders.every(o => S.pool.orders.find(x => x.no === o.no).type === 'express'), `${w4.record.id}: ${w4.record.count}`);
    }

    A.renderApp();
    ok('waves panel lists every wave', document.querySelectorAll('#waves .wrow').length === S.index.waves.length, `${document.querySelectorAll('#waves .wrow').length} rows`);
  } catch (e) {
    ok('self-test crashed', false, e && (e.stack || e.message || e));
  }
  const pass = results.every(r => r.ok);
  const pre = document.getElementById('selftest') || document.body.appendChild(Object.assign(document.createElement('pre'), { id: 'selftest', hidden: true }));
  pre.textContent = JSON.stringify({ pass, results }, null, 1);
  document.title = 'SELFTEST:' + (pass ? 'PASS' : 'FAIL');
})();
