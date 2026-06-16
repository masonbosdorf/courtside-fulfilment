/* gh-compute-dates.js — prints the Melbourne date vars the fetchers need, as KEY=VALUE lines
   (for GitHub Actions `>> $GITHUB_ENV`). Pure node/Intl so it's portable (no macOS `date -v`). */
const TZ = 'Australia/Melbourne';
const now = new Date();

function melParts(d) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });   // h23 → midnight is "00" not "24"
  const o = {}; for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return o; // {year,month,day,hour,minute}
}
function melOffset(d) { // "+10:00" / "+11:00"
  const s = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
    .formatToParts(d).find(x => x.type === 'timeZoneName').value;       // "GMT+10:00"
  return s.replace('GMT', '') || '+10:00';
}
function melWeekday(d) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d);
  return { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 }[wd];      // 0..6
}
const p = melParts(now);
// anchor at UTC-noon on the Melbourne calendar day → safe to subtract whole days across DST
const anchor = new Date(Date.UTC(+p.year, +p.month - 1, +p.day, 12, 0, 0));
const ns  = dt => `${String(dt.getUTCMonth()+1).padStart(2,'0')}/${String(dt.getUTCDate()).padStart(2,'0')}/${dt.getUTCFullYear()}`;
const iso = dt => `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;

const lw  = new Date(anchor); lw.setUTCDate(lw.getUTCDate() - 7);                 // same weekday last week
const back = (melWeekday(now) === 0 ? 6 : melWeekday(now) - 1);                   // days since Monday
const mon = new Date(anchor); mon.setUTCDate(mon.getUTCDate() - back);            // this week's Monday

const out = {
  TODAY_NS:       `${p.month}/${p.day}/${p.year}`,
  TODAY_ISO:      `${p.year}-${p.month}-${p.day}`,
  MONTH_START_NS: `${p.month}/01/${p.year}`,
  LW_NS:          ns(lw),
  LW_ISO:         iso(lw),
  WEEK_START_NS:  ns(mon),
  NOW_HM:         `${p.hour}:${p.minute}`,
  SHOP_OFFSET:    melOffset(now),
};
for (const k in out) console.log(`${k}=${out[k]}`);
