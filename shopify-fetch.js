/* shopify-fetch.js — fetches ALL Shopify-derived fields directly (CCG token, full pagination)
   and writes them into fulfilment-seed.js. Replaces the old flaky Haiku/MCP step. NetSuite
   fields are left untouched (netsuite-fetch.js handles those right after).
   Also saves the COMPLETE unshipped-shipping order list to /tmp/unf_orders.json for the
   netsuite cross-check (no more 250-cap truncation).
   Usage: node shopify-fetch.js <seed.js> <TODAY_ISO> <LW_ISO> <NOW_HM> <OFFSET>
     dates YYYY-MM-DD (Melbourne), NOW_HM=HH:MM, OFFSET=+10:00 / +11:00 */
const { graphql } = require('./shopify');
const fs = require('fs');

const [,, seedPath, TODAY, LW, NOW_HM, OFFSET] = process.argv;
const titleCase = s => String(s || '').replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
const EXPRESS = /express|overnight|priorit|next[\s-]?day|expedit/i;   // shipping-method title → express

async function count(q) {
  const d = await graphql(`query($q:String!){ ordersCount(query:$q){ count } }`, { q });
  return d.ordersCount.count;
}

// paginate an orders query, returning all nodes (node shape decided by `selection`)
async function pageAll(q, selection, mapFn) {
  let after = null, out = [], more = true;
  while (more) {
    const d = await graphql(
      `query($q:String!,$a:String){ orders(first:250, after:$a, query:$q){ nodes{ ${selection} } pageInfo{ hasNextPage endCursor } } }`,
      { q, a: after });
    out.push(...d.orders.nodes.map(mapFn));
    more = d.orders.pageInfo.hasNextPage;
    after = d.orders.pageInfo.endCursor;
  }
  return out;
}

