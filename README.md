# Official Cars V10 — Production Control

Deploy this folder as the Render backend. Set:
- ADMIN_SECRET
- ANALYTICS_SALT
- GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH, GITHUB_DATA_PATH for persistent data
- VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT for web push

V10 improvements:
- Reliable exact dealer listing links from GitHub Pages
- Vehicle-name-first analytics with 30-minute page/dealer view deduplication
- Robust multi-location/state/city normalization and geocoding
- Bounded, timeout-protected sync workers with stale-sync recovery
- Better vehicle image discovery, excluding storefront/social/brand imagery
- Preserves good photos when a later sync temporarily misses them
- Detailed vehicle fields and location association
- Persistent GitHub snapshots without overwriting analytics recorded during sync
- Authorized image-host support

Important: website synchronization is for participating/authorized dealer sources. A crawler cannot legally or technically guarantee access to JavaScript-only, blocked, login-gated, or feed-only inventory. For those partners, use their authorized API/XML/CSV/feed.
