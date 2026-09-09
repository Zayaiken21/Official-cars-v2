# Official Cars v8 — Backend

## What was actually broken (root causes found and fixed)

1. **Garbled specs ("ENGINE {\"@type\":...")** — cheerio's `$("body").text()` includes the
   contents of `<script>` tags. Every listing page embeds its structured data as a
   `<script type="application/ld+json">` block, so raw JSON was being pulled into the
   Engine/Transmission/Drivetrain fields whenever a label like "Drivetrain" happened to
   appear near it in the JSON. Fixed by stripping `script/style/noscript/template` before
   any text extraction, and by rejecting any field value that still looks like JSON as a
   safety net (`safeField()` / `looksLikeJsonLeak()`).
2. **"No photos work"** — the image proxy and the image collector only allowed images
   hosted on the dealer's own domain. Real dealer photos are almost always served from a
   separate CDN (e.g. `images.dealer.com`, a CloudFront/Cloudinary domain, etc.), so every
   photo was being silently rejected. Fixed by allowing any public HTTPS image host (still
   blocking localhost/private-network addresses for safety) instead of a domain allowlist.
3. **Phone/address not found** — extraction only checked the homepage's JSON-LD
   Organization block. Now it also checks `<address>` tags, common footer/contact class
   names, a phone-number regex fallback, and — if the homepage doesn't have it — the
   `/contact`, `/contact-us`, `/about`, `/locations` pages too.
4. **Multi-location dealers** — new: `discoverLocations()` looks for a locations/dealerships
   page and either repeated `AutoDealer`/`LocalBusiness` JSON-LD blocks or repeated
   address+phone blocks in the markup, and stores them as `dealer.locations[]`. The public
   frontend shows a location dropdown whenever a dealer has more than one.
5. **Admin panel visibility** — the sync log now also lists recent errors inline, dealer
   rows show photo counts, geocoding status, and detected locations, and the analytics
   tables now show the actual dealer name next to every hot vehicle and a dedicated
   "clicks by dealer" table.
6. **Data disappearing on redeploy** — Render's free-tier disk resets on every deploy.
   Optional GitHub-backed persistence (`GITHUB_TOKEN` / `GITHUB_REPO`) makes the server
   pull `data.json` from a GitHub repo on boot and push updates back (debounced, ~1 commit
   per 15s). Point it at the same repo your GitHub Pages site lives in and the raw data
   file sits right alongside it. See `.env.example`.
7. **"NEW" badge** — every vehicle now has `firstSeenAt`, preserved across re-syncs. The
   frontend shows a NEW badge for `newBadgeDays` (14) from that date.
8. **Web Push scaffold** — `/api/push/vapid-public-key`, `/api/push/subscribe`, and
   `/api/push/unsubscribe`, plus an automatic notification fired to subscribed devices
   whenever a sync finds genuinely new listings. Disabled until you set the `VAPID_*` env
   vars (generate with `npm run generate-vapid-keys`).

## Setup
```
npm install
cp .env.example .env   # fill in values, or set them in Render's dashboard
npm start
```

## Environment variables
See `.env.example` for the full list and explanations. Only `ADMIN_SECRET` and
`ANALYTICS_SALT` are required; GitHub persistence and Web Push are optional but
recommended.

## Limitations to know about
- The scraper only works against dealer sites that expose either JSON-LD structured data,
  a sitemap, or a reasonably conventional inventory URL structure. Sites that render
  inventory entirely client-side via a proprietary JS widget with no server-rendered HTML
  and no sitemap cannot be scraped this way — that would need a per-platform adapter or a
  headless-browser renderer (Puppeteer), which is a larger, separate addition.
- Geocoding uses OpenStreetMap's free Nominatim API (no key required) at a max of ~1
  request/second, so adding a dealer with many locations takes a few seconds longer.
- Only import inventory, images and business data you're authorized to use — see the
  authorization note that was already in this README below.

## Important authorization
Only import dealer inventory, images, listing URLs and business information you are
authorized to use. A sitemap is a discovery mechanism, not permission to copy protected
content. Written dealer agreements should cover inventory data, images, source links and
referral attribution.
