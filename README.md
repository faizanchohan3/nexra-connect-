# Nexra Connect

One-click product import for Nexra LLC sellers. Sellers connect their **Shopify** or **WooCommerce** store from the Nexra Seller Dashboard, push products with their own prices, and their orders come back to Nexra automatically.

| Feature | How it works |
|---|---|
| Connect Shopify | Seller enters `their-store.myshopify.com`, approves the Nexra app in their Shopify admin, and returns to the dashboard |
| Connect WooCommerce | Seller pastes a Read/Write REST API key (`ck_…` / `cs_…`) |
| Push to store | Products are created in the seller's store with images, options, variants, SKUs and the seller's prices (plan discount + markup + price ending) |
| Price sync | When a product changes on nexrallc.com, every seller store that sells it gets the new price; archived products are hidden (Shopify: Draft, WooCommerce: draft) |
| Order import | New orders in seller stores that contain Nexra products appear in the dashboard under **Orders → Orders from your stores** |
| Pay & send | One click creates a draft order on the Nexra store (shipping to the end customer, seller's plan discount applied, tagged `nexra-reseller-order`) and opens the invoice to pay |
| Plan limits | Enforced on the server from the seller's customer tags: Free = 3 products in total, Starter 50 / Growth 500 per push, Pro unlimited |

It runs as a **Cloudflare Worker** with a **D1** database (both free at this size). The dashboard talks to it through a **Shopify app proxy** at `nexrallc.com/apps/nexra/…`, so every request is signed by Shopify and carries the logged-in customer. No passwords or tokens ever reach the browser, and store credentials are encrypted (AES-GCM) in the database.

```
Seller Dashboard (theme)  ──/apps/nexra/api/*──▶  Shopify app proxy  ──signed──▶  Nexra Connect (Worker + D1)
                                                                                     │  │
                       Nexra store (read products & plans, create draft orders) ◀────┘  └──▶ Seller stores (Shopify / WooCommerce)
```

## Setup (about 30 minutes, once)

### 1. Create the Shopify app
1. Sign up at **partners.shopify.com** (free) → **Apps** → **Create app** → **Create app manually**. Name it `Nexra Connect`.
2. Note the **Client ID** and **Client secret**.

### 2. Deploy the worker
Needs a free Cloudflare account and Node 22.
```bash
git clone https://github.com/faizanchohan3/nexra-connect-.git nexra-connect
cd nexra-connect
npm install
npx wrangler login
npx wrangler d1 create nexra-connect            # copy the database_id into wrangler.toml
npm run db:init                                  # creates the tables
npx wrangler secret put SHOPIFY_API_KEY          # Client ID
npx wrangler secret put SHOPIFY_API_SECRET       # Client secret
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # copy the output
npx wrangler secret put ENCRYPTION_KEY           # paste it (keep a safe copy: losing it means sellers reconnect)
npm run deploy                                   # prints https://nexra-connect.<you>.workers.dev
```
Put that address in `wrangler.toml` as `APP_URL` and run `npm run deploy` again.

### 3. Configure the app (Partner dashboard → your app → Configuration)
| Setting | Value |
|---|---|
| App URL | `https://nexra-connect.<you>.workers.dev/install` |
| Allowed redirection URL | `https://nexra-connect.<you>.workers.dev/auth/callback` |
| App proxy → Subpath prefix / Subpath | `apps` / `nexra` |
| App proxy → Proxy URL | `https://nexra-connect.<you>.workers.dev/proxy` |
| Compliance webhooks (customer data request, customer redact, shop redact) | `https://nexra-connect.<you>.workers.dev/webhooks/shopify` |
| Embedded in Shopify admin | Off |

### 4. Install it on the Nexra store
Open `https://nexra-connect.<you>.workers.dev/install?shop=h0vzt0-80.myshopify.com` while logged in to the Nexra admin and approve. This lets the app read products and customer plans, create draft orders, and subscribe to product changes.

### 5. Let sellers install it
- **WooCommerce** works right away.
- **Shopify** stores can only install an app that is distributed. In the Partner dashboard choose **Distribution → Public distribution** (unlisted is fine) and submit for review. Until it is approved you can test with Shopify **development stores**.

### 6. Publish the theme
Publish the theme copy that contains the updated Seller Dashboard (Connected Stores, Push to store, Orders from your stores). Until steps 2–4 are done, the dashboard shows "being set up" and the CSV export files keep working.

## Development
```bash
npm test                      # 20 tests: signatures, encryption, pricing, mapping, full flows against fake stores
npx wrangler dev --local      # local run (put secrets in .dev.vars)
```
`test/e2e-dashboard.mjs` drives the real dashboard script in jsdom against this worker and fake stores.

## Limits to know
- Cloudflare's free plan allows 50 outbound requests per call. Pushes are sent in batches of 10 products, and a price change updates up to 40 seller stores per product. With many sellers on one product, use the Workers Paid plan ($5/month, 1,000 requests per call).
- Stock levels are not synced, because the Nexra catalog does not track stock. Availability is synced: products archived or drafted on the Nexra store are hidden in seller stores and come back when re-activated.
- eBay and Amazon still use the export files. Direct connections need approved developer accounts on those platforms.
- Fulfilment tracking is not yet sent back to seller stores. Sellers see tracking on the paid Nexra order.
