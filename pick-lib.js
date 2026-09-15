/* pick-lib.js — pick-wave logic shared by pick-fetch.js (node), the tests and picks.html (browser).
   Pure functions, no I/O. Node: require('./pick-lib'). Browser: window.PickLib.

   Shapes
     pool   decrypted pick pool  {asOf, orders:[order], bins:{sku:[[bin, onhand], …]}}
     order  {no, at, type:'standard'|'express'|'pickup', method, state, so:{id,tranid}|null, ifDone,
             hold, pickupReady, shipTo, billTo, note, attrs, lines:[{sku, qty, desc, size, cls, parent}]}
     index  waves/index.json     {v, waves:[{id, createdAt, zone, filters, sort, count, units,
                                   orders:[{no, lines:[[sku, bin, qty], …]}], releasedAt}]}
     Z      compileZones(zones.json)

   Rules (see Pick Waves/PLAN.md §3)
     - walk order = zone order in zones.json, then every dash-separated part of the bin compared
       as numbers where numeric (A-002-01-010 after A-002-01-002, A-010 before A-100)
     - bin stock available to a new wave = NetSuite on-hand − units reserved by open waves for
       orders still open and not yet item-fulfilled (a fulfilment drops on-hand and releases the
       reservation in the same pool snapshot, so nothing is counted twice)
     - orders are allocated oldest first; an order that can't be fully covered takes nothing
     - per order: anchor = the zone that can fully cover the most lines; each line takes bins in
       the anchor zone first, then the nearest zones, then walk order; within a tier one bin that
       covers the whole qty beats splitting; lastResort zones (Sales Floor bin) only when nothing
       else has it
     - an order belongs to the zone of its first stop */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PickLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SEP = '\u0000';
  const DAY = 864e5;
  const ALL = '*', ALL_LABEL = 'All zones';   // builder zone value meaning "every ready order"

  // ------------------------------------------------------------------ zones + walk order

  function compileZones(cfg) {
    const zones = ((cfg && cfg.zones) || []).map((z, idx) => ({
      idx, id: z.id, label: z.label || z.id,
      prefix: z.prefix ? String(z.prefix).trim().toUpperCase() : null,
      bays: Array.isArray(z.bays) ? z.bays : null,
      bins: new Set((z.bins || []).map(b => String(b).trim().toUpperCase())),
      catchAll: !!z.catchAll, lastResort: !!z.lastResort,
    }));
    return {
      zones,
      byId: new Map(zones.map(z => [z.id, z])),
      exclude: new Set(((cfg && cfg.exclude) || []).map(b => String(b).trim().toUpperCase())),
      cache: new Map(),
    };
  }

  const parts = bin => String(bin).toUpperCase().split('-').map(t => t.trim()).filter(Boolean);

  function zoneOf(bin, Z) {
    const name = String(bin == null ? '' : bin).trim().toUpperCase();
    if (!name) return null;
    if (Z.cache.has(name)) return Z.cache.get(name);
    let hit = null;
    if (!Z.exclude.has(name)) {
      hit = Z.zones.find(z => z.bins.has(name)) || null;
      if (!hit) {
        const p = parts(name), bay = parseInt(p[1], 10);
        hit = Z.zones.find(z => z.prefix && z.prefix === p[0] &&
          (!z.bays || (bay >= z.bays[0] && bay <= z.bays[1]))) || null;
      }
      if (!hit) hit = Z.zones.find(z => z.catchAll) || null;
    }
    Z.cache.set(name, hit);
    return hit;
  }

  function walkKey(bin, Z) {
    const z = zoneOf(bin, Z);
    return String(z ? z.idx : 99).padStart(2, '0') + '|' +
      parts(bin).map(t => (/^\d+$/.test(t) ? t.padStart(6, '0') : t)).join('|');
  }

  const cmpKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

  // ------------------------------------------------------------------ reservations + stock

  const openWaves = index => ((index && index.waves) || []).filter(w => !w.releasedAt);

  // units held by open waves, and which wave holds each order
  function reservations(index, pool) {
    const live = new Map(((pool && pool.orders) || []).map(o => [o.no, o]));
    const res = new Map(), locked = new Map();
    for (const w of openWaves(index)) {
      for (const wo of w.orders || []) {
        const o = live.get(wo.no);
        if (!o || o.ifDone) continue;            // shipped, cancelled or fulfilled → released
        locked.set(wo.no, w.id);
        for (const [sku, bin, qty] of wo.lines || []) {
          const k = sku + SEP + bin;
          res.set(k, (res.get(k) || 0) + qty);
        }
      }
    }
    return { res, locked };
  }

  // sku → pickable bins with units left, lastResort last then walk order
  function stockMap(pool, Z, res) {
    const m = new Map();
    for (const [sku, rows] of Object.entries((pool && pool.bins) || {})) {
      const list = [];
      for (const [bin, onhand] of rows) {
        const z = zoneOf(bin, Z);
        if (!z) continue;
        const left = Number(onhand) - ((res && res.get(sku + SEP + bin)) || 0);
        if (left > 0) list.push({ bin, left, z, key: walkKey(bin, Z) });
      }
      list.sort((a, b) => (a.z.lastResort - b.z.lastResort) || cmpKey(a, b));
      m.set(sku, list);
    }
    return m;
  }

  // ------------------------------------------------------------------ allocation

  function allocate(order, stock) {
    const lines = (order.lines || []).filter(l => (l.qty || 0) > 0);

    const cover = new Map();                     // zone idx → lines it can fully cover
    for (const l of lines) {
      const byZone = new Map();
      for (const s of stock.get(l.sku) || []) {
        if (!s.z.lastResort) byZone.set(s.z.idx, (byZone.get(s.z.idx) || 0) + s.left);
      }
      for (const [zi, q] of byZone) if (q >= l.qty) cover.set(zi, (cover.get(zi) || 0) + 1);
    }
    let anchor = null;
    for (const [zi, n] of cover) {
      const best = anchor === null ? -1 : cover.get(anchor);
      if (n > best || (n === best && zi < anchor)) anchor = zi;
    }
    const rank = s => (s.z.lastResort ? 1e6 : 0) + (anchor === null ? 0 : Math.abs(s.z.idx - anchor));

    const taken = [], stops = [], short = [];
    for (const l of lines) {
      const cands = (l.sku && stock.get(l.sku)) || [];
      const have = cands.reduce((n, s) => n + s.left, 0);
      if (!l.sku || have < l.qty) {
        short.push({ sku: l.sku || '(no SKU)', need: l.qty, have });
        continue;
      }
      let need = l.qty;
      const used = new Set(), first = stops.length;
      while (need > 0) {
        const open = cands.filter(s => s.left > 0);
        const r0 = Math.min.apply(null, open.map(rank));
        const tier = open.filter(s => rank(s) === r0).sort(cmpKey);
        const s = tier.find(x => x.left >= need) || tier[0];
        const q = Math.min(need, s.left);
        s.left -= q; need -= q;
        taken.push([s, q]); used.add(s);
        stops.push({
          bin: s.bin, qty: q, sku: l.sku, desc: l.desc || '', size: l.size || '', cls: l.cls || 'oth',
          parent: l.parent || '', zone: s.z.id, zoneLabel: s.z.label, lastResort: s.z.lastResort,
          backup: '', key: s.key,
        });
      }
      const spare = cands.filter(s => !used.has(s) && s.left > 0)
        .sort((a, b) => rank(a) - rank(b) || cmpKey(a, b))[0];
      if (spare) for (let i = first; i < stops.length; i++) stops[i].backup = spare.bin;
    }

    if (short.length) {
      for (const [s, q] of taken) s.left += q;  // take nothing
      return { stops: [], short };
    }
    stops.sort((a, b) => cmpKey(a, b) || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
    return { stops, short };
  }

  function derive(o, stops) {
    const units = o.lines.reduce((n, l) => n + (l.qty || 0), 0);
    const classes = [...new Set(o.lines.map(l => l.cls || 'oth'))];
    const zones = [];
    for (const s of stops) if (!zones.includes(s.zone)) zones.push(s.zone);
    return {
      units, cls: classes.length === 1 ? classes[0] : 'mixed', stops, zone: zones[0], zones,
      firstKey: stops[0].key, firstSku: stops[0].sku, lastResort: stops.some(s => s.lastResort),
    };
  }

  const byAge = (a, b) => (Date.parse(a.at) - Date.parse(b.at)) ||
    String(a.no).localeCompare(String(b.no), undefined, { numeric: true });

  // every order in the pool → ready (allocated) / waved / exceptions / done
  function planOrders(pool, index, Z) {
    const { res, locked } = reservations(index, pool);
    const stock = stockMap(pool, Z, res);
    const out = { ready: [], waved: [], exceptions: [], done: [] };
    for (const o of ((pool && pool.orders) || []).slice().sort(byAge)) {
      if (o.ifDone) { out.done.push(o); continue; }
      if (locked.has(o.no)) { out.waved.push(Object.assign({}, o, { wave: locked.get(o.no) })); continue; }
      const why = !o.so ? 'Not in NetSuite yet'
        : o.hold ? 'On hold in Shopify'
        : o.pickupReady ? 'Pickup already marked ready'
        : !(o.lines && o.lines.length) ? 'Nothing left to pick'
        : null;
      if (why) { out.exceptions.push(Object.assign({}, o, { reason: why })); continue; }
      const a = allocate(o, stock);
      if (a.short.length) {
        out.exceptions.push(Object.assign({}, o, {
          reason: 'Short: ' + a.short.map(s => `${s.sku} needs ${s.need}, ${s.have} in bins`).join('; '),
          short: a.short,
        }));
        continue;
      }
      out.ready.push(Object.assign({}, o, derive(o, a.stops)));
    }
    return out;
  }

  // ------------------------------------------------------------------ filter + sort

  const unitBucket = u => (u <= 1 ? '1' : u <= 3 ? '2-3' : '4+');
  const has = (arr, v) => !arr || !arr.length || arr.includes(v);

  function filterOrders(ready, f) {
    f = f || {};
    const to = f.dateTo ? Date.parse(f.dateTo) : null;
    const sku = f.sku ? String(f.sku).trim().toUpperCase() : '';
    return ready.filter(o =>
      (!f.zone || f.zone === ALL || o.zone === f.zone) &&
      (to === null || Date.parse(o.at) <= to) &&
      has(f.ship, o.type) &&
      has(f.states, o.state || '') &&
      has(f.cls, o.cls) &&
      has(f.units, unitBucket(o.units)) &&
      (!sku || o.stops.some(s => String(s.sku).toUpperCase().includes(sku))));
  }

  const SORTS = {
    stop:    o => o.firstKey,
    date:    o => Date.parse(o.at),
    express: o => (o.type === 'express' ? 0 : 1),
    pickup:  o => (o.type === 'pickup' ? 0 : 1),
    state:   o => o.state || '~',
    sku:     o => o.firstSku || '',
    class:   o => o.cls || '',
    qty:     o => o.units,
  };
  const SORT_LABELS = {
    stop: 'First bin (walk order)', date: 'Order date', express: 'Express first', pickup: 'Pickups first',
    state: 'State', sku: 'SKU', class: 'Class', qty: 'Units',
  };

  function sortOrders(list, keys) {
    const ks = (keys || []).filter(k => SORTS[k.key]).concat([{ key: 'stop' }, { key: 'date' }]);
    return list.slice().sort((a, b) => {
      for (const k of ks) {
        const x = SORTS[k.key](a), y = SORTS[k.key](b);
        if (x === y) continue;
        const c = x < y ? -1 : 1;
        return k.dir === 'desc' ? -c : c;
      }
      return String(a.no).localeCompare(String(b.no), undefined, { numeric: true });
    });
  }

  function selectWave(ready, opts) {
    opts = opts || {};
    const list = sortOrders(filterOrders(ready, Object.assign({}, opts.filters, { zone: opts.zone })), opts.sort);
    return opts.max ? list.slice(0, opts.max) : list;
  }

  // ------------------------------------------------------------------ waves

  const melDay = d => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

  function nextWaveId(index, now) {
    const pre = 'W-' + melDay(now ? new Date(now) : new Date()).replace(/-/g, '').slice(2) + '-';
    const n = ((index && index.waves) || [])
      .filter(w => String(w.id).startsWith(pre))
      .reduce((m, w) => Math.max(m, parseInt(String(w.id).slice(pre.length), 10) || 0), 0);
    return pre + String(n + 1).padStart(2, '0');
  }

  // record → waves/index.json (no PII) · slips → encrypted waves/<id>.enc
  function buildWave(list, opts) {
    const z = opts.Z && opts.Z.byId.get(opts.zone);
    const zoneLabel = opts.zone === ALL ? ALL_LABEL : z ? z.label : opts.zone;
    const units = list.reduce((n, o) => n + o.units, 0);
    const record = {
      id: opts.id, createdAt: opts.createdAt, zone: opts.zone, zoneLabel,
      filters: opts.filters || {}, sort: opts.sort || [], poolAsOf: opts.poolAsOf || null,
      count: list.length, units,
      orders: list.map(o => ({ no: o.no, lines: o.stops.map(s => [s.sku, s.bin, s.qty]) })),
      releasedAt: null,
    };
    const slips = {
      v: 1, id: opts.id, zone: opts.zone, zoneLabel, createdAt: opts.createdAt, count: list.length, units,
      orders: list.map((o, i) => ({
        seq: i + 1, no: o.no, at: o.at, type: o.type, method: o.method || '',
        so: o.so ? o.so.tranid : '', state: o.state || '',
        shipTo: o.shipTo || null, billTo: o.billTo || null, note: o.note || '', attrs: o.attrs || [],
        units: o.units, cls: o.cls, zones: o.zones, stops: o.stops,
      })),
    };
    return { record, slips };
  }

  // re-validate a saved wave against a fresh pool before printing
  function recheck(slips, pool, index) {
    const live = new Map(((pool && pool.orders) || []).map(o => [o.no, o]));
    const others = { waves: ((index && index.waves) || []).filter(w => w.id !== slips.id) };
    const { res } = reservations(others, pool);
    const onhand = new Map();
    for (const [sku, rows] of Object.entries((pool && pool.bins) || {})) {
      for (const [bin, q] of rows) onhand.set(sku + SEP + bin, (onhand.get(sku + SEP + bin) || 0) + Number(q));
    }

    const keep = [], dropped = [];
    for (const o of slips.orders) {
      const l = live.get(o.no);
      if (!l) { dropped.push({ no: o.no, reason: 'No longer open in Shopify (shipped, cancelled or archived)' }); continue; }
      if (l.ifDone) { dropped.push({ no: o.no, reason: 'Already fulfilled in NetSuite' }); continue; }
      const want = new Map(), got = new Map();
      for (const x of l.lines || []) want.set(x.sku, (want.get(x.sku) || 0) + x.qty);
      for (const s of o.stops) got.set(s.sku, (got.get(s.sku) || 0) + s.qty);
      const same = want.size === got.size && [...want].every(([k, v]) => got.get(k) === v);
      if (!same) { dropped.push({ no: o.no, reason: 'Order changed since the wave was saved — release and re-wave' }); continue; }
      keep.push(o);
    }

    const need = new Map();
    for (const o of keep) for (const s of o.stops) {
      const k = s.sku + SEP + s.bin;
      need.set(k, (need.get(k) || 0) + s.qty);
    }
    const orders = keep.map(o => Object.assign({}, o, {
      stops: o.stops.map(s => {
        const k = s.sku + SEP + s.bin;
        return Object.assign({}, s, { check: (onhand.get(k) || 0) - (res.get(k) || 0) < need.get(k) });
      }),
    }));
    return { orders, dropped };
  }

  // no-PII progress for the public seed and the waves list
  function waveSummary(index, pool, now, keepDays) {
    const live = new Map(((pool && pool.orders) || []).map(o => [o.no, o]));
    const t = now ? Date.parse(now) : Date.now();
    const keep = (keepDays || 14) * DAY;
    return ((index && index.waves) || [])
      .filter(w => t - Date.parse(w.createdAt) < keep)
      .map(w => {
        const nos = (w.orders || []).map(o => o.no);
        const done = nos.filter(n => { const o = live.get(n); return !o || o.ifDone; }).length;
        const state = w.releasedAt ? 'released'
          : done === nos.length ? 'done'
          : t - Date.parse(w.createdAt) > 2 * DAY ? 'stale'
          : 'open';
        return { id: w.id, zone: w.zone, zoneLabel: w.zoneLabel || w.zone, createdAt: w.createdAt,
                 orders: nos.length, units: w.units || 0, done, state };
      });
  }

  return {
    compileZones, zoneOf, walkKey, reservations, stockMap, allocate, planOrders,
    filterOrders, sortOrders, selectWave, SORT_LABELS, unitBucket, ALL, ALL_LABEL,
    nextWaveId, buildWave, recheck, waveSummary,
  };
});
