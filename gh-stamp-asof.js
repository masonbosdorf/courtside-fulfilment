/* gh-stamp-asof.js — stamps seed.asOf to "now" in Melbourne local time (DST-safe offset),
   matching what the laptop wrapper's perl step does. Run after the fetchers, before commit.
   Usage: node gh-stamp-asof.js [seed.js path]  (default ./fulfilment-seed.js) */
const fs   = require('fs');
const path = require('path');
const TZ   = 'Australia/Melbourne';
const seedPath = path.resolve(process.argv[2] || 'fulfilment-seed.js');

global.window = {};
require(seedPath);
const s = global.window.SEED;
if (!s) { console.error('stamp-asof: no SEED'); process.exit(1); }

const now = new Date();
// hourCycle:'h23' is REQUIRED — en-CA/en-GB with hour12:false renders midnight as "24:00" (invalid ISO).
const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const o = {}; for (const p of f.formatToParts(now)) o[p.type] = p.value;
const off = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
  .formatToParts(now).find(x => x.type === 'timeZoneName').value.replace('GMT', '') || '+10:00';

s.asOf = `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}:${o.second}${off}`;
const header = '/* fulfilment-seed.js — DATA ONLY. Refreshed by GitHub Actions (cloud sync). */\n';
fs.writeFileSync(seedPath, header + 'window.SEED = ' + JSON.stringify(s) + ';\n');
console.log('asOf', s.asOf);
