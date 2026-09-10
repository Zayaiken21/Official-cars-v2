# Official Cars V8 — Production Dealer Control

This package is the repaired Render backend for Official Cars.

## What V8 fixes
- Professional dealer import and selected-dealer synchronization.
- Multi-location dealer discovery and vehicle location assignment.
- State/city/location/distance filtering support in the public site.
- Browser geolocation + Haversine mileage-to-dealer calculations.
- Real source vehicle URLs with tracked `/go/:id` redirects.
- Vehicle names, dealer names, VIN/stock and source URLs retained in analytics.
- Stronger vehicle extraction: price, mileage, engine, transmission, drivetrain, fuel, body style, MPG, horsepower, torque, doors, fuel tank, VIN, stock, description and features when published by the dealer.
- Photo extraction from JSON-LD, Open Graph, normal/lazy images, source sets and common background/data attributes.
- Image proxy authorizes exact stored vehicle photo URLs, including legitimate third-party dealer CDNs.
- New vehicles remain marked `NEW` for 14 days from first discovery.
- Optional browser push alerts for new vehicles and new dealers.
- Installable PWA manifest/service worker for Android, desktop and iPhone/iPad Safari home-screen installation.
- Live sync progress with candidate count, processed count, current URL, skipped records and errors.
- Optional GitHub persistence so Render restarts can restore the dealer/inventory/analytics database.

## Required Render environment variables
Keep `ADMIN_SECRET` and `ANALYTICS_SALT` set.

For persistent data, configure:
- `GITHUB_TOKEN` — GitHub token with permission to read/write the repository contents.
- `GITHUB_OWNER` — repository owner/org.
- `GITHUB_REPO` — repository containing the Official Cars Pages files/data.
- `GITHUB_BRANCH` — normally `main`.
- `GITHUB_DATA_PATH` — normally `official-cars-data.json`.

The backend commits a full data snapshot after changes/analytics. On startup it restores that snapshot before serving traffic.

## Push notifications
Configure Web Push VAPID credentials:
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` (for example a mailto address owned by the operator)

Generate a pair with the `web-push` CLI or another trusted VAPID generator. Never put the private key in the GitHub Pages repository.

The public site requests notification permission only after the shopper taps the alert button. Android/desktop browsers can install the app and receive push notifications. On iPhone/iPad, Safari requires the site to be added to the Home Screen before web push can be enabled.

## Authorized inventory/data
The crawler is intended for participating/authorized dealer sources. A sitemap is used for discovery; it is not treated as a license to copy photographs or proprietary inventory data. For each partner, keep written authorization covering the fields/images you intend to display.

## Deployment
1. Deploy this folder to Render.
2. Set the Render environment variables above.
3. Confirm `/health` reports GitHub persistence enabled.
4. Open `/admin` and log in.
5. Paste a dealer website into **Add participating dealer**.
6. Review the discovered business/locations.
7. Select the dealer and click **Sync selected dealer**.
8. Watch the live progress panel until it says `complete`.
9. Open the public Pages site and test a vehicle photo and **View actual dealer listing**.


## V9 production hardening
- 20-second request timeout plus bounded concurrent vehicle imports prevent sync hangs.
- Vehicle photo candidates are ranked using structured Vehicle/Product images and vehicle-context attributes while excluding common storefront/dealer-building assets.
- Discovered authorized image CDN hosts are retained on the dealer record.
- GitHub Pages opens the exact sourceUrl directly after tracking, so the listing does not depend on the Render redirect route.
- Multi-location filtering uses location IDs/address data and shopper geolocation distance.
- Vehicle detail gallery is a photo-based interactive orbit viewer, not a fabricated 3D mesh.
