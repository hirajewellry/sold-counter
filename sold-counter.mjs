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
    nodes{ id createdAt cancelledAt test
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
    nodes{ id
      m7: metafield(namespace:"custom", key:"sold_7d"){ value }
      m6: metafield(namespace:"custom", key:"sold_6m"){ value }
    }
  }
}`;
const SET = `mutation($m:[MetafieldsSetInput!]!){
  metafieldsSet(metafields:$m){ userErrors{ field message } }
}`;

await getToken();

const DAY = 24 * 3600 * 1000;
const since7 = Date.now() - 7 * DAY;
const since6m = new Date(Date.now() - 182 * DAY).toISOString();
const sold7 = new Map();
const sold6 = new Map();

const add = (items, isRecent) => {
  for (const li of items) {
    if (!li.product) continue;
    const id = li.product.id;
    sold6.set(id, (sold6.get(id) || 0) + li.quantity);
    if (isRecent) sold7.set(id, (sold7.get(id) || 0) + li.quantity);
  }
};

let after = null, orderCount = 0, oldest = null;
do {
  const d = await gql(ORDERS, { q: `created_at:>='${since6m}'`, after });
  for (const o of d.orders.nodes) {
    if (o.cancelledAt || o.test) continue;
    orderCount++;
    if (!oldest || o.createdAt < oldest) oldest = o.createdAt;
    const recent = new Date(o.createdAt).getTime() >= since7;
    add(o.lineItems.nodes, recent);
    let p = o.lineItems.pageInfo;
    while (p.hasNextPage) {
      const m = await gql(MORE, { id: o.id, after: p.endCursor });
      add(m.order.lineItems.nodes, recent);
      p = m.order.lineItems.pageInfo;
    }
  }
  after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
} while (after);
console.log(`Orders counted: ${orderCount}, products sold (6m): ${sold6.size}, (7d): ${sold7.size}`);
console.log(`Oldest order read: ${oldest}`);

const changes = [];
after = null;
let total = 0;
do {
  const d = await gql(PRODUCTS, { after });
  for (const p of d.products.nodes) {
    total++;
    const n7 = String(sold7.get(p.id) || 0);
    const n6 = String(sold6.get(p.id) || 0);
    if ((p.m7?.value ?? null) !== n7)
      changes.push({ ownerId: p.id, namespace: "custom", key: "sold_7d", type: "number_integer", value: n7 });
    if ((p.m6?.value ?? null) !== n6)
      changes.push({ ownerId: p.id, namespace: "custom", key: "sold_6m", type: "number_integer", value: n6 });
  }
  after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
} while (after);

for (let i = 0; i < changes.length; i += 25) {
  const d = await gql(SET, { m: changes.slice(i, i + 25) });
  const errs = d.metafieldsSet.userErrors;
  if (errs.length) throw new Error(JSON.stringify(errs));
}
console.log(`Products checked: ${total}, values updated: ${changes.length}`);