async function main() {
  const SHIP = 'financial_status:paid delivery_method:shipping';

  const unitsOf = n => (n.lineItems.nodes || []).reduce((a, b) => a + (b.quantity || 0), 0);

  // per-order detail carried through to the seed so the dashboard can expand an order number
  // into its lines (SKU / description / qty) + totals + shipping method. Keys are short on
  // purpose — this list is ~40 orders deep and ships inside fulfilment-seed.js.
  // FOOTWEAR / APPAREL / ACCESSORIES live as uppercase product tags in Shopify
  const CAT = tags => { const t = new Set((tags || []).map(x => String(x).toUpperCase()));
    return t.has('FOOTWEAR') ? 'fw' : t.has('APPAREL') ? 'app' : t.has('ACCESSORIES') ? 'acc' : 'oth'; };
  const detailOf = n => ({
    cust: (n.customer && n.customer.displayName) || (n.shippingAddress && n.shippingAddress.name) || '',
    value: Number((n.totalPriceSet && n.totalPriceSet.shopMoney && n.totalPriceSet.shopMoney.amount) || 0),
    ship: (n.shippingLine && n.shippingLine.title) || '',
    items: (n.lineItems.nodes || [])
      .filter(l => (l.quantity || 0) > 0)
      .map(l => ({ k: l.sku || '', d: l.title || '', q: l.quantity || 0,
                   g: CAT(l.product && l.product.tags) })),
  });
  const DETAIL_SEL = 'totalPriceSet{shopMoney{amount}} customer{displayName} shippingAddress{name} shippingLine{title}';
  const LINE_SEL   = 'lineItems(first:100){nodes{sku title quantity product{tags}}}';

  // 1. orders in today + same-day-last-week (same elapsed); plus today's total units
  const todayIn = await count(`${SHIP} created_at:>='${TODAY}T00:00:00${OFFSET}'`);
  const lwIn    = await count(`${SHIP} created_at:>='${LW}T00:00:00${OFFSET}' created_at:<'${LW}T${NOW_HM}:00${OFFSET}'`);
  const todayUnitsArr = await pageAll(
    `${SHIP} created_at:>='${TODAY}T00:00:00${OFFSET}'`,
    'lineItems(first:100){nodes{quantity}}', unitsOf);
  const unitsIn = todayUnitsArr.reduce((a, b) => a + b, 0);

  // 2. FULL unshipped-shipping backlog (paginated) — tagged express vs standard by shipping method
  const shipRows = await pageAll(
    'status:open financial_status:paid fulfillment_status:unshipped delivery_method:shipping',
    `name createdAt ${DETAIL_SEL} ${LINE_SEL}`,
    n => Object.assign({ name: n.name, units: unitsOf(n), createdAt: n.createdAt,
            t: EXPRESS.test((n.shippingLine && n.shippingLine.title) || '') ? 'express' : 'standard' },
            detailOf(n)));
  const unfulfilledUnits = shipRows.reduce((a, r) => a + r.units, 0);   // headline (screen 1) = shipping only

  // 3. store-pickup orders (unshipped) — tagged pickup; pickupPending = those not yet marked ready
  const pickupRows = await pageAll(
    'delivery_method:pick-up status:open financial_status:paid fulfillment_status:unshipped',
    `name createdAt ${DETAIL_SEL} ${LINE_SEL} fulfillmentOrders(first:5){ nodes{ status } }`,
    n => Object.assign({ name: n.name, units: unitsOf(n), createdAt: n.createdAt, t: 'pickup',
            ready: (n.fulfillmentOrders.nodes || []).some(f => f.status === 'IN_PROGRESS') },
            detailOf(n), { ship: (n.shippingLine && n.shippingLine.title) || 'Store pickup' }));
  const pickupPending = pickupRows.filter(r => !r.ready).length;

  // combined backlog for the date-breakdown cross-check (shipping + pickup, each with its type tag)
  const backlogRows = shipRows.concat(pickupRows.map(({ ready, ...r }) => r));
  const backlog = backlogRows.map(r => r.name);

  // 4. live-orders feed (10 most recent)
  // NOTE: customer{displayName} needs read_customers + protected-data access — omitted, so the
  // feed shows order # + value (no name). Add read_customers later to restore names.
  const fd = await graphql(`query{ orders(first:10, sortKey:CREATED_AT, reverse:true, query:"${SHIP}"){
    nodes{ name createdAt totalPriceSet{shopMoney{amount}} lineItems(first:100){nodes{quantity}} } } }`);
  const feed = fd.orders.nodes.map(o => ({
    name: '',
    no:   o.name.replace('#', ''),
    value: Number(o.totalPriceSet.shopMoney.amount),
    units: (o.lineItems.nodes || []).reduce((a, b) => a + (b.quantity || 0), 0),
    at:   o.createdAt,
  }));

  // save the complete backlog list (with per-order units) for netsuite-fetch's cross-check
  fs.writeFileSync('/tmp/unf_orders.json', JSON.stringify(backlogRows));

  // write Shopify fields into the seed (preserve NetSuite fields)
  global.window = {};
  require(seedPath);
  const s = global.window.SEED;
  s.today.ordersIn = todayIn;
  s.today.unitsIn  = unitsIn;
  s.today.deltaIn  = todayIn - lwIn;
  s.today.deltaLbl = 'vs same day last week';
  s.pickupPending  = pickupPending;
  s.unfulfilledUnits = unfulfilledUnits;
  s.orders = feed;
  const header = '/* fulfilment-seed.js — DATA ONLY. Shopify via CCG token (shopify-fetch.js); NetSuite via TBA (netsuite-fetch.js). */\n';
  fs.writeFileSync(seedPath, header + 'window.SEED = ' + JSON.stringify(s) + ';\n');

  console.log(`shopify-fetch OK: ordersIn=${todayIn} (Δ${todayIn - lwIn}) unitsIn=${unitsIn} backlog=${backlog.length} backlogUnits=${unfulfilledUnits} pickupPending=${pickupPending} feed=${feed.length}`);
}
main().catch(e => { console.error('shopify-fetch ERROR: ' + e.message); process.exit(1); });
