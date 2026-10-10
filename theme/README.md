# Nexra LLC theme files

Copies of the custom files added to the Nexra LLC Shopify theme (based on techmarket-v1-1). Upload them with the theme editor ("Edit code") or the Admin API to an unpublished copy of the live theme, then publish.

| File | Page |
|---|---|
| `templates/page.reseller-dashboard.liquid` | Seller Dashboard app (`/pages/reseller-dashboard`) with Find Products, Import List, Push to store, Connected Stores, Orders, Pricing Rules, Plan & Billing |
| `templates/collection.reseller-plans.liquid` | Plans page with Free / Starter / Growth / Pro cards (`/collections/nexra-reseller-plans`) |
| `templates/page.nexra-auth.liquid` | Customer and seller login / sign-up pages (`/pages/customer-login`, `customer-signup`, `seller-login`, `seller-signup`) |
| `templates/page.join.liquid` | Customer-or-seller chooser (`/pages/join`) |
| `snippets/nexra-join-links.liquid` | Sends logged-out Login/Register clicks to the login page; account menu (Seller Dashboard, My orders, Log out) for logged-in visitors. Included from `snippets/oldIE-js.liquid` |
| `snippets/nexra-account-switch.liquid`, `snippets/nexra-account-banner.liquid` | Customer/seller switch for legacy account pages (unused with new customer accounts) |

The dashboard's direct-import features call `/apps/nexra/api/*`, served by Nexra Connect through a Shopify app proxy (see `../README.md`).
