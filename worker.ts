import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { jwtVerify, createRemoteJWKSet, SignJWT } from "jose";
import { z } from "zod";

type Env = {
  ASSETS: { fetch: typeof fetch };
  DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  SESSION_SECRET: string;
  SHOPIFY_STORE_DOMAIN: string;
  SHOPIFY_STOREFRONT_TOKEN: string;
  SHOPIFY_ADMIN_TOKEN: string;
  CASHFREE_CLIENT_ID: string;
  CASHFREE_CLIENT_SECRET: string;
  CASHFREE_MODE?: string;
  SITE_URL: string;
};

const app = new Hono<{ Bindings: Env }>();
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

const session = async (c: any) => {
  const token = getCookie(c, "404_session");
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(c.env.SESSION_SECRET));
    return payload as any;
  } catch { return null; }
};

async function shopify(c: any, query: string, variables: Record<string, any> = {}, admin = false) {
  const base = `https://${c.env.SHOPIFY_STORE_DOMAIN}/admin/api/2026-07/graphql.json`;
  const url = admin ? base : `https://${c.env.SHOPIFY_STORE_DOMAIN}/api/2026-07/graphql.json`;
  const headers: Record<string,string> = { "content-type":"application/json" };
  headers[admin ? "X-Shopify-Access-Token" : "X-Shopify-Storefront-Access-Token"] = admin ? c.env.SHOPIFY_ADMIN_TOKEN : c.env.SHOPIFY_STOREFRONT_TOKEN;
  const r = await fetch(url, { method:"POST", headers, body:JSON.stringify({query, variables}) });
  const data = await r.json<any>();
  if (!r.ok || data.errors) throw new Error(data.errors?.[0]?.message || "Shopify request failed");
  return data.data;
}

const productsQuery = `query Products($first:Int!) {
  products(first:$first, sortKey:UPDATED_AT, reverse:true) {
    nodes {
      id handle title description
      featuredImage { url altText }
      variants(first:20) {
        nodes { id title availableForSale price { amount currencyCode } compareAtPrice { amount currencyCode } selectedOptions { name value } }
      }
    }
  }
}`;

app.get("/api/products", async c => {
  try {
    const data = await shopify(c, productsQuery, { first: 48 });
    const products = data.products.nodes.flatMap((p:any) =>
      p.variants.nodes.map((v:any) => ({
        id: p.id, handle:p.handle, title:p.title, description:p.description,
        image:p.featuredImage?.url, price:Number(v.price.amount), compareAtPrice:v.compareAtPrice ? Number(v.compareAtPrice.amount) : null,
        currency:v.price.currencyCode, available:v.availableForSale, variantId:v.id, options:v.selectedOptions
      }))
    );
    return c.json({ products });
  } catch (e:any) { return c.json({ products:[], error:e.message }, 500); }
});

app.get("/api/auth/me", async c => {
  const s = await session(c);
  return c.json({ user: s ? { sub:s.sub, email:s.email, name:s.name, picture:s.picture } : null });
});

app.post("/api/auth/google", async c => {
  try {
    const { credential } = await c.req.json();
    if (!credential) return c.json({ error:"Missing Google credential" },400);
    const { payload } = await jwtVerify(credential, googleKeys, { audience:c.env.GOOGLE_CLIENT_ID, issuer:["https://accounts.google.com","accounts.google.com"] });
    if (!payload.sub || !payload.email || payload.email_verified !== true) return c.json({ error:"Google account could not be verified" },401);
    const user = { sub:payload.sub, email:payload.email, name:String(payload.name || payload.email.split("@")[0]), picture:String(payload.picture || "") };
    await c.env.DB.prepare("INSERT INTO users (google_sub,email,name,picture) VALUES (?,?,?,?) ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email,name=excluded.name,picture=excluded.picture").bind(user.sub,user.email,user.name,user.picture).run();
    const token = await new SignJWT(user).setProtectedHeader({alg:"HS256"}).setIssuedAt().setExpirationTime("30d").sign(new TextEncoder().encode(c.env.SESSION_SECRET));
    setCookie(c,"404_session",token,{httpOnly:true,secure:true,sameSite:"Lax",path:"/",maxAge:60*60*24*30});
    return c.json({ user });
  } catch (e:any) { return c.json({ error:"Google sign-in failed" },401); }
});

