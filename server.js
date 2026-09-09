/**
 * Official Cars API — v8
 * Fixes applied in this version (see CHANGELOG.md for the full list):
 *  - Root cause of garbled specs (raw JSON-LD text leaking into Engine/Transmission/Drivetrain):
 *    cheerio's $("body").text() includes <script> contents. We now strip script/style/noscript
 *    before any text-based extraction, and we sanity-check every scraped field so anything that
 *    still looks like JSON never reaches the database.
 *  - Root cause of "no photos": the image proxy and image collector only allowed the dealer's own
 *    domain. Real dealer sites almost always serve photos from a separate CDN
 *    (images.dealer.com, cloudfront, imagescdn, etc). We now allow any public, non-private-network
 *    HTTPS image host (still blocking localhost/internal IPs for safety) instead of a domain allowlist.
 *  - Phone/address extraction now falls back through multiple strategies and multiple pages
 *    (home, /contact, /contact-us, /about, /locations, /dealerships) instead of homepage-JSON-LD-only.
 *  - Added multi-location dealer support (dealer.locations[]) with geocoding for distance search.
 *  - Added firstSeenAt on every vehicle so the frontend can show a "NEW" badge for 2 weeks.
 *  - Added optional GitHub-backed persistence so analytics/inventory survive Render redeploys.
 *  - Added a web-push scaffold so new listings can notify subscribed devices.
 */
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cheerio = require("cheerio");
const zlib = require("zlib");
const dns = require("dns").promises;

let webpush = null;
try { webpush = require("web-push"); } catch { /* optional dependency */ }

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "50mb" }));

const PORT = Number(process.env.PORT || 10000);
const DB = path.join(__dirname, "data.json");
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const ANALYTICS_SALT = process.env.ANALYTICS_SALT || crypto.randomBytes(16).toString("hex");
const UA = "Official-Cars-Authorized-Dealer-Sync/8.0 (+https://officialcars.example/partners)";
const NEW_BADGE_DAYS = 14;

// ---- optional GitHub-backed persistence (survives Render redeploys) ----
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const GH_REPO = process.env.GITHUB_REPO || ""; // "owner/repo"
const GH_BRANCH = process.env.GITHUB_BRANCH || "main";
const GH_PATH = process.env.GITHUB_DATA_PATH || "data/official-cars-data.json";
const GH_ENABLED = !!(GH_TOKEN && GH_REPO);
let ghSha = null; // last known blob sha, needed to commit an update
let ghPushTimer = null;
let ghPushPending = false;

async function ghRequest(method, body) {
  const url = `https://api.github.com/repos/${GH_REPO}/contents/${GH_PATH}?ref=${encodeURIComponent(GH_BRANCH)}`;
  const res = await fetch(method === "GET" ? url : url.split("?")[0], {
    method,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      "User-Agent": UA,
      Accept: "application/vnd.github+json",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return res;
}

async function ghPull() {
  if (!GH_ENABLED) return null;
  try {
    const r = await ghRequest("GET");
    if (r.status === 404) return null;
    if (!r.ok) { console.warn("GitHub pull failed:", r.status); return null; }
    const j = await r.json();
    ghSha = j.sha;
    return Buffer.from(j.content, "base64").toString("utf8");
  } catch (e) { console.warn("GitHub pull error:", e.message); return null; }
}

async function ghPush(jsonString) {
  if (!GH_ENABLED) return;
  try {
    const body = {
      message: `sync data · ${new Date().toISOString()}`,
      content: Buffer.from(jsonString, "utf8").toString("base64"),
      branch: GH_BRANCH,
      ...(ghSha ? { sha: ghSha } : {})
    };
    const r = await ghRequest("PUT", body);
    if (r.ok) { const j = await r.json(); ghSha = j.content?.sha || ghSha; }
    else if (r.status === 409) { // sha stale — refetch and skip this push, next write will retry
      const latest = await ghRequest("GET");
      if (latest.ok) { const j = await latest.json(); ghSha = j.sha; }
    } else { console.warn("GitHub push failed:", r.status, await r.text()); }
  } catch (e) { console.warn("GitHub push error:", e.message); }
}

function scheduleGhPush() {
  if (!GH_ENABLED) return;
  ghPushPending = true;
  if (ghPushTimer) return;
  ghPushTimer = setTimeout(async () => {
    ghPushTimer = null;
    if (!ghPushPending) return;
    ghPushPending = false;
    try { await ghPush(fs.readFileSync(DB, "utf8")); } catch { /* ignore */ }
  }, 15000); // debounce: at most one commit every 15s
}

// ---- local read/write, mirrored to GitHub when configured ----
function read() { return JSON.parse(fs.readFileSync(DB, "utf8")); }
function write(d) { fs.writeFileSync(DB, JSON.stringify(d, null, 2)); scheduleGhPush(); }

function ensure(d) {
  d.dealers ||= [];
  d.vehicles ||= [];
  d.analytics ||= { events: [] };
  d.analytics.events ||= [];
  d.pushSubscriptions ||= [];
  let changed = false;
  for (const v of d.vehicles) {
    if (!v.sourceUrl && v.url) { v.sourceUrl = v.url; changed = true; }
    if (!v.url && v.sourceUrl) { v.url = v.sourceUrl; changed = true; }
    if (!v.sourceUrl && v.dealerUrl) { v.sourceUrl = v.dealerUrl; changed = true; }
    if (!v.mileage && v.miles) { v.mileage = v.miles; changed = true; }
    if (!v.bodyStyle && v.type) { v.bodyStyle = v.type; changed = true; }
    if (!v.firstSeenAt) { v.firstSeenAt = v.lastVerified || v.syncedAt || new Date().toISOString(); changed = true; }
  }
  for (const dl of d.dealers) {
    if (dl.locations === undefined) { dl.locations = []; changed = true; }
  }
  if (changed) { try { fs.writeFileSync(DB, JSON.stringify(d, null, 2)); scheduleGhPush(); } catch { /* ignore */ } }
  return d;
}

// ---- small helpers ----
function clean(s = "") { return String(s).replace(/\s+/g, " ").trim(); }
function abs(base, href) { try { return new URL(href, base).href; } catch { return ""; } }
function money(s) { const m = clean(s).match(/\$\s*([\d,]+(?:\.\d{2})?)/); return m ? Number(m[1].replace(/,/g, "")) : null; }
function hash(s) { return crypto.createHash("sha256").update(String(s) + ANALYTICS_SALT).digest("hex").slice(0, 16); }
function token() { return crypto.createHash("sha256").update(ADMIN_SECRET).digest("hex"); }
function auth(req, res, next) {
  if (!ADMIN_SECRET) return res.status(503).json({ error: "Set ADMIN_SECRET in Render Environment Variables first." });
  if (req.headers.authorization?.replace(/^Bearer\s+/i, "") !== token()) return res.status(401).json({ error: "Unauthorized" });
  next();
}
function originOf(u) { try { return new URL(u).origin; } catch { return ""; } }
function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } }
function hostAllowed(u, domains) { const h = hostOf(u); return !!h && domains.some(x => h === x || h.endsWith("." + x)); }
function safeHost(host) { return /^[a-z0-9.-]+$/i.test(host) && !host.includes(".."); }

