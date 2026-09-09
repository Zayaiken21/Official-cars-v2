# Official Cars Render API

Dynamic backend for Official Cars.

## Render settings

Create a **Web Service** from this repository.

Build command:
`npm install`

Start command:
`npm start`

Add environment variable:
`ADMIN_SECRET` = a strong password you create.

The server listens on `process.env.PORT` and `0.0.0.0`, as required by Render.

## API

GET `/health`

GET `/api/public`

POST `/api/admin/login`
body: `{"password":"YOUR_ADMIN_SECRET"}`

GET `/api/admin/data`
header: `Authorization: Bearer TOKEN`

PUT `/api/admin/data`
header: `Authorization: Bearer TOKEN`
body: `{"dealers":[],"vehicles":[]}`

POST `/api/admin/import-json`
header: `Authorization: Bearer TOKEN`

GET `/api/admin/export`
header: `Authorization: Bearer TOKEN`

## Important persistence note

`data.json` is a simple starter database. For a production marketplace, move inventory to Postgres/Supabase before relying on it for permanent business data. Render notes that local filesystem changes can be lost with deploys unless persistent storage is used; a database is the better production architecture.