app.post("/api/auth/logout", async c => { deleteCookie(c,"404_session",{path:"/"}); return c.json({ok:true}); });

const checkoutSchema = z.object({ items:z.array(z.object({variantId:z.string(),quantity:z.number().int().min(1).max(10)})).min(1).max(30) });

app.post("/api/checkout/create", async c => {
  const s = await session(c);
  if (!s) return c.json({error:"Please sign in with Google first."},401);
  try {
    const body = checkoutSchema.parse(await c.req.json());
    const ids = body.items.map(i => i.variantId);
    const q = `query Nodes($ids:[ID!]!) { nodes(ids:$ids) { ... on ProductVariant { id title availableForSale price { amount currencyCode } product { title } } } }`;
    const data = await shopify(c,q,{ids});
    const map = new Map(data.nodes.filter(Boolean).map((v:any)=>[v.id,v]));
    const validated = body.items.map(i => {
      const v:any = map.get(i.variantId);
      if (!v || !v.availableForSale) throw new Error("One of the selected items is no longer available.");
      return { variantId:v.id, title:v.product.title, variantTitle:v.title, quantity:i.quantity, unitPrice:Number(v.price.amount), currency:v.price.currencyCode };
    });
    const total = validated.reduce((sum,i)=>sum+i.unitPrice*i.quantity,0);
    if (total <= 0) throw new Error("Invalid checkout amount.");
    const orderId = `404_${Date.now()}_${crypto.randomUUID().slice(0,8)}`;
    await c.env.DB.prepare("INSERT INTO orders (id,google_sub,email,amount,currency,items,status) VALUES (?,?,?,?,?,?,?)")
      .bind(orderId,s.sub,total,validated[0].currency,JSON.stringify(validated),"CREATED").run();

    const base = c.env.CASHFREE_MODE === "production" ? "https://api.cashfree.com" : "https://sandbox.cashfree.com";
    const cf = await fetch(`${base}/pg/orders`, {
      method:"POST", headers:{"content-type":"application/json","x-client-id":c.env.CASHFREE_CLIENT_ID,"x-client-secret":c.env.CASHFREE_CLIENT_SECRET,"x-api-version":"2025-01-01"},
      body:JSON.stringify({
        order_id:orderId, order_amount:Number(total.toFixed(2)), order_currency:"INR",
        customer_details:{customer_id:String(s.sub).slice(0,50),customer_email:s.email,customer_phone:"9999999999"},
        order_meta:{return_url:`${c.env.SITE_URL}/payment/success?order_id={order_id}`,notify_url:`${c.env.SITE_URL}/api/cashfree/webhook`}
      })
    });
    const out = await cf.json<any>();
    if (!cf.ok) throw new Error(out.message || "Cashfree order creation failed");
    await c.env.DB.prepare("UPDATE orders SET cashfree_session=? WHERE id=?").bind(out.payment_session_id,orderId).run();
    return c.json({orderId,paymentSessionId:out.payment_session_id});
  } catch (e:any) { return c.json({error:e.message || "Checkout failed"},400); }
});

async function getCashfreeStatus(c:any, orderId:string) {
  const base = c.env.CASHFREE_MODE === "production" ? "https://api.cashfree.com" : "https://sandbox.cashfree.com";
  const r = await fetch(`${base}/pg/orders/${encodeURIComponent(orderId)}/payments`,{headers:{"x-client-id":c.env.CASHFREE_CLIENT_ID,"x-client-secret":c.env.CASHFREE_CLIENT_SECRET,"x-api-version":"2025-01-01","accept":"application/json"}});
  if (!r.ok) throw new Error("Unable to verify payment");
  const payments = await r.json<any[]>();
  return payments.some(p=>p.payment_status==="SUCCESS") ? "PAID" : payments.some(p=>p.payment_status==="PENDING") ? "PENDING" : "FAILED";
}