// A general "is this a safe public host to fetch from" check (blocks SSRF to internal networks)
// without restricting to one specific domain. Used for images, which are legitimately served
// from third-party CDNs that are NOT the dealer's own domain.
async function isPublicHost(host) {
  if (!safeHost(host)) return false;
  if (/^(localhost|.*\.local)$/i.test(host)) return false;
  try {
    const a = await dns.lookup(host, { all: true });
    return a.length > 0 && a.every(x => !/^10\.|^127\.|^0\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^::1$|^fc|^fd/i.test(x.address));
  } catch { return false; }
}
function dealerDomains(d) {
  const locs = (d.locations || []).map(l => hostOf(l.website)).filter(Boolean);
  return [hostOf(d.website), ...(d.allowedDomains || []), ...locs].filter(Boolean);
}
async function fetchText(url, domains, referer) {
  if (!/^https:\/\//i.test(url) || !hostAllowed(url, domains)) throw new Error("URL not allowed for this dealer");
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "text/html,application/xml,text/xml,application/json,*/*;q=.7", ...(referer ? { Referer: referer } : {}) },
    redirect: "follow"
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  let b = Buffer.from(await r.arrayBuffer());
  const enc = (r.headers.get("content-encoding") || "").toLowerCase();
  try { if (enc.includes("gzip")) b = zlib.gunzipSync(b); else if (enc.includes("deflate")) b = zlib.inflateSync(b); } catch { /* already decoded by fetch */ }
  return b.toString("utf8");
}

let syncState = { running: false, startedAt: null, finishedAt: null, found: 0, imported: 0, newListings: 0, errors: [], log: [] };
function log(s) { syncState.log.push(new Date().toISOString() + "  " + s); if (syncState.log.length > 800) syncState.log.shift(); }

