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

### 3. Upload the app settings to Shopify
Everything Shopify needs (URLs, scopes, app proxy, compliance webhooks) is in `shopify.app.toml`.
1. In `shopify.app.toml`, replace every `YOUR-WORKER` with your worker address (e.g. `nexra-connect.yourname.workers.dev`).
2. Run:
```bash
npx @shopify/cli@latest app deploy      # log in with your Partner account when asked, choose "Nexra Connect"
```
This creates a new app version with these settings and releases it. You can check it in the Partner/Dev Dashboard → your app → **Versions**.

The same settings, if you prefer to enter them by hand:

| Setting | Value |
|---|---|
| App URL | `https://YOUR-WORKER/install` |
| Allowed redirection URL | `https://YOUR-WORKER/auth/callback` |
| App proxy → Subpath prefix / Subpath | `apps` / `nexra` |
| App proxy → Proxy URL | `https://YOUR-WORKER/proxy` |
| Compliance webhooks (customer data request, customer redact, shop redact) | `https://YOUR-WORKER/webhooks/shopify` |
| Embedded in Shopify admin | Off |

**Protected customer data:** seller orders include the end customer's name and address. In the Partner dashboard → your app → **API access** → **Protected customer data access**, request access and select *Name*, *Email*, *Phone* and *Address*, with the reason "fulfil orders placed in seller stores".

### 4. Install it on the Nexra store
Open `https://nexra-connect.<you>.workers.dev/install?shop=h0vzt0-80.myshopify.com` while logged in to the Nexra admin and approve. This lets the app read products and customer plans, create draft orders, and subscribe to product changes.

### 5. Choose distribution and let sellers install
Shopify lets an app with **custom distribution** into one store only, and an app with **public distribution** into other stores only after review. So Nexra Connect uses two apps:

| App | Distribution | Installed on | Keys on the worker |
|---|---|---|---|
| Nexra Connect (`shopify.app.toml`) | Custom → `h0vzt0-80.myshopify.com` | the Nexra store | `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` |
| Nexra Connect for Sellers (`shopify.app.sellers.toml`) | Public (unlisted is fine) | sellers' Shopify stores | `SELLER_API_KEY`, `SELLER_API_SECRET` |

- **WooCommerce** sellers work as soon as the Nexra store app is installed.
- Until the seller app's keys are on the worker, the dashboard tells sellers that Shopify connections are opening soon.
- To add the seller app: create a second app in the Dev Dashboard, put its Client ID in `shopify.app.sellers.toml`, run `npx @shopify/cli@latest app deploy --config sellers`, save its keys on the worker, then in the Partner Dashboard choose **Public distribution** and submit it for review. Before approval it can be tested on development stores.

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
