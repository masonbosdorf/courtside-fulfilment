/* netsuite-fetch.js — pulls ALL NetSuite-derived fields via direct TBA (headless-reliable)
   and writes them into fulfilment-seed.js, overwriting whatever the Haiku/MCP run left.
   Shopify fields (ordersIn, deltaIn, pickupPending, orders feed) are left untouched.
   Usage: node netsuite-fetch.js <seed.js> <unf_orders.json> <TODAY_NS> <MONTH_START_NS> <LW_NS> <NOW_HM> <WEEK_START_NS>
   Dates are MM/DD/YYYY (NetSuite format); NOW_HM is HH:MM (Melbourne). WEEK_START_NS = this week's Monday. */
const { suiteql } = require('./netsuite');
const fs = require('fs');

const [,, seedPath, unfOrdersPath, TODAY_NS, MONTH_START_NS, LW_NS, NOW_HM, WEEK_START_NS] = process.argv;

// ---- name normalisation (same map as build-leaderboards.js) ----
const MAP = {
  gav:'Gav', gavin:'Gav', chris:'Chris', izzy:'Izzy', harper:'Harper',
  court:'Courtney', courtney:'Courtney', matt:'Matt', brennan:'Brennan',
  nikki:'Nikki', caitlin:'Caitlin', jemima:'Jemima', manny:'Manny',
  james:'James', stella:'Stella', ella:'Ella', mason:'Mason',
  aaron:'Aaron', marcus:'Marcus', noah:'Noah'
};
function norm(rows){
  const m = {};
  for (const r of rows){
    let n = (r && r.name != null ? String(r.name) : '').trim();
    const k = n.toLowerCase();
    if (!n || k === 'null' || k === 'unknown' || k === 'n/a') continue;
    const canon = MAP[k] || (n[0].toUpperCase() + n.slice(1).toLowerCase());
    m[canon] = (m[canon] || 0) + Number((r && r.orders) || 0);
  }
  return Object.entries(m).map(([name, orders]) => ({ name, orders })).sort((a, b) => b.orders - a.orders);
}
function top(arr){ if (!arr.length) return null; const a = arr[0], b = arr[1] || { name:'—', orders:0 }; return { name:a.name, orders:a.orders, ahead:a.orders - b.orders, next:b.name }; }
const IF = "recordtype='itemfulfillment'";
const num = (rows, f) => (rows.length && rows[0][f] != null ? Number(rows[0][f]) : 0);

