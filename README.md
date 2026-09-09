# Official Cars Render Backend v4

Node/Express backend for Official Cars.

## Deploy on Render
- Build: `npm install`
- Start: `npm start`
- Environment variable: `ADMIN_SECRET`

## Admin
`/admin`

Use **Sync entire dealer inventory**. The sync discovers authorized Cars Trader NY inventory URLs using:
1. XML sitemap / sitemap index when available
2. robots.txt sitemap declarations
3. Cars Trader NY inventory pagination
4. Individual `/details/` pages

Each detail page is parsed for structured data, page metadata, vehicle fields, original URL and image URLs.

The `/api/image` route proxies only `www.carstraderny.com` HTTPS images so the public GitHub Pages site can reliably display dealer photos.

Keep written authorization from the dealer for use of their inventory, photos and listing links.
