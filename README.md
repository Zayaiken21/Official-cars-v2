# Official Cars API — Render

## Fixes
- `/` no longer returns Cannot GET /
- `/health` confirms service status
- `/admin` provides the protected admin UI
- `/api/public` supplies dealer inventory to the static GitHub site
- `/api/admin/import-url` provides an authorized Cars Trader NY importer endpoint
- JSON import/export and inventory editing remain available

## Render
Build: `npm install`
Start: `npm start`
Environment: `ADMIN_SECRET=<your strong password>`

After deploy, test:
`https://official-cars-v2.onrender.com/`
`https://official-cars-v2.onrender.com/health`
`https://official-cars-v2.onrender.com/api/public`
`https://official-cars-v2.onrender.com/admin`

## Inventory
The included seed contains the 24 vehicles exposed on the currently accessible first Cars Trader NY inventory page. The source page reports 27 total; the importer is included for the remaining authorized source data/feed.