// ---- HTML parsing (the fix: always strip script/style before reading text) ----
function loadClean(html) {
  const $ = cheerio.load(html);
  const jsonLd = [];
  $('script[type="application/ld+json"]').each((_, e) => { try { jsonLd.push(JSON.parse($(e).text().trim())); } catch { /* skip malformed block */ } });
  $("script,style,noscript,template").remove();
  return { $, jsonLd, text: clean($("body").text()) };
}
function flatten(o, out = []) {
  if (!o) return out;
  if (Array.isArray(o)) { o.forEach(x => flatten(x, out)); return out; }
  if (typeof o === "object") { out.push(o); Object.values(o).forEach(x => { if (typeof x === "object") flatten(x, out); }); }
  return out;
}
function firstType(nodes, types) {
  return nodes.find(x => {
    const t = String(x["@type"] || "").toLowerCase();
    return types.includes(t) || t.split("/").some(p => types.includes(p));
  });
}
// Reject any scraped value that still looks like a JSON fragment (guards against any future
// selector regression bleeding raw markup/JSON into a "clean" field again).
function looksLikeJsonLeak(s) {
  const x = String(s || "");
  return /\{\s*"@|"@type"|":\s*\{|https?:\/\/schema\.org/i.test(x) || (x.match(/[{}":]/g) || []).length > 4;
}
function safeField(s) { const c = clean(s); return looksLikeJsonLeak(c) ? "" : c; }

const PHONE_RE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/;
function findPhone($, text) {
  const tel = $('a[href^="tel:"]').first().attr("href");
  if (tel) return clean(tel.replace(/^tel:/i, ""));
  const m = text.match(PHONE_RE);
  return m ? clean(m[0]) : "";
}
function findAddress($, text) {
  const addrTag = clean($("address").first().text());
  if (addrTag && addrTag.length < 200) return addrTag;
  // Common footer/contact class names used across dealer website platforms (Dealer.com, DealerOn, etc).
  const sel = $('[class*="address" i],[itemprop="address"],[data-address],footer [class*="location" i]').first();
  const bySel = clean(sel.text());
  if (bySel && bySel.length < 200) return bySel;
  const m = text.match(/\d{2,6}\s+[A-Za-z0-9.'\s]{3,40},\s*[A-Za-z\s]{2,30},\s*[A-Z]{2}\s*\d{5}/);
  return m ? clean(m[0]) : "";
}

function businessInfo(url, html) {
  const { $, jsonLd, text } = loadClean(html);
  const nodes = flatten(jsonLd);
  const b = firstType(nodes, ["organization", "localbusiness", "automotivedealer", "autodealer", "store"]);
  const name = safeField(b?.name || $('meta[property="og:site_name"]').attr("content") || $('meta[name="application-name"]').attr("content") || $("title").first().text().replace(/\s*[|•-].*$/, ""));
  const addrObj = b?.address || {};
  let addr = typeof addrObj === "string" ? addrObj : [addrObj.streetAddress, addrObj.addressLocality, addrObj.addressRegion, addrObj.postalCode].filter(Boolean).join(", ");
  addr = safeField(addr) || findAddress($, text);
  let logo = typeof b?.logo === "string" ? b.logo : b?.logo?.url || $('meta[property="og:image"]').attr("content") || "";
  let phone = safeField(b?.telephone) || findPhone($, text);
  let website = b?.url || url;
  let social = Array.isArray(b?.sameAs) ? b.sameAs.filter(x => /^https?:\/\//.test(x)) : [];
  return { name: name || "", address: addr || "", phone: phone || "", website: abs(url, website) || url, logo: abs(url, logo), social };
}

// Try the homepage first; if key fields are missing, check a few common contact/locations pages.
async function discoverBusinessInfo(homeUrl, domains) {
  let html = await fetchText(homeUrl, domains, homeUrl);
  let info = businessInfo(homeUrl, html);
  const candidates = ["/contact", "/contact-us", "/about", "/about-us", "/locations", "/dealerships", "/our-dealerships"];
  for (const path of candidates) {
    if (info.address && info.phone) break;
    try {
      const u = abs(homeUrl, path);
      if (!u || !hostAllowed(u, domains)) continue;
      const h = await fetchText(u, domains, homeUrl);
      const more = businessInfo(u, h);
      info.address = info.address || more.address;
      info.phone = info.phone || more.phone;
      info.logo = info.logo || more.logo;
    } catch { /* page may not exist — that's fine */ }
  }
  return { info, homeHtml: html };
}

// Multi-location dealer groups usually list every store on one "locations" style page, either as
// repeated LocalBusiness JSON-LD blocks or repeated address/phone blocks in the markup.
async function discoverLocations(dealer, homeHtml) {
  const domains = dealerDomains(dealer);
  const pages = ["/locations", "/dealerships", "/our-dealerships", "/our-locations", "/contact"];
  const found = [];
  const tryPage = (html, pageUrl) => {
    const { $, jsonLd, text } = loadClean(html);
    const nodes = flatten(jsonLd).filter(n => ["autodealer", "automotivedealer", "localbusiness", "store"].includes(String(n["@type"] || "").toLowerCase()));
    for (const n of nodes) {
      const nm = safeField(n.name);
      const a = n.address || {};
      const addr = safeField(typeof a === "string" ? a : [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode].filter(Boolean).join(", "));
      const ph = safeField(n.telephone);
      const site = abs(pageUrl, n.url || "") || dealer.website;
      if (nm && addr) found.push({ name: nm, address: addr, phone: ph, website: site });
    }
    // Fallback: repeated blocks that each contain both an address-looking string and a phone number.
    if (!found.length) {
      $('[class*="location" i],[class*="dealership" i],[class*="store" i]').each((_, e) => {
        const block = clean($(e).text());
        if (block.length > 400) return;
        const addrM = block.match(/\d{2,6}\s+[A-Za-z0-9.'\s]{3,40},\s*[A-Za-z\s]{2,30},\s*[A-Z]{2}\s*\d{5}/);
        const phM = block.match(PHONE_RE);
        if (addrM && phM) found.push({ name: dealer.name, address: clean(addrM[0]), phone: clean(phM[0]), website: dealer.website });
      });
    }
  };
  tryPage(homeHtml, dealer.website);
  for (const p of pages) {
    if (found.length > 1) break;
    try {
      const u = abs(dealer.website, p);
      if (!u || !hostAllowed(u, domains)) continue;
      const h = await fetchText(u, domains, dealer.website);
      tryPage(h, u);
    } catch { /* ignore missing page */ }
  }
  // De-duplicate by address.
  const seen = new Set();
  return found.filter(l => { const k = l.address.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 25);
}

// Free geocoder (OpenStreetMap Nominatim) — no API key required. Respect their 1 req/sec usage policy.
let lastGeocodeAt = 0;
async function geocode(address) {
  if (!address) return null;
  const now = Date.now();
  const wait = Math.max(0, 1100 - (now - lastGeocodeAt));
  if (wait) await new Promise(r => setTimeout(r, wait));
  lastGeocodeAt = Date.now();
  try {
    const u = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(address);
    const r = await fetch(u, { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j?.length) return null;
    return { lat: Number(j[0].lat), lng: Number(j[0].lon) };
  } catch { return null; }
}

function imageCandidates($, base) {
  const out = [];
  const add = (u) => {
    u = abs(base, String(u || "").trim());
    if (!u || !/^https:\/\//i.test(u)) return;
    if (/\.(jpg|jpeg|png|webp|avif|gif)(\?|$)/i.test(u) || /image|photo|vehicle|media|inventory|cdn/i.test(u)) {
      if (!out.includes(u)) out.push(u);
    }
  };
  $('meta[property="og:image"],meta[name="twitter:image"]').each((_, e) => add($(e).attr("content")));
  $("img").each((_, e) => ["src", "data-src", "data-lazy-src", "data-original", "data-image"].forEach(k => add($(e).attr(k))));
  $("[srcset],[data-srcset]").each((_, e) => String($(e).attr("srcset") || $(e).attr("data-srcset") || "").split(",").forEach(x => add(x.trim().split(/\s+/)[0])));
  return out.slice(0, 80);
}

function valueAfter(text, label, next) {
  const s = clean(text); const i = s.toLowerCase().indexOf(label.toLowerCase());
  if (i < 0) return "";
  let rest = s.slice(i + label.length).replace(/^\s*:?\s*/, ""); let end = rest.length;
  for (const n of next) { const j = rest.toLowerCase().indexOf(n.toLowerCase()); if (j >= 0) end = Math.min(end, j); }
  return safeField(rest.slice(0, end));
}

function parseVehicle(url, html, dealer) {
  const { $, jsonLd, text } = loadClean(html); // text here has scripts already stripped — this is the core fix
  const nodes = flatten(jsonLd);
  const prod = firstType(nodes, ["vehicle", "product", "car"]) || {};
  let title = safeField($("h1").first().text() || $('meta[property="og:title"]').attr("content") || prod.name || "");
  let year = prod.vehicleModelDate ? Number(String(prod.vehicleModelDate).slice(0, 4)) : null;
  let make = safeField(prod.brand?.name || prod.manufacturer || "");
  let model = safeField(prod.model || "");
  const tm = title.match(/\b(19\d{2}|20\d{2})\s+([A-Za-z][\w-]*)\s+(.+)/);
  if (tm) { year = year || Number(tm[1]); make = make || tm[2]; model = model || tm[3]; }
  if (!title && (year || make || model)) title = [year, make, model].filter(Boolean).join(" ");
  let price = prod.offers?.price ?? money(text);
  let mileage = prod.mileageFromOdometer?.value ?? null;
  if (!mileage) { const m = text.match(/Mileage\s*:?\s*([\d,]+)/i); mileage = m ? Number(m[1].replace(/,/g, "")) : null; }
  const labels = ["Mileage", "Engine", "Transmission", "Drivetrain", "Fuel Economy", "Exterior", "Interior", "VIN", "Stock #", "Stock", "Price"];
  let description = safeField(prod.description || $('meta[name="description"]').attr("content") || $(".vehicle-description,.description,[class*='description']").first().text());
  let features = [];
  $(".features li,.feature-list li,[class*='feature'] li").each((_, e) => { const x = clean($(e).text()); if (x && x.length < 200 && !features.includes(x) && !looksLikeJsonLeak(x)) features.push(x); });
  const engine = safeField(prod.vehicleEngine?.name) || safeField(valueAfter(text, "Engine", labels));
  const transmission = safeField(prod.vehicleTransmission) || safeField(valueAfter(text, "Transmission", labels));
  const drivetrainRaw = safeField(prod.driveWheelConfiguration) || safeField(valueAfter(text, "Drivetrain", labels));
  const drivetrain = drivetrainRaw.replace(/^https?:\/\/schema\.org\//i, "").replace(/Configuration$/i, "").replace(/([a-z])([A-Z])/g, "$1 $2");
  return {
    id: crypto.createHash("sha1").update(url).digest("hex").slice(0, 16),
    dealerId: dealer.id, title, year, make, model,
    bodyStyle: safeField(prod.bodyType) || safeField(valueAfter(text, "Body Style", labels)),
    price: Number(price) || null,
    mileage: Number(mileage) || null,
    engine, transmission, drivetrain,
    fuel: safeField(prod.fuelType || ""),
    fuelEconomy: safeField(valueAfter(text, "Fuel Economy", labels)),
    vin: safeField(prod.vehicleIdentificationNumber) || safeField(valueAfter(text, "VIN", labels)),
    stock: safeField(valueAfter(text, "Stock #", labels)) || safeField(valueAfter(text, "Stock", labels)),
    description, features: features.slice(0, 100),
    images: imageCandidates($, url),
    sourceUrl: url, source: dealer.name, status: "active", syncedAt: new Date().toISOString()
  };
}

async function discoverSitemaps(home, domains) {
  const maps = []; const seen = new Set();
  const queue = [new URL("/robots.txt", home).href, new URL("/sitemap.xml", home).href, new URL("/sitemap_index.xml", home).href];
  while (queue.length && seen.size < 30) {
    const u = queue.shift();
    if (seen.has(u) || !hostAllowed(u, domains)) continue;
    seen.add(u);
    try {
      const x = await fetchText(u, domains, home);
      if (u.endsWith("/robots.txt")) { for (const m of x.matchAll(/^\s*Sitemap:\s*(\S+)/gim)) queue.push(abs(u, m[1])); }
      else {
        const $ = cheerio.load(x, { xmlMode: true });
        $("loc").each((_, e) => { const v = abs(u, clean($(e).text())); if (hostAllowed(v, domains) && /sitemap/i.test(v)) queue.push(v); });
        maps.push(u);
      }
    } catch { /* sitemap not present */ }
  }
  return maps;
}

async function discoverVehicleUrls(dealer) {
  const domains = dealerDomains(dealer);
  const roots = [dealer.website, ...(dealer.locations || []).map(l => l.website).filter(Boolean)];
  const urls = new Set();
  for (const home of roots) {
    const maps = await discoverSitemaps(home, domains);
    for (const m of maps) {
      try {
        const x = await fetchText(m, domains, home); const $ = cheerio.load(x, { xmlMode: true });
        $("loc").each((_, e) => { const u = abs(m, clean($(e).text())); if (hostAllowed(u, domains) && (/\/details\//i.test(u) || /vehicle|inventory|cars-for-sale|used-cars|new-cars/i.test(u))) urls.add(u); });
      } catch { /* skip broken sitemap entry */ }
    }
    const queue = [home]; const seen = new Set();
    for (let pass = 0; queue.length && pass < 80; pass++) {
      const u = queue.shift();
      if (seen.has(u) || !hostAllowed(u, domains)) continue;
      seen.add(u);
      try {
        const h = await fetchText(u, domains, home); const $ = cheerio.load(h);
        $("a[href]").each((_, e) => {
          const v = abs(u, $(e).attr("href"));
          if (!hostAllowed(v, domains)) return;
          if (/\/details\//i.test(v) || /\/vehicle[-_/]|\/inventory\/|\/used[-_]cars|\/cars[-_]for[-_]sale/i.test(v)) urls.add(v);
          if (/page=|\/page\/|p=\d+|inventory|cars-for-sale|used-cars/i.test(v) && queue.length < 100) queue.push(v);
        });
      } catch { /* skip broken page */ }
    }
  }
  return [...urls].filter(u => !/\.(xml|pdf|jpg|jpeg|png|webp|css|js)(\?|$)/i.test(u)).slice(0, 1000);
}

async function notifyNewListings(newVehicles) {
  if (!webpush || !newVehicles.length) return;
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY, subj = process.env.VAPID_SUBJECT;
  if (!pub || !priv || !subj) return;
  webpush.setVapidDetails(subj, pub, priv);
  const d = ensure(read());
  const title = newVehicles.length === 1
    ? `New listing: ${newVehicles[0].title || "Vehicle"}`
    : `${newVehicles.length} new vehicles just listed`;
  const payload = JSON.stringify({ title, body: "Tap to see what's new on Official Cars.", url: "/#/cars" });
  const keep = [];
  for (const sub of d.pushSubscriptions) {
    try { await webpush.sendNotification(sub, payload); keep.push(sub); }
    catch (e) { if (e.statusCode !== 410 && e.statusCode !== 404) keep.push(sub); }
  }
  d.pushSubscriptions = keep;
  write(d);
}

async function syncDealer(dealer) {
  const urls = await discoverVehicleUrls(dealer);
  log(`${dealer.name}: discovered ${urls.length} candidate listing URLs.`);
  let d = ensure(read());
  const old = new Map((d.vehicles || []).filter(v => v.dealerId === dealer.id).map(v => [v.sourceUrl, v]));
  let ok = 0; const newlyAdded = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const h = await fetchText(urls[i], dealerDomains(dealer), dealer.website);
      const v = parseVehicle(urls[i], h, dealer);
      if (!v.title || (!v.price && !v.vin && !v.stock && v.images.length < 2)) continue;
      const existing = old.get(urls[i]);
      v.firstSeenAt = existing?.firstSeenAt || new Date().toISOString();
      if (!existing) newlyAdded.push(v);
      old.set(urls[i], v);
      ok++;
    } catch (e) { syncState.errors.push(`${dealer.name}: ${urls[i]} — ${e.message}`); }
    if (i % 8 === 0) await new Promise(r => setTimeout(r, 80));
  }
  d.vehicles = (d.vehicles || []).filter(v => v.dealerId !== dealer.id).concat([...old.values()]);
  dealer.lastSyncedAt = new Date().toISOString();
  dealer.lastSyncCount = ok;
  dealer.lastSyncImageCount = [...old.values()].reduce((n, v) => n + (v.images?.length || 0), 0);
  dealer.syncErrors = syncState.errors.filter(x => x.startsWith(dealer.name + ":")).length;
  d.dealers = d.dealers.map(x => x.id === dealer.id ? dealer : x);
  d.sourceMeta = { ...(d.sourceMeta || {}), lastSyncedAt: new Date().toISOString() };
  write(d);
  syncState.newListings += newlyAdded.length;
  notifyNewListings(newlyAdded).catch(() => {});
  return ok;
}

async function syncAll() {
  syncState = { running: true, startedAt: new Date().toISOString(), finishedAt: null, found: 0, imported: 0, newListings: 0, errors: [], log: [] };
  try {
    const d = ensure(read());
    for (const dealer of d.dealers.filter(x => x.enabled !== false)) {
      const n = await syncDealer(dealer);
      syncState.imported += n;
      syncState.found += dealer.lastSyncCount || 0;
    }
  } catch (e) { syncState.errors.push(e.message); log("FATAL " + e.message); }
  syncState.running = false;
  syncState.finishedAt = new Date().toISOString();
  log(`All dealer syncs complete · ${syncState.imported} records updated · ${syncState.newListings} brand-new listings.`);
}

function event(req, b) {
  try {
    const d = ensure(read());
    const type = String(b.type || "").slice(0, 40);
    if (!["page_view", "vehicle_view", "outbound_click", "search", "filter"].includes(type)) return;
    d.analytics.events.push({
      ts: new Date().toISOString(), type,
      vehicleId: String(b.vehicleId || "").slice(0, 80),
      dealerId: String(b.dealerId || "").slice(0, 80),
      page: String(b.page || "").slice(0, 120),
      filter: String(b.filter || "").slice(0, 500),
      session: hash(b.sessionId || crypto.randomUUID()),
      referrer: String(b.referrer || "").slice(0, 250)
    });
    if (d.analytics.events.length > 100000) d.analytics.events = d.analytics.events.slice(-100000);
    write(d);
  } catch { /* analytics must never break the request */ }
}

function startDate(q) {
  const now = new Date(); let d = new Date(now);
  if (q === "day") d.setHours(0, 0, 0, 0);
  else if (q === "week") { d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay()); }
  else if (q === "month") { d.setHours(0, 0, 0, 0); d.setDate(1); }
  else if (q === "year") { d.setHours(0, 0, 0, 0); d.setMonth(0, 1); }
  else d = new Date(0);
  return d;
}

function analytics(q) {
  const d = ensure(read());
  let ev = d.analytics.events.filter(e => new Date(e.ts) >= startDate(q.range || "month") && new Date(e.ts) <= new Date());
  if (q.dealerId) ev = ev.filter(e => e.dealerId === q.dealerId);
  if (q.vehicleId) ev = ev.filter(e => e.vehicleId === q.vehicleId);
  const views = ev.filter(e => e.type === "vehicle_view"), clicks = ev.filter(e => e.type === "outbound_click"), pages = ev.filter(e => e.type === "page_view");
  const m = {}; [...views, ...clicks].forEach(e => { if (e.vehicleId) m[e.vehicleId] = (m[e.vehicleId] || 0) + (e.type === "outbound_click" ? 3 : 1); });
  const vm = new Map(d.vehicles.map(v => [v.id, v]));
  const dm = new Map(d.dealers.map(x => [x.id, x]));
  const dealerClickCounts = {};
  clicks.forEach(e => { if (e.dealerId) dealerClickCounts[e.dealerId] = (dealerClickCounts[e.dealerId] || 0) + 1; });
  return {
    totalEvents: ev.length, pageViews: pages.length, vehicleViews: views.length, outboundClicks: clicks.length,
    uniqueSessions: new Set(ev.map(e => e.session)).size,
    hotVehicles: Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 100).map(([id, score]) => {
      const v = vm.get(id) || {}; const dl = dm.get(v.dealerId) || {};
      const title = v.title || [v.year, v.make, v.model].filter(Boolean).join(" ") || "Vehicle";
      return { id, title, dealerId: v.dealerId || "", dealerName: dl.name || "", views: views.filter(e => e.vehicleId === id).length, clicks: clicks.filter(e => e.vehicleId === id).length, score, price: v.price, sourceUrl: v.sourceUrl || "" };
    }),
    dealerClicks: Object.entries(dealerClickCounts).sort((a, b) => b[1] - a[1]).map(([id, count]) => ({ id, name: dm.get(id)?.name || "Unknown dealer", count }))
  };
}
function csv(x) { x = String(x ?? ""); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; }

app.get("/", (req, res) => res.send(`<html><head><meta name="viewport" content="width=device-width"><title>Official Cars API</title><style>body{margin:0;background:#06101d;color:#dff6ff;font:16px system-ui;display:grid;place-items:center;min-height:100vh}main{padding:42px;text-align:center;border:1px solid #2b8cff66;border-radius:26px;background:linear-gradient(145deg,#102a44,#07111e);box-shadow:0 30px 100px #0008}a{color:#72d8ff}</style></head><body><main><div style="font-size:44px">⚡</div><h1>Official Cars API</h1><p>Online · dealer sync · inventory · referral analytics</p><p><a href="/health">Health</a> · <a href="/admin">Control Center</a></p></main></body></html>`));

app.get("/health", (req, res) => res.json({ ok: true, service: "official-cars-api", version: "8.0", githubPersistence: GH_ENABLED, sync: syncState }));

function isLikelyListingUrl(u, dealer) {
  try {
    const x = new URL(u); const base = new URL(dealer.website);
    if (x.origin === base.origin && x.pathname.replace(/\/+$/, "") === (base.pathname.replace(/\/+$/, "") || "")) return false;
    if (/\/(cars-for-sale|inventory|used-cars|new-cars|vehicles?|cars?)\/?$/i.test(x.pathname)) return false;
    return /vehicle|inventory|details?|used|stock|vin|cars-for-sale|auto|listing|\d{4}/i.test(x.pathname + x.search);
  } catch { return false; }
}

app.get("/api/public", (req, res) => { const d = ensure(read()); res.json({ dealers: d.dealers, vehicles: d.vehicles, sourceMeta: d.sourceMeta || {}, newBadgeDays: NEW_BADGE_DAYS }); });

app.post("/api/track", (req, res) => { event(req, req.body || {}); res.status(204).end(); });

app.get("/go/:id", (req, res) => {
  const d = ensure(read()); const v = d.vehicles.find(x => x.id === req.params.id); const dl = d.dealers.find(x => x.id === v?.dealerId);
  const target = v?.sourceUrl || v?.url || "";
  if (!v || !dl || !target || !hostAllowed(target, dealerDomains(dl)) || !isLikelyListingUrl(target, dl)) return res.status(404).send("Vehicle listing unavailable");
  event(req, { type: "outbound_click", vehicleId: v.id, dealerId: v.dealerId, page: "vehicle", sessionId: req.query.s || "" });
  res.redirect(302, target);
});

// Image proxy: fixed to allow any public HTTPS image host (not just the dealer's own domain),
// since real dealer photos are almost always served from a third-party CDN.
app.get("/api/image", async (req, res) => {
  const u = String(req.query.url || "");
  if (!/^https:\/\//i.test(u)) return res.status(400).end();
  const host = hostOf(u);
  if (!(await isPublicHost(host))) return res.status(400).end();
  try {
    const r = await fetch(u, { headers: { "User-Agent": UA, Referer: originOf(u) } });
    if (!r.ok) return res.status(r.status).end();
    const ct = r.headers.get("content-type") || "image/jpeg";
    if (!ct.startsWith("image/")) return res.status(415).end();
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public,max-age=86400");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch { res.status(502).end(); }
});

app.post("/api/admin/login", (req, res) => { if (!ADMIN_SECRET || req.body?.password !== ADMIN_SECRET) return res.status(401).json({ error: "Invalid password" }); res.json({ token: token() }); });

app.get("/api/sync-status", auth, (req, res) => res.json(syncState));
app.post("/api/admin/sync", auth, (req, res) => { if (!syncState.running) syncAll(); res.json({ ok: true, status: syncState }); });
app.get("/api/admin/analytics", auth, (req, res) => res.json({ range: req.query.range || "month", summary: analytics(req.query) }));

app.get("/api/admin/analytics.csv", auth, (req, res) => {
  const d = ensure(read()); const q = req.query; const start = startDate(q.range || "month");
  let ev = d.analytics.events.filter(e => new Date(e.ts) >= start && new Date(e.ts) <= new Date());
  if (q.dealerId) ev = ev.filter(e => e.dealerId === q.dealerId);
  if (q.vehicleId) ev = ev.filter(e => e.vehicleId === q.vehicleId);
  const rows = ["timestamp,event,vehicle_id,dealer_id,page,filter,session_hash,referrer"];
  ev.forEach(e => rows.push([e.ts, e.type, e.vehicleId, e.dealerId, e.page, e.filter, e.session, e.referrer].map(csv).join(",")));
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=official-cars-analytics.csv");
  res.send(rows.join("\n"));
});

app.get("/api/admin/export", auth, (req, res) => res.json(read()));
app.post("/api/admin/save", auth, (req, res) => { if (!req.body || !Array.isArray(req.body.dealers) || !Array.isArray(req.body.vehicles)) return res.status(400).json({ error: "Invalid data" }); write(ensure(req.body)); res.json({ ok: true }); });

app.post("/api/admin/add-dealer", auth, async (req, res) => {
  try {
    const raw = String(req.body?.url || "").trim();
    if (!/^https:\/\//i.test(raw)) return res.status(400).json({ error: "Enter the dealer's HTTPS website URL." });
    let u = new URL(raw);
    if (!(await isPublicHost(u.hostname))) return res.status(400).json({ error: "That website host could not be verified as a public website." });
    u = new URL("/", u.origin);
    const website = u.href;
    const d = ensure(read());
    const domains = [u.hostname.toLowerCase()];
    const { info, homeHtml } = await discoverBusinessInfo(website, domains);
    const locations = await discoverLocations({ id: "tmp", name: info.name, website, allowedDomains: domains, locations: [] }, homeHtml);
    if (info.address) { const g = await geocode(info.address); if (g) { info.lat = g.lat; info.lng = g.lng; } }
    for (const loc of locations) { const g = await geocode(loc.address); if (g) { loc.lat = g.lat; loc.lng = g.lng; } }
    const id = crypto.createHash("sha1").update(u.origin).digest("hex").slice(0, 12);
    const dealer = {
      id: "dealer-" + id, name: info.name || u.hostname, address: info.address || "", phone: info.phone || "",
      website, logo: info.logo || "", social: info.social || [], allowedDomains: domains,
      lat: info.lat ?? null, lng: info.lng ?? null,
      locations: locations.length > 1 ? locations : [],
      enabled: true, createdAt: new Date().toISOString(), lastSyncedAt: null, lastSyncCount: 0, syncErrors: 0
    };
    const idx = d.dealers.findIndex(x => x.id === dealer.id);
    if (idx >= 0) d.dealers[idx] = { ...d.dealers[idx], ...dealer }; else d.dealers.push(dealer);
    write(d);
    res.json({ ok: true, dealer });
  } catch (e) { res.status(400).json({ error: "Could not read that website: " + e.message }); }
});

app.post("/api/admin/sync-dealer", auth, (req, res) => {
  const d = ensure(read()); const dealer = d.dealers.find(x => x.id === req.body?.dealerId);
  if (!dealer) return res.status(404).json({ error: "Dealer not found" });
  if (syncState.running) return res.status(409).json({ error: "Another sync is already running" });
  syncState = { running: true, startedAt: new Date().toISOString(), finishedAt: null, found: 0, imported: 0, newListings: 0, errors: [], log: [] };
  syncDealer(dealer).then(n => {
    syncState.imported = n; syncState.found = n; syncState.running = false; syncState.finishedAt = new Date().toISOString();
    log(`Dealer sync complete · ${n} vehicles · ${syncState.newListings} brand-new.`);
  }).catch(e => { syncState.errors.push(e.message); syncState.running = false; syncState.finishedAt = new Date().toISOString(); log("FATAL " + e.message); });
  res.json({ ok: true });
});

app.post("/api/admin/refresh-locations", auth, async (req, res) => {
  try {
    const d = ensure(read()); const dealer = d.dealers.find(x => x.id === req.body?.dealerId);
    if (!dealer) return res.status(404).json({ error: "Dealer not found" });
    const html = await fetchText(dealer.website, dealerDomains(dealer), dealer.website);
    const locations = await discoverLocations(dealer, html);
    for (const loc of locations) { if (!loc.lat) { const g = await geocode(loc.address); if (g) { loc.lat = g.lat; loc.lng = g.lng; } } }
    if (!dealer.lat && dealer.address) { const g = await geocode(dealer.address); if (g) { dealer.lat = g.lat; dealer.lng = g.lng; } }
    dealer.locations = locations;
    d.dealers = d.dealers.map(x => x.id === dealer.id ? dealer : x);
    write(d);
    res.json({ ok: true, dealer });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete("/api/admin/dealer/:id", auth, (req, res) => { const d = ensure(read()); d.dealers = d.dealers.filter(x => x.id !== req.params.id); d.vehicles = d.vehicles.filter(x => x.dealerId !== req.params.id); write(d); res.json({ ok: true }); });

app.get("/api/admin/source/:id", auth, (req, res) => {
  const d = ensure(read()); const v = d.vehicles.find(x => x.id === req.params.id); const dl = d.dealers.find(x => x.id === v?.dealerId); const target = v?.sourceUrl || v?.url || "";
  if (!v || !dl || !target || !hostAllowed(target, dealerDomains(dl))) return res.status(404).json({ error: "Source listing unavailable" });
  res.json({ ok: true, url: target, dealer: { id: dl.id, name: dl.name, website: dl.website } });
});

// ---- Web Push (Android + desktop Chrome/Edge + iOS 16.4+ installed PWAs) ----
app.get("/api/push/vapid-public-key", (req, res) => res.json({ key: process.env.VAPID_PUBLIC_KEY || "" }));
app.post("/api/push/subscribe", (req, res) => {
  try {
    const sub = req.body?.subscription;
    if (!sub?.endpoint) return res.status(400).json({ error: "Invalid subscription" });
    const d = ensure(read());
    if (!d.pushSubscriptions.some(s => s.endpoint === sub.endpoint)) d.pushSubscriptions.push(sub);
    write(d);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/push/unsubscribe", (req, res) => {
  try {
    const endpoint = req.body?.endpoint; const d = ensure(read());
    d.pushSubscriptions = d.pushSubscriptions.filter(s => s.endpoint !== endpoint);
    write(d); res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "admin.html")));

(async function boot() {
  if (GH_ENABLED) {
    const remote = await ghPull();
    if (remote) { try { fs.writeFileSync(DB, remote); console.log("Loaded data.json from GitHub (" + GH_REPO + ")"); } catch (e) { console.warn("Could not write pulled data locally:", e.message); } }
    else console.log("No existing data.json found on GitHub yet — will create one on first write.");
  }
  ensure(read());
  app.listen(PORT, "0.0.0.0", () => console.log("Official Cars API v8 listening on " + PORT + (GH_ENABLED ? " (GitHub persistence ON)" : " (GitHub persistence OFF — set GITHUB_TOKEN/GITHUB_REPO to enable)")));
})();
