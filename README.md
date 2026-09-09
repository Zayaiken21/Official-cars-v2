# Official Cars Render v5

Node/Express backend for Official Cars.

## Render
- Build: `npm install`
- Start: `npm start`
- Required: `ADMIN_SECRET`
- Recommended: `ANALYTICS_SALT`

## Features
- Authorized Cars Trader NY sitemap/index + inventory pagination discovery
- Individual `/details/` page parsing
- Real source URLs retained per vehicle
- Server-side `/go/:vehicleId` redirect for tracked outbound dealer clicks
- Restricted image proxy for authorized source host
- First-party page/view/click analytics with hashed session IDs
- Admin date filters and filtered CSV export

For additional dealers, use a dealer-provided feed/API whenever possible. Only use website images/data where the dealer agreement permits it.