async function createShopifyOrder(c:any, order:any) {
  if (order.status === "SHOPIFY_CREATED") return;
  const items = JSON.parse(order.items);
  const mutation = `mutation Create($order:OrderCreateOrderInput!,$options:OrderCreateOptionsInput) {
    orderCreate(order:$order,options:$options) { userErrors { field message } order { id name displayFinancialStatus } }
  }`;
  const vars = { order:{
    lineItems:items.map((i:any)=>({variantId:i.variantId,quantity:i.quantity})),
    customer:{toUpsert:{email:order.email}},
    email:order.email,
    financialStatus:"PAID",
    note:`404 Society / Cashfree ${order.id}`
  }, options:{sendReceipt:true} };
  const data = await shopify(c,mutation,vars,true);
  const errs = data.orderCreate.userErrors;
  if (errs?.length) throw new Error(errs.map((x:any)=>x.message).join(", "));
  await c.env.DB.prepare("UPDATE orders SET status='SHOPIFY_CREATED',shopify_order_id=? WHERE id=?").bind(data.orderCreate.order.id,order.id).run();
  return data.orderCreate.order;
}

app.get("/api/payment/verify", async c => {
  const s = await session(c);
  const orderId = c.req.query("order_id");
  if (!s || !orderId) return c.json({error:"Not authorized"},401);
  const order = await c.env.DB.prepare("SELECT * FROM orders WHERE id=? AND google_sub=?").bind(orderId,s.sub).first<any>();
  if (!order) return c.json({error:"Order not found"},404);
  try {
    const status = await getCashfreeStatus(c,orderId);
    await c.env.DB.prepare("UPDATE orders SET status=? WHERE id=?").bind(status,orderId).run();
    if (status==="PAID") await createShopifyOrder(c,{...order,status});
    return c.json({status});
  } catch (e:any) { return c.json({error:e.message},500); }
});

async function verifyCashfreeWebhook(rawBody:string, timestamp:string, signature:string, secret:string) {
  const data = timestamp + rawBody;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name:"HMAC", hash:"SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i=0;i<expected.length;i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

app.post("/api/cashfree/webhook", async c => {
  const rawBody = await c.req.text();
  const signature = c.req.header("x-webhook-signature") || "";
  const timestamp = c.req.header("x-webhook-timestamp") || "";
  if (!signature || !timestamp || !(await verifyCashfreeWebhook(rawBody,timestamp,signature,c.env.CASHFREE_CLIENT_SECRET))) {
    return c.json({error:"Invalid webhook signature"},401);
  }
  try {
    const body = JSON.parse(rawBody);
    const orderId = body?.data?.order?.order_id || body?.data?.order?.orderId;
    if (!orderId) return c.json({ok:true});
    const order = await c.env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(orderId).first<any>();
    if (!order) return c.json({ok:true});
    const status = await getCashfreeStatus(c,orderId);
    await c.env.DB.prepare("UPDATE orders SET status=? WHERE id=?").bind(status,orderId).run();
    if (status==="PAID") await createShopifyOrder(c,{...order,status});
    return c.json({ok:true});
  } catch { return c.json({ok:true}); }
});

app.get("/payment/success", async c => {
  const orderId = c.req.query("order_id") || "";
  return c.html(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>404 Society — Payment</title><style>body{font-family:Arial;background:#f4f1ea;display:grid;place-items:center;min-height:100vh;text-align:center}a{display:inline-block;background:#111;color:#fff;padding:14px 22px;text-decoration:none}</style></head><body><main><h1>Payment received.</h1><p>Verifying your order <b>${orderId}</b>…</p><a href="/?paid=${encodeURIComponent(orderId)}">Return to 404 Society</a><script>fetch('/api/payment/verify?order_id='+encodeURIComponent(${JSON.stringify(orderId)})).then(()=>location.href='/?paid='+encodeURIComponent(${JSON.stringify(orderId)})).catch(()=>location.href='/?paid='+encodeURIComponent(${JSON.stringify(orderId)}));</script></main></body></html>`);
});

app.all("*", async c => c.env.ASSETS.fetch(c.req.raw));

export default app;
