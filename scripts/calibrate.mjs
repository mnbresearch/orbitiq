// ============================================================
// Covariance calibration worker.
//
// Runs in GitHub Actions, not in the web process. Two reasons, and the second
// is the real one:
//
//   1. It propagates thousands of element-set pairs, which is exactly the kind
//      of uninterruptible CPU burst that gets a 512 MB shared instance
//      recycled mid-request.
//   2. It needs HISTORY. The data mirror is force-pushed flat by design, so
//      yesterday's catalogue does not exist anywhere once today's lands. This
//      job keeps a small rolling set of daily snapshots on its own branch,
//      which is the only reason a calibration is possible at all.
//
// The snapshots are the asset here. Element sets are public and free today,
// but a record of what they SAID on each past day is not something you can go
// and fetch later — CelesTrak serves current elements, not an archive. Every
// day this runs, the window of measurable lags gets one day deeper, and that
// is not a thing a competitor can catch up on by writing code faster.
// ============================================================
import fs from "node:fs";
import path from "node:path";
import * as covcal from "../src/covcal.js";

const OUT = "out/data/calibration";
const SNAP_DIR = path.join(OUT, "snapshots");
const PRIOR = process.env.CALIBRATION_PRIOR || "prior/snapshots";
const MIRROR = process.env.ORBITIQ_MIRROR_BASE
  || "https://raw.githubusercontent.com/mnbresearch/orbitiq/data-mirror/data/live";

// How many daily snapshots to keep. Fourteen bounds the branch at a few
// megabytes and covers the operational range: a conjunction warning at T-6h is
// screened against element sets hours to a few days old, and beyond two weeks
// the population is dominated by objects nobody is tasking often — which is a
// fact about sensor priorities, not about propagation error.
const KEEP_DAYS = 14;

// Deterministic subsample. It must be DETERMINISTIC and it must be the SAME
// objects every day, because a pair needs one object observed on two dates —
// a fresh random sample each day would share almost nothing with yesterday's
// and produce no pairs at all. Modulo on the catalogue number is stable,
// needs no state, and is uncorrelated with orbit regime.
const SAMPLE_MODULO = Number(process.env.CALIBRATION_MODULO || 5);

const KEEP_FIELDS = [
  "OBJECT_NAME", "NORAD_CAT_ID", "OBJECT_TYPE", "EPOCH", "MEAN_MOTION", "ECCENTRICITY",
  "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY", "BSTAR",
  "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT", "EPHEMERIS_TYPE", "CLASSIFICATION_TYPE",
  "ELEMENT_SET_NO", "REV_AT_EPOCH"
];

const slim = gp => Object.fromEntries(KEEP_FIELDS.filter(k => gp[k] !== undefined).map(k => [k, gp[k]]));

async function fetchCatalogue() {
  // A local file, for CI and for working offline. Without this the only way to
  // exercise this script is to run it against the live mirror, which means the
  // first time anyone finds out it is broken is in production.
  const local = process.env.CALIBRATION_CATALOGUE_FILE;
  if (local) {
    const rows = JSON.parse(fs.readFileSync(local, "utf8"));
    console.log(`catalogue from ${local}`);
    return rows;
  }
  const url = `${MIRROR}/active.json`;
  const res = await fetch(url, { headers: { "User-Agent": "OrbitIQ-calibration/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length < 1000) {
    throw new Error(`catalogue looks wrong: ${Array.isArray(rows) ? rows.length : typeof rows}`);
  }
  return rows;
}

function loadPriorSnapshots() {
  if (!fs.existsSync(PRIOR)) return [];
  return fs.readdirSync(PRIOR)
    .filter(f => f.endsWith(".json"))
    .sort()
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(PRIOR, f), "utf8")); }
      catch { console.warn(`::warning::unreadable snapshot ${f}, skipping`); return null; }
    })
    .filter(Boolean);
}

const main = async () => {
  fs.mkdirSync(SNAP_DIR, { recursive: true });

  const rows = await fetchCatalogue();
  const sampled = rows.filter(r => Number(r.NORAD_CAT_ID) % SAMPLE_MODULO === 0);
  const today = {
    at: new Date().toISOString(),
    source: "celestrak active via data-mirror",
    sampleModulo: SAMPLE_MODULO,
    catalogueSize: rows.length,
    byId: Object.fromEntries(sampled.map(r => [String(r.NORAD_CAT_ID), slim(r)]))
  };
  console.log(`catalogue ${rows.length}, sampled ${sampled.length} (1 in ${SAMPLE_MODULO})`);

  // Prior snapshots, oldest first, then today. Deduplicate by calendar day so
  // a manual re-run does not stack two snapshots of the same catalogue and
  // create a swarm of zero-lag pairs.
  const prior = loadPriorSnapshots();
  const byDay = new Map();
  for (const s of [...prior, today]) byDay.set(String(s.at).slice(0, 10), s);
  const snapshots = [...byDay.values()]
    .sort((a, b) => new Date(a.at) - new Date(b.at))
    .slice(-KEEP_DAYS);

  console.log(`snapshots retained: ${snapshots.length} (${snapshots[0]?.at?.slice(0, 10)} .. ${snapshots.at(-1)?.at?.slice(0, 10)})`);

  for (const s of snapshots) {
    fs.writeFileSync(path.join(SNAP_DIR, `${String(s.at).slice(0, 10)}.json`), JSON.stringify(s));
  }

  const t0 = Date.now();
  const cal = covcal.build(snapshots);
  cal.computeMs = Date.now() - t0;
  cal.catalogueSize = rows.length;
  cal.sampleModulo = SAMPLE_MODULO;

  // A calibration built from one snapshot has no pairs and would publish
  // empty fits, which downstream would read as "no floor" — correct, but it
  // should say so loudly rather than look like a successful run.
  const enoughPairs = cal.pairsUsable >= 200 && Object.keys(cal.byKind).length > 0;
  cal.usable = enoughPairs && cal.plausible;
  if (!cal.usable) {
    cal.notUsableBecause = !enoughPairs
      ? `only ${cal.pairsUsable} usable pairs from ${snapshots.length} snapshot(s). `
        + "A calibration needs several days of history before it can say anything; until then "
        + "the modelled covariance stands unmodified, which is the safe default."
      : "the fitted values are outside what element-set disagreement can plausibly be, so this "
        + "run is not measuring what it is supposed to measure: "
        + cal.implausibleReasons.join("; ")
        + ". Rejected in full rather than clamped, because a fit that came out this wrong is "
        + "not trustworthy just below the ceiling either.";
    console.log(`::warning::${cal.notUsableBecause}`);
  }

  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(cal, null, 1));

  for (const [kind, k] of Object.entries(cal.byKind)) {
    const f = k.fit?.sigmaI;
    console.log(`${kind}: ${k.pairs} pairs, ${k.bins.length} bins`
      + (f ? `, in-track sigma = ${f.a} + ${f.b}/day` : ", no fit"));
  }
  console.log(`usable=${cal.usable} pairs=${cal.pairsUsable}/${cal.pairsAttempted} in ${cal.computeMs}ms`);
};

main().catch(e => { console.error(`::error::${e.message}`); process.exit(1); });
