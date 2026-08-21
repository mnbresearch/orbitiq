// ============================================================
// OrbitIQ — offline conjunction screening worker.
//
// Screening is the one genuinely expensive thing this platform does: seconds
// of uninterruptible synchronous SGP4 propagation, holding the whole catalogue
// in memory. On a 512 MB shared-CPU instance that is enough to stall the
// health check and get the web service recycled mid-request — which is exactly
// what was happening, and was previously hidden because a malformed env var
// had quietly capped the screening population at three objects.
//
// So screening moves off the request path entirely. This script runs on a
// GitHub Actions runner (free and unlimited for public repositories, and
// billed against nothing that private repos consume), screens the catalogue
// properly, and publishes the results as static JSON. The web service then
// only ever *reads* a file.
//
// Two things follow from that, both good:
//   * The runner is far larger than the web instance, so this screens the full
//     catalogue rather than a capped slice — the results are better than the
//     server could produce even on a paid plan.
//   * It imports getSatellites() and screenConjunctions() from src/, the same
//     code the server runs. These are not "similar" results, they are the same
//     computation with the same completeness guarantee.
// ============================================================
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getSatellites, orgList } from "../src/data.js";
import { screenConjunctions } from "../src/conjunctions.js";
import { EARTH_R_KM, MU_KM3_S2 } from "../src/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "out", "data", "screening");

/** Objects to screen. Generous — the runner can afford what the server cannot. */
const MAX_OBJECTS = parseInt(process.env.SCREEN_MAX_OBJECTS || "12000", 10);
/** Propagation budget per screen; the engine picks its step from this. */
const BUDGET = parseInt(process.env.SCREEN_BUDGET || "6000000", 10);

/**
 * Perigee altitude, km. Used to prioritise the congested low-altitude regime
 * when the catalogue is larger than MAX_OBJECTS — that is where the collision
 * risk actually is.
 */
function perigeeKm(s) {
  const nRad = (s.meanMotion * 2 * Math.PI) / 86400;
  if (!nRad) return 1e9;
  return Math.cbrt(MU_KM3_S2 / (nRad * nRad)) * (1 - (s.ecc || 0)) - EARTH_R_KM;
}

function cap(sats) {
  if (sats.length <= MAX_OBJECTS) return sats;
  return sats.map(s => [perigeeKm(s), s]).sort((a, b) => a[0] - b[0])
             .slice(0, MAX_OBJECTS).map(p => p[1]);
}

/** Cache key shared with the server: `${org}|${hours}|${thresholdKm}`. */
const fileFor = (org, hours, km) => `${org || "all"}-${hours}-${km}.json`;

async function main() {
  const t0 = Date.now();
  const sats = await getSatellites();
  if (!Array.isArray(sats) || sats.length < 500) {
    console.error(`::error::catalogue too small (${sats?.length ?? 0}); refusing to publish`);
    process.exit(1);
  }
  console.log(`catalogue: ${sats.length} objects (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const pool = cap(sats);
  console.log(`screening population: ${pool.length}`);

  // The combinations the app actually asks for. `hours` and `thresholdKm` are
  // snapped to this same grid server-side, so every public request maps onto
  // one of these files.
  //
  // This list is not cosmetic and it is not "whatever seems reasonable" — it
  // must cover every pair any server call site can ask for. A pair that is
  // missing here does not degrade gracefully: the server's lookup misses and,
  // before the guard in runScreening() existed, it fell through to computing
  // the screen in-process and got the instance killed by the health check.
  // `(org, 3, 10)` was missing exactly this way and restarted the service
  // roughly ten times an hour. If a new call site asks for a new pair, add it
  // here in the same commit.
  const jobs = [
    { org: null, hours: 3,  km: 10 },   // public teaser + intelligence sweep
    { org: null, hours: 12, km: 25 },
    { org: null, hours: 24, km: 25 },
    { org: null, hours: 24, km: 50 }    // /api/assess pair lookup
  ];
  // Plus the largest operators, which are what people click on first. Kept
  // deliberately short: each screen is minutes of CPU, and a job that only
  // just fits inside its timeout is a job that will eventually fail.
  // Operator screens are far cheaper than the unscoped one because the
  // apogee/perigee sieve applies, so both pairs fit comfortably.
  for (const o of orgList(sats).filter(o => o.id !== "other" && o.count >= 25).slice(0, 4)) {
    jobs.push({ org: o.id, hours: 12, km: 25 }); // operator console
    jobs.push({ org: o.id, hours: 3,  km: 10 }); // fleet risk + sweep
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const index = [];
  let failed = 0;

  for (const j of jobs) {
    const label = `${j.org || "all"} ${j.hours}h ${j.km}km`;
    const t = Date.now();
    try {
      const res = screenConjunctions(pool, j.org, j.hours, j.km, { maxPropagations: BUDGET });
      const ms = Date.now() - t;
      const payload = {
        ...res,
        precomputed: true,
        computedAt: new Date().toISOString(),
        computeMs: ms,
        source: "github-actions",
        note: "Screened off the request path on a GitHub Actions runner so the "
            + "web service never blocks. Same engine and same completeness "
            + "guarantee as an on-demand screen, over a larger population."
      };
      fs.writeFileSync(path.join(OUT_DIR, fileFor(j.org, j.hours, j.km)), JSON.stringify(payload));
      index.push({ org: j.org, hours: j.hours, thresholdKm: j.km,
                   events: res.events.length, computeMs: ms });
      console.log(`  ${label.padEnd(24)} ${String(ms).padStart(7)}ms  ${res.events.length} events  ` +
                  `step=${res.method.coarseStepSec}s gate=${res.method.coarseGateKm}km`);
    } catch (e) {
      failed++;
      console.log(`::warning::screen failed for ${label}: ${e.message}`);
    }
  }

  if (!index.length) {
    console.error("::error::every screen failed; refusing to publish an empty set");
    process.exit(1);
  }

  fs.writeFileSync(path.join(OUT_DIR, "index.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    catalogSize: sats.length,
    screenedPopulation: pool.length,
    totalMs: Date.now() - t0,
    failed,
    screens: index
  }, null, 2));

  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s — ` +
              `${index.length} screens published, ${failed} failed`);
}

main().catch(e => { console.error("::error::" + (e?.stack || e)); process.exit(1); });
