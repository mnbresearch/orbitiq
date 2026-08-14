# OrbitIQ — Space Traffic Intelligence Platform (v3)

Live satellite tracking, conjunction screening with a multi-tenant alerting engine, launch intelligence, maneuver detection, orbital congestion analytics, mission design tools, and a public REST + WebSocket API. Built entirely on free public data. Runs for $0. See `LAUNCH.md` for the zero-cost launch playbook and `/docs.html` for API docs.

## What's new in v3

**Workspaces (multi-tenant SaaS core).** Create a workspace bound to an operator and get an API key that scopes every call. Per-key daily usage metering. The UI stores your key locally and turns into that organization's console.

**Alerting engine.** A background scanner screens every workspace's fleet for close approaches every 30 minutes, deduplicates events into a per-workspace alert inbox, pushes them live over WebSocket, fires browser notifications, and POSTs to your webhook if configured.

**Maneuver detection.** Epoch-over-epoch element comparison flags orbit raises, lowers, plane changes and stationkeeping across the catalog — the same signal commercial SSA providers sell.

**Traffic & congestion view.** LEO shell occupancy in 25 km bins with load tiers, dominant operator per shell, and most-congested-shell reporting.

**Mission design tools.** Hohmann transfer planner (with combined plane change) and a launch-site feasibility planner (azimuths, first-order Δv from each of 12 global sites). CSV exports of the catalog and screening results.

**Command palette (Ctrl+K)**, keyboard shortcuts (1–5 for views), API docs page, WebSocket live feed, daily population snapshots for trend history.

## Features

**Mission-control UI.** Animated splash screen, glassmorphism panels, live ticker, toast alerts, hover tooltips, glowing additive-blended satellite rendering, day/night Earth shader with real Blue Marble + night-lights imagery (procedural fallback when offline), sun-synchronized lighting and terminator, camera inertia with fly-to easing, and staggered entrance animations throughout.

**Three workspaces.** Operations (the live 3D picture), Analytics (population dashboards: altitude histogram, top operators, launch-year trend, inclination distribution — all computed live from the catalog), and Catalog (sortable, searchable table of every tracked object; click any row to fly to it).

**Per-object intelligence.** Selecting a satellite opens a detail drawer with live state vector, orbital elements, a ground-track mini-map, a 48-hour ground pass predictor for any observer location (with geolocation), and a persistent watchlist.

**Live 3D orbital picture.** Interactive globe rendering the full active satellite catalog (~11,000+ objects from CelesTrak, refreshed every 6 hours), propagated in real time with SGP4. Drag to rotate, scroll to zoom, click any satellite for live altitude, velocity, position, and orbital elements plus its full orbit trail. Time acceleration up to 3600×.

**Organization pairing.** Select an operator (SpaceX/Starlink, OneWeb, Iridium, GPS, Galileo, ISRO, Planet, Spire, crewed stations, weather agencies, debris, and more) and the entire platform scopes to that fleet — highlighting, screening, and search all follow the selected organization.

**Conjunction screening.** On-demand close-approach screening: coarse SGP4 sweep with 3D spatial hashing, refined to 2-second resolution around each candidate's time of closest approach. Reports miss distance, relative velocity, altitude, and a risk tier. Screen one operator's fleet against the whole catalog, or all-vs-all.

**Launch intelligence.** Upcoming and recent launches worldwide from Launch Library 2 (provider, pad, mission, orbit, status), refreshed hourly. Major launch sites are marked on the globe and rotate with the Earth.

**Re-entry / decay watch.** Continuously lists the lowest-perigee objects in the catalog — the population most likely to re-enter.

**Resilient by design.** All external data is cached on disk; if sources are unreachable the platform serves the last good data, then falls back to a bundled sample catalog. No API keys required anywhere.

## Run locally (free)

```bash
npm install
npm start
# open http://localhost:3000
```

Requires Node 18+. First load fetches the live catalog from CelesTrak (a few MB); subsequent loads are cached.

## Deploy for $0

**Render (recommended, one click):** push this folder to a GitHub repo, then in render.com choose "New → Blueprint" and point it at the repo — `render.yaml` configures the free tier automatically. Free instances sleep after inactivity and wake on request.

**Railway / Fly.io / any Docker host:** a `Dockerfile` is included; `docker build -t orbitiq . && docker run -p 3000:3000 orbitiq`.

## API

| Endpoint | Description |
|---|---|
| `GET /api/satellites?org=&q=&limit=` | Catalog with GP elements, filterable by org/search |
| `GET /api/organizations` | Operators detected in the catalog with counts |
| `GET /api/conjunctions?org=&hours=&thresholdKm=` | Close-approach screening (cached 15 min) |
| `GET /api/launches` | Upcoming + recent launches |
| `GET /api/events` | Space events feed (dockings, EVAs, tests) |
| `GET /api/recent-objects` | Newest objects in orbit by intl designator |
| `GET /api/passes?satId=&lat=&lon=` | 48 h ground pass prediction for an observer |
| `GET /api/analytics` | Population analytics (histograms, trends) |
| `GET /api/decay-watch` | Lowest-perigee objects (re-entry risk) |
| `GET /api/stats` | Catalog totals by type and orbital regime |
| `GET /api/health` | Health check |

## Data sources (all free)

- CelesTrak GP orbital data — https://celestrak.org (updated several times daily)
- Launch Library 2 by The Space Devs — https://thespacedevs.com (free tier)
- SGP4 propagation via satellite.js; rendering via three.js (both self-hosted, no CDN)

## Honest limits

This is a situational-awareness and screening tool. Conjunction results use public GP elements, which carry km-level position uncertainty — they are suitable for monitoring and triage, not for operational collision-avoidance decisions (operators use higher-precision ephemerides and CDMs from Space-Track/commercial SSA providers for that). A commercial version would layer in Space-Track accounts, operator ephemeris exchange, covariance-based probability of collision, and alerting.

## Roadmap ideas (toward a commercial product)

Per-organization accounts with private ephemeris upload; email/webhook conjunction alerts; probability-of-collision (Pc) with covariance; maneuver planning suggestions; ground-station pass scheduling; historical conjunction analytics; SLA'd API tiers.
