const SHOP = process.env.SHOP_DOMAIN;
const API = `https://${SHOP}/admin/api/2026-07/graphql.json`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let TOKEN;

async function getToken() {
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Token failed: " + JSON.stringify(j));
  TOKEN = j.access_token;
}

async function gql(query, variables = {}) {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json();
    if (r.status === 429 || j.errors?.some((e) => e.extensions?.code === "THROTTLED")) {
      await sleep(4000);
      continue;
    }
    if (j.errors) throw new Error(JSON.stringify(j.errors));
    return j.data;
  }
  throw new Error("Throttled too long");
}

const ORDERS = `query($q:String!,$after:String){
  orders(first:15, after:$after, query:$q){
    pageInfo{hasNextPage endCursor}
    nodes{ id cancelledAt test
      lineItems(first:20){ pageInfo{hasNextPage endCursor} nodes{ quantity product{ id } } }
    }
  }
}`;
const MORE = `query($id:ID!,$after:String){
  order(id:$id){ lineItems(first:50, after:$after){ pageInfo{hasNextPage endCursor} nodes{ quantity product{ id } } } }
}`;
const PRODUCTS = `query($after:String){
  products(first:100, after:$after){
    pageInfo{hasNextPage endCursor}
    nodes{ id metafield(namespace:"custom", key:"sold_7d"){ value } }
  }
}`;
const SET = `mutation($m:[MetafieldsSetInput!]!){
  metafieldsSet(metafields:$m){ userErrors{ field message } }
}`;

await getToken();

// 1) Count sold quantity per product (last 7 days, rolling)
const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
const sold = new Map();
const add = (items) => {
  for (const li of items) {
    if (li.product) sold.set(li.product.id, (sold.get(li.product.id) || 0) + li.quantity);
  }
};

let after = null, orderCount = 0;
do {
  const d = await gql(ORDERS, { q: `created_at:>='${since}'`, after });
  for (const o of d.orders.nodes) {
    if (o.cancelledAt || o.test) continue;
    orderCount++;
    add(o.lineItems.nodes);
    let p = o.lineItems.pageInfo;
    while (p.hasNextPage) {
      const m = await gql(MORE, { id: o.id, after: p.endCursor });
      add(m.order.lineItems.nodes);
      p = m.order.lineItems.pageInfo;
    }
  }
  after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
} while (after);
console.log(`Orders counted: ${orderCount}, products with sales: ${sold.size}`);

// 2) Compare with current metafields (zero-sale products reset to 0)
const changes = [];
after = null;
let total = 0;
do {
  const d = await gql(PRODUCTS, { after });
  for (const p of d.products.nodes) {
    total++;
    const next = String(sold.get(p.id) || 0);
    const current = p.metafield?.value ?? null;
    if (current !== next) {
      changes.push({
        ownerId: p.id,
        namespace: "custom",
        key: "sold_7d",
        type: "number_integer",
        value: next,
      });
    }
  }
  after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
} while (after);

// 3) Write in batches of 25
for (let i = 0; i < changes.length; i += 25) {
  const d = await gql(SET, { m: changes.slice(i, i + 25) });
  const errs = d.metafieldsSet.userErrors;
  if (errs.length) throw new Error(JSON.stringify(errs));
}
console.log(`Products checked: ${total}, updated: ${changes.length}`);