async function main(){
  // 1. fulfilled today (trandate) + same-day-last-week at same elapsed time (createddate-capped)
  const fulfilled = num(await suiteql(
    `SELECT COUNT(DISTINCT id) AS n FROM transaction WHERE ${IF} AND trandate = TO_DATE('${TODAY_NS}','MM/DD/YYYY')`), 'n');
  const lw = num(await suiteql(
    `SELECT COUNT(DISTINCT id) AS n FROM transaction WHERE ${IF} AND trandate = TO_DATE('${LW_NS}','MM/DD/YYYY') AND createddate < TO_TIMESTAMP('${LW_NS} ${NOW_HM}:00','MM/DD/YYYY HH24:MI:SS')`), 'n');
  const deltaOut = fulfilled - lw;

  // 2. today pickers / packers (trandate = today)
  const tPick = await suiteql(`SELECT custbody_ps_picker AS name, COUNT(DISTINCT id) AS orders FROM transaction WHERE ${IF} AND trandate = TO_DATE('${TODAY_NS}','MM/DD/YYYY') GROUP BY custbody_ps_picker`);
  const tPack = await suiteql(`SELECT custbody_ps_packer AS name, COUNT(DISTINCT id) AS orders FROM transaction WHERE ${IF} AND trandate = TO_DATE('${TODAY_NS}','MM/DD/YYYY') GROUP BY custbody_ps_packer`);

  // 3. MTD pickers / packers (trandate month-start..today)
  const mPick = await suiteql(`SELECT custbody_ps_picker AS name, COUNT(DISTINCT id) AS orders FROM transaction WHERE ${IF} AND trandate BETWEEN TO_DATE('${MONTH_START_NS}','MM/DD/YYYY') AND TO_DATE('${TODAY_NS}','MM/DD/YYYY') GROUP BY custbody_ps_picker`);
  const mPack = await suiteql(`SELECT custbody_ps_packer AS name, COUNT(DISTINCT id) AS orders FROM transaction WHERE ${IF} AND trandate BETWEEN TO_DATE('${MONTH_START_NS}','MM/DD/YYYY') AND TO_DATE('${TODAY_NS}','MM/DD/YYYY') GROUP BY custbody_ps_packer`);

  // 3b. this-week pickers / packers (trandate Mon..today) — for the week split charts
  const WEEK_START = WEEK_START_NS || TODAY_NS;
  const wPick = await suiteql(`SELECT custbody_ps_picker AS name, COUNT(DISTINCT id) AS orders FROM transaction WHERE ${IF} AND trandate BETWEEN TO_DATE('${WEEK_START}','MM/DD/YYYY') AND TO_DATE('${TODAY_NS}','MM/DD/YYYY') GROUP BY custbody_ps_picker`);
  const wPack = await suiteql(`SELECT custbody_ps_packer AS name, COUNT(DISTINCT id) AS orders FROM transaction WHERE ${IF} AND trandate BETWEEN TO_DATE('${WEEK_START}','MM/DD/YYYY') AND TO_DATE('${TODAY_NS}','MM/DD/YYYY') GROUP BY custbody_ps_packer`);

  // 3c. units fulfilled today = sum of physical item quantities on today's fulfilments
  // (exclude shipping/tax/discount/service lines so e.g. a "shipping" line doesn't count as a unit)
  const unitsOut = num(await suiteql(
    `SELECT SUM(ABS(tl.quantity)) AS u FROM transaction t JOIN transactionline tl ON tl.transaction = t.id WHERE ${IF.replace(/recordtype/g,'t.recordtype')} AND t.trandate = TO_DATE('${TODAY_NS}','MM/DD/YYYY') AND tl.mainline = 'F' AND tl.quantity IS NOT NULL AND tl.itemtype NOT IN ('ShipItem','TaxItem','DiscItem','SubtotalItem','Markup','Payment','Group','EndGroup')`), 'u');

  // 4. avg fulfilment time SO->IF this month (days)
  let avgDays = null;
  try {
    const avgHours = num(await suiteql(
      `SELECT AVG(hrs) AS avg_hours FROM (SELECT DISTINCT iff.id, (TO_DATE(TO_CHAR(iff.createddate,'YYYY-MM-DD HH24:MI:SS'),'YYYY-MM-DD HH24:MI:SS') - TO_DATE(TO_CHAR(so.createddate,'YYYY-MM-DD HH24:MI:SS'),'YYYY-MM-DD HH24:MI:SS'))*24 AS hrs FROM transaction iff JOIN nexttransactionlinelink l ON l.nextdoc=iff.id JOIN transaction so ON so.id=l.previousdoc WHERE iff.recordtype='itemfulfillment' AND so.recordtype='salesorder' AND iff.trandate >= TO_DATE('${MONTH_START_NS}','MM/DD/YYYY'))`), 'avg_hours');
    if (avgHours) avgDays = Math.round(avgHours / 24 * 10) / 10;
  } catch (e) { /* keep existing */ }

  // 5. unfulfilled cross-check: Shopify unshipped list MINUS those that have an IF (= done)
  // unfulfilled: FROZEN (temporary). The Shopify order list saved by the Haiku/MCP step is
  // unreliable — it has truncated at 250 and even saved partial 5-item lists, which makes the
  // cross-check produce wrong-low numbers. So we do NOT recompute unfulfilled here; it keeps
  // whatever's in the seed (set correctly by hand). RE-ENABLE the block below once Shopify is
  // on an Admin API token (deterministic full-list pagination), by setting env UNFULFILLED_LIVE=1.
  let unfulfilled = null, unfulfilledUnits = null, unfulfilledByDate = null; // null = leave seed's existing values
  if (process.env.UNFULFILLED_LIVE === '1') {
    try {
      const raw = JSON.parse(fs.readFileSync(unfOrdersPath, 'utf8'));
      const rows = (Array.isArray(raw) ? raw : []).map(o => ({
        ref: (o && o.name != null ? String(o.name) : String(o)).trim().replace(/^#?/, '#'),
        units: Number((o && o.units) || 0),
        createdAt: o && o.createdAt,
        t: (o && o.t) || 'standard',
      })).filter(r => r.ref && r.ref !== '#');
      if (rows.length) {
        const inClause = rows.map(r => "'" + r.ref.replace(/'/g, '') + "'").join(',');
        // return the SOs (with an IF) that ARE done — subtract these (and their units) from the backlog
        const doneRows = await suiteql(
          `SELECT DISTINCT so.otherrefnum AS ref FROM transaction so WHERE so.recordtype='salesorder' AND so.otherrefnum IN (${inClause}) AND EXISTS (SELECT 1 FROM nexttransactionlinelink l JOIN transaction iff ON iff.id=l.nextdoc WHERE l.previousdoc=so.id AND iff.recordtype='itemfulfillment')`);
        const doneSet = new Set(doneRows.map(d => String(d.ref || '').trim()));
        // exclude orders that are DONE (have an IF) OR older than 14 days (dead/stuck — not real backlog)
        const CUTOFF_MS = Date.now() - 14 * 24 * 60 * 60 * 1000;
        const open = rows.filter(r => !doneSet.has(r.ref) && r.createdAt && new Date(r.createdAt).getTime() >= CUTOFF_MS);
        const shipOpen = open.filter(r => r.t !== 'pickup');   // headline = shipping queue only
        unfulfilled = shipOpen.length;
        unfulfilledUnits = shipOpen.reduce((a, r) => a + r.units, 0);

        // group the OPEN subset by Melbourne order date (oldest first) for the date-breakdown view
        const keyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }); // YYYY-MM-DD
        const lblFmt = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'long', day: 'numeric', month: 'long' });   // Monday 15 June
        const byDate = {};
        for (const r of open) {
          if (!r.createdAt) continue;
          const d = new Date(r.createdAt); if (isNaN(d)) continue;
          const key = keyFmt.format(d);
          if (!byDate[key]) byDate[key] = { key, label: lblFmt.format(d), orders: 0, units: 0, nos: [] };
          byDate[key].orders++; byDate[key].units += r.units;
          if (r.ref) byDate[key].nos.push({ n: r.ref.replace(/^#/, ''), t: r.t || 'standard' }); // {number, type}
        }
        unfulfilledByDate = Object.values(byDate).sort((a, b) => a.key.localeCompare(b.key));
        for (const g of unfulfilledByDate) g.nos.sort((a, b) => (parseInt(a.n, 10) || 0) - (parseInt(b.n, 10) || 0)); // order numbers ascending
      }
    } catch (e) { /* keep existing */ }
  }

  // ---- write into the seed (overwrite NetSuite fields only) ----
  global.window = {};
  require(seedPath);
  const s = global.window.SEED;
  s.today.fulfilled = fulfilled;
  s.today.deltaOut  = deltaOut;
  s.today.unitsOut  = unitsOut;
  s.today.pickers   = norm(tPick);
  s.today.packers   = norm(tPack);
  const mp = norm(mPick), mk = norm(mPack);
  if (top(mp)) s.month.topPicker = top(mp);
  if (top(mk)) s.month.topPacker = top(mk);
  s.month.pickers = mp.slice(0, 12);
  s.week = s.week || {};
  s.week.pickers = norm(wPick).slice(0, 12);
  s.week.packers = norm(wPack).slice(0, 12);
  if (avgDays != null) s.avgDays = avgDays;
  if (unfulfilled != null) s.unfulfilled = unfulfilled;
  if (unfulfilledUnits != null) s.unfulfilledUnits = unfulfilledUnits;
  if (unfulfilledByDate != null) s.unfulfilledByDate = unfulfilledByDate;

  const header = '/* fulfilment-seed.js — DATA ONLY. Shopify via Haiku/MCP; NetSuite via direct TBA (netsuite-fetch.js). */\n';
  fs.writeFileSync(seedPath, header + 'window.SEED = ' + JSON.stringify(s) + ';\n');
  console.log(`netsuite-fetch OK: fulfilled=${fulfilled} (Δ${deltaOut}) unitsOut=${unitsOut} avgDays=${avgDays} unfulfilled=${unfulfilled} unfUnits=${unfulfilledUnits} wkPickers=${s.week.pickers.length} topPicker=${(top(mp)||{}).name} topPacker=${(top(mk)||{}).name}`);
}
main().catch(e => { console.error('netsuite-fetch ERROR: ' + e.message); process.exit(1); });
