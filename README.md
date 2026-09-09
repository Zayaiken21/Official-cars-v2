# Official Cars v7 — Professional Dealer Control Center

## What changed
- Fixed legacy `url` → `sourceUrl` migration so older inventory records do not break source routing.
- Added a strict `/go/:id` source redirect that only redirects to a verified, authorized individual listing URL.
- Added a professional dealer importer with a clear website URL field.
- Added an explicit **Choose dealer to sync** selector plus **Sync selected dealer**.
- Added dealer search, per-dealer management controls, dealer website links, sync status and diagnostics.
- Added safer API error handling and admin session handling.
- Added source-link validation so generic inventory/category URLs cannot be presented as individual vehicle listings.
- Public frontend remains compatible with the Render API and normalizes legacy source fields.

## Dealer workflow
1. Open `/admin`.
2. Enter an HTTPS dealer website.
3. The backend verifies the public host and reads publicly exposed business metadata.
4. The dealer is added to the same participating-dealer list.
5. Select that dealer in **Choose dealer to sync** or use **Sync this dealer**.
6. The importer discovers robots/sitemaps and likely vehicle detail URLs, then stores each original listing URL and authorized images.
7. Use **Open original** / **View actual dealer listing** to leave Official Cars for the dealer's individual listing.

## Important authorization
Only import dealer inventory, images, listing URLs and business information you are authorized to use. A sitemap is a discovery mechanism, not permission to copy protected content. Written dealer agreements should cover inventory data, images, source links and referral attribution.

## Render
Build: `npm install`
Start: `npm start`

Environment variables:
- `ADMIN_SECRET`
- `ANALYTICS_SALT`

## Public frontend
Set `static/config.js` API_BASE to the deployed Render service URL.
