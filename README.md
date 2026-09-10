# Official Cars — Render Backend V12

Production backend for the Official Cars referral/discovery platform.

## Dealer lifecycle
- The packaged `data.json` intentionally contains **zero hardcoded dealers or vehicles**.
- Dealers are added from Admin with an HTTPS website URL.
- Add Dealer reads the business profile and location/contact pages, saves the dealer permanently, then automatically starts an inventory sync.
- A saved dealer remains until an administrator deletes it.
- Delete removes that dealer's vehicles and dealer-scoped analytics.

## Sync/import
The importer uses authorized dealer websites and attempts, in bounded order, to discover:
- robots.txt and sitemap/sitemap-index inventory URLs
- inventory/category/pagination pages
- embedded JSON/framework state
- common inventory JSON endpoints
- individual vehicle pages
- business/location/contact pages

Vehicle records contain only shopper-relevant published vehicle data: title, year/make/model/trim, price, mileage, engine, transmission, drivetrain, fuel, body style, MPG, horsepower/torque when published, VIN/stock, description, features, vehicle photos, dealer location and exact source listing URL.

Photo collection prioritizes vehicle/gallery images and excludes common storefront, logo, showroom, staff, facility and contact imagery. Image URLs are retained only when discovered from the authorized vehicle pages and are served through the protected image endpoint.

The sync worker uses request timeouts, 429/502/503/504 retry/backoff, host throttling, bounded concurrency, heartbeats and a safety timeout so a rate-limited dealer does not leave the control center permanently stuck.

## Required Render environment variables
- `ADMIN_SECRET`
- `ANALYTICS_SALT`
- `GITHUB_TOKEN`
- `GITHUB_OWNER`
- `GITHUB_REPO`
- `GITHUB_BRANCH` (default `main`)
- `GITHUB_DATA_PATH` (default `official-cars-data.json`)
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`

## Persistence
When GitHub variables are configured, dealer records, vehicles and analytics are persisted to the configured GitHub JSON data file. Render's local filesystem is not treated as the permanent database.

## Authorization
Only synchronize dealer inventory and images when the dealer has authorized Official Cars to use the applicable inventory data, listing URLs and photographs, or has provided an authorized feed/API/XML/CSV source.
