# OrbitIQ — $0 Launch Playbook

Everything below is free. Total time to live URL: roughly 20 minutes.

## 1. Put the code on GitHub (free)

Create an account at github.com if you don't have one, create a new repository named `orbitiq`, then from this folder:

```bash
git init
git add .
git commit -m "OrbitIQ v3 — space traffic intelligence platform"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/orbitiq.git
git push -u origin main
```

(`.gitignore` already excludes node_modules and cache.)

## 2. Deploy on Render (free web service)

Go to render.com → sign in with GitHub → New → Blueprint → select your `orbitiq` repo. The included `render.yaml` configures everything (free plan, health check, start command). In ~3 minutes you get a public URL like `https://orbitiq.onrender.com`.

Notes on the free tier: the instance sleeps after ~15 minutes of no traffic and wakes on the next request (first hit takes ~30 s). The disk is ephemeral — workspaces/alerts reset on redeploys. That's fine for a launch demo; when real users arrive, Render's paid disk or a free Postgres (Neon, Supabase) is the upgrade path.

Alternative free hosts: Railway (trial), Fly.io (`fly launch` — a `Dockerfile` is included), Google Cloud Run free tier.

## 3. Keep it awake (free, optional)

uptimerobot.com free plan → add an HTTP monitor pointed at `https://YOUR-URL/api/health` every 5 minutes. This both keeps the instance warm and gives you uptime monitoring.

## 4. Domain (free options)

The `.onrender.com` URL works fine to start. If you own a domain, Render custom domains are free with automatic TLS. Free-subdomain services exist but look less credible than the onrender.com default — skip them.

## 5. Tell the world (free)

Where products like this get their first users: Product Hunt launch (free), Show HN post on news.ycombinator.com ("Show HN: OrbitIQ – open space-traffic intelligence with live conjunction screening"), r/space and r/satellites on Reddit, and space-industry LinkedIn. Lead with the live demo URL and one concrete capability ("screen any operator's fleet for close approaches in your browser").

## 6. First-customer motion (free)

The buyers for SSA tooling are smallsat operators, universities with cubesats, and insurers. The free hook: create a workspace for a university cubesat team, bind it to their object, give them the API key, and let the 30-minute background scans + webhook alerts run. That's a real pilot deployment at $0.

## What the free stack gives you

Render free web service + CelesTrak/The Space Devs data (free) + self-hosted three.js/satellite.js (no CDN fees) + UptimeRobot monitoring = a live, multi-tenant, real-time SSA platform with a public API, at exactly $0/month.

## Honest scaling notes

One free instance handles demo and pilot traffic comfortably (the catalog is cached in memory; screening is the only heavy operation and it's cached 15 min). The first real money should go to: persistent database for workspaces/alerts, a Space-Track.org account integration (free account, better data), and email alerting (Resend/Postmark free tiers).
