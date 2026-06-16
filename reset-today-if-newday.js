/* reset-today-if-newday.js — runs at the start of each sync, BEFORE the Haiku refresh.
   If the seed's last data (asOf) is from a previous Melbourne day, it blanks today's
   NetSuite-derived fields (fulfilled / deltaOut / pickers / packers). That way, if the
   headless run can't reach NetSuite, "fulfilled today" shows 0 (honest) instead of
   yesterday's number lingering. A successful run overwrites these with today's real data.
   Usage: node reset-today-if-newday.js <seed.js path> */
const fs = require('fs');
const seedPath = process.argv[2];

function melDay(d){
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

global.window = {};
try { require(seedPath); } catch (e) { console.log('reset: seed unreadable, skip'); process.exit(0); }
const s = global.window.SEED;
if (!s || !s.asOf || !s.today) { console.log('reset: no seed/asOf, skip'); process.exit(0); }

const seedDate = new Date(s.asOf);
if (isNaN(seedDate.getTime())) {        // bad/garbage asOf — never crash; let the fetchers run + restamp it
  console.log('reset: asOf invalid (' + s.asOf + ') — skipping reset, fetchers will repopulate'); process.exit(0);
}
const today   = melDay(new Date());
const seedDay = melDay(seedDate);
if (today === seedDay) { console.log('reset: same day (' + today + '), no reset'); process.exit(0); }

s.today.fulfilled = 0;
s.today.deltaOut  = 0;
s.today.unitsOut  = 0;
s.today.pickers   = [];
s.today.packers   = [];
s.today.ordersIn  = 0;   // Shopify daily fields too (blanked until the fresh fetch writes them)
s.today.deltaIn   = 0;
s.today.unitsIn   = 0;

const header =
  '/* fulfilment-seed.js — DATA ONLY. Rewritten every 15 min by the fulfilment sync task.\n' +
  '   today.* NetSuite fields blanked at day-rollover by reset-today-if-newday.js. */\n';
fs.writeFileSync(seedPath, header + 'window.SEED = ' + JSON.stringify(s) + ';\n');
console.log('reset: new day (' + seedDay + ' -> ' + today + ') — today NetSuite fields blanked');
