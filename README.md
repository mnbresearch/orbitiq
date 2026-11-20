# OrbitIQ — Space Traffic Intelligence

**Live:** [orbit.mnbresearch.com](https://orbit.mnbresearch.com) · [API docs](https://orbit.mnbresearch.com/docs.html) · [Status](https://orbit.mnbresearch.com/status.html)

OrbitIQ turns free public orbital data into screening-grade space traffic intelligence: a live 3D picture of the sky, conjunction screening with collision probability, fleet risk scoring, maneuver and anomaly detection, re-entry projection, ground-network contact planning, and a compounding detection archive — all running on zero-cost infrastructure.

## What it does

**Operations.** Live 3D globe tracking thousands of objects via SGP4, org pairing (scope everything to one operator), a time machine to scrub the whole sky ±6 h, aurora ovals during geomagnetic storms, launch feeds, and a command palette (⌘K).

**Autonomous AI Copilot (v16).** Multi-agent space operations powered by xAI Grok, OpenAI, Gemini, or deterministic aerospace heuristics. Includes real-time Flight Safety Officer (FSO) triage with NOAA Kp atmospheric drag expansion modeling, Tsiolkovsky propellant mass optimization (grams of fuel per avoidance burn), secondary collision pre-screening, automated FCC 47 CFR § 25.114 / ISO 24113 proof-of-diligence drafting, and an in-console tactical natural language assistant. Everything runs at $0 with zero paid integrations.

**Screening & safety.** Coarse-to-fine conjunction screening with 3D spatial hashing, TCA refinement, 2-D collision probability with TLE-age-scaled covariance, background scans per workspace, webhooks and WebSocket alert push.

**Intelligence (the moat).** Every detection — conjunction, maneuver, pattern-of-life anomaly, fleet risk score, re-entry candidate, space-weather snapshot — is appended to a timestamped ledger at detection time. This history cannot be reconstructed from public data later; it compounds every day the platform runs. On top of it: Fleet Risk Index with grades, weekly fleet intelligence reports with public shareable links (`/r/{token}`), daily trend analytics, and constellation architecture analysis (altitude shells, RAAN plane occupancy, inclination families).

**Network ops.** Multi-station contact planning across a 10-station global ground network (total contact time, coverage %, longest blackout), pro pass prediction with Doppler and optical visibility, eclipse windows, ephemeris CSV export.

## Subscription tiers

| Plan (plan id) | Price | Daily calls | Unlocks |
|---|---|---|---|
| Observer (`free`) | invitation only | 200 | live catalogue, global screening feed, re-entry watch, space weather |
| Operator (`tracker`) | $2,500 / month | 2,000 | fleet-scoped screening and risk ranking, Pc per encounter, contact planning, pro passes + Doppler, ephemeris export, alerts |
| Constellation (`operator`) | $9,000 / month | 20,000 | constellation analytics, full archive and trend history, manoeuvre and anomaly detection, reports + share links, premium exports |
| Underwriter (`verifier`) | bespoke, per portfolio | — | independent verification of Proof of Diligence across operators who grant access |
| Institutional | bespoke | custom | dedicated instance, private catalogue ingestion, named support |

The plan ids are historical (`tracker` is sold as Operator, `operator` as Constellation); the source of truth for names and prices is `PLAN_CATALOG` in `src/store.js`, which the landing page reads from `/api/plans`.

Plans are enforced server-side (402 gates + per-key metering + anonymous IP rate limiting). Activation: `POST /api/admin/workspaces/{id}/plan`.

## Architecture

```
GitHub Actions (every 6 h)                    Render (free tier)
┌──────────────────────────┐    raw.githubusercontent
│ fetch CelesTrak + NOAA   │──► data-mirror branch ──► Node/Express + ws
│ validate, force-push     │                           │  SGP4 screening engine
└──────────────────────────┘                           │  intelligence sweeps (6 h)
                                                       │  append-only ledger
        data-backup branch ◄── archive backup ─────────┘
        (restored on every boot — survives redeploys)
```

- **Data pipeline:** CelesTrak/NOAA block many datacenter IPs, so a scheduled Action mirrors them into this repo; the server falls back `live → mirror → cache → sample` and reports provenance at `/api/status`.
- **Archive persistence:** with `ORBITIQ_GH_TOKEN` set, the ledger + workspace store are committed to a flat `data-backup` branch after every sweep and restored on boot.
- **Stack:** Node/Express, `ws`, satellite.js 7 (self-hosted, import maps), three.js (self-hosted), vanilla JS frontend — no build step, no framework, no paid services.

## Self-hosting

```bash
npm install && node server.js        # http://localhost:3000
```

| Env var | Purpose |
|---|---|
| `ORBITIQ_ADMIN_KEY` | stable admin API key (else printed once at boot) |
| `ORBITIQ_GH_TOKEN` | fine-grained token (Contents RW) → archive persistence |
| `ORBITIQ_MIRROR_BASE` | override the data-mirror URL |
| `GROK_API_KEY` / `XAI_API_KEY` | (optional) xAI Grok model key for AI Copilot |
| `OPENAI_API_KEY` | (optional) OpenAI model key / endpoint |
| `GEMINI_API_KEY` | (optional) Google Gemini model key |
| `PORT` | listen port |

Deploy: `render.yaml` (Blueprint), `Dockerfile`, `fly.toml` included. Enable the **Data mirror** workflow in Actions and run it once to seed live data.

## API quickstart

```bash
curl https://orbit.mnbresearch.com/api/v1/satellites?org=spacex&limit=3
curl -X POST https://orbit.mnbresearch.com/api/v1/workspaces \
  -H "Content-Type: application/json" -d '{"name":"My Ops","org":"spacex"}'
# → returns your oiq_ API key (shown once)
curl https://orbit.mnbresearch.com/api/v1/intel/fleet-risk?org=spacex -H "X-API-Key: oiq_…"
```

Full reference: [/docs.html](https://orbit.mnbresearch.com/docs.html)

## Data honesty

Positions derive from public GP elements (km-level uncertainty). OrbitIQ is built for monitoring, screening and triage — not operational collision avoidance. Sources: CelesTrak, NOAA SWPC, The Space Devs.

---
© MNB Research. Built for the price of exactly zero dollars.
