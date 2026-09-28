# 404 Society

A bold, minimal fashion storefront powered by Shopify for product management, Google-only customer sign-in, Cashfree Payments, Cloudflare Workers + D1, and GitHub.

## Architecture

- **Storefront:** React + Vite
- **Backend:** Hono on Cloudflare Workers
- **Catalog:** Shopify Storefront API — live products/variants
- **Admin:** Shopify Admin — orders are written back after a successful Cashfree payment
- **Customer login:** Google Identity Services
- **Payments:** Cashfree hosted web checkout
- **Persistence:** Cloudflare D1 for users + pending/paid order state
- **Hosting:** Cloudflare Workers/Assets
- **Source control:** GitHub

### Important

The browser never receives the Shopify Admin token, Cashfree secret, or session signing secret. Keep them in Cloudflare Worker secrets.

## 1. Create the Shopify side

In Shopify Admin, create a custom app / app access token with the scopes required for your implementation. At minimum, the order creation flow needs `write_orders`; product reads need product read access. The storefront token needs access to published products.

The code uses Shopify API version `2026-07`.

Set:
- `SHOPIFY_STORE_DOMAIN` — e.g. `your-store.myshopify.com`
- `SHOPIFY_STOREFRONT_TOKEN`
- `SHOPIFY_ADMIN_TOKEN`

Your Shopify Admin remains the source of truth for products, prices, inventory and order management.

## 2. Google-only login

Create a Google Cloud OAuth 2.0 Web client ID and configure the production origin in the Google Identity Services settings.

Put the client ID in:
- local `.env` as `VITE_GOOGLE_CLIENT_ID`
- Cloudflare Worker secret as `GOOGLE_CLIENT_ID`

The client sends the Google ID token to `/api/auth/google`; the Worker verifies it against Google's public signing keys before creating the site session.

## 3. Cashfree

Start in sandbox mode.

Create API credentials in Cashfree and configure the checkout return URL and webhook URL:
- `https://YOUR-DOMAIN/api/cashfree/webhook`
- `https://YOUR-DOMAIN/payment/success?order_id={order_id}`

Set:
- `CASHFREE_CLIENT_ID`
- `CASHFREE_CLIENT_SECRET`
- `CASHFREE_MODE=sandbox` or `production`

The included webhook verifies `x-webhook-signature` over `timestamp + rawBody` using HMAC-SHA256/base64, then re-checks payment status server-side. Test duplicate webhook delivery/idempotency before launch.

## 4. Local development

```bash
npm install
npm run build
```

For local Worker development, create `.dev.vars` with the same secret names used in `wrangler.toml`, then use Wrangler's local development flow.

## 5. Cloudflare D1

Create the database:

```bash
npx wrangler d1 create 404-society
```

Copy its database ID into `wrangler.toml`, then apply migrations:

```bash
npx wrangler d1 migrations apply 404-society --remote
```

## 6. Secrets

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put SESSION_SECRET
npx wrangler secret put SHOPIFY_STORE_DOMAIN
npx wrangler secret put SHOPIFY_STOREFRONT_TOKEN
npx wrangler secret put SHOPIFY_ADMIN_TOKEN
npx wrangler secret put CASHFREE_CLIENT_ID
npx wrangler secret put CASHFREE_CLIENT_SECRET
```

For `SESSION_SECRET`, generate a long random value.

## 7. GitHub

```bash
git init
git add .
git commit -m "Initial 404 Society storefront"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/404-society.git
git push -u origin main
```

Then connect the GitHub repository to Cloudflare's deployment pipeline or use Wrangler from CI.

## 8. Production checklist

- Replace the placeholder D1 ID and `SITE_URL`.
- Add your real custom domain in Cloudflare.
- Change Cashfree to production only after sandbox testing.
- Configure Cashfree webhook and verify its signature before processing.
- Add shipping address collection and your shipping/tax rules before launch.
- Test inventory race conditions, refunds, cancellations and failed payments.
- Test Shopify order creation and receipt emails.
- Add Privacy Policy, Terms, Refund/Return Policy and shipping policy.
- Add proper product photography and your final brand assets.
