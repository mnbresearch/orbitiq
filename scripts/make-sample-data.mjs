// Generates bundled offline sample data (used only when live sources are unreachable).
// Produces physically-plausible GP records for well-known constellations.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "data");
fs.mkdirSync(DATA, { recursive: true });

const now = new Date();
const epoch = now.toISOString().replace("Z", "");
let norad = 90000;

function gp(name, mm, ecc, incl, raan, argp, ma, type = "PAYLOAD") {
  const yr = 2019 + (norad % 8); // spread launch years for analytics realism
  return {
    OBJECT_NAME: name, OBJECT_ID: `${yr}-${String(norad % 900).padStart(3, "0")}A`,
    EPOCH: epoch, MEAN_MOTION: +mm.toFixed(8), ECCENTRICITY: +ecc.toFixed(7),
    INCLINATION: +incl.toFixed(4), RA_OF_ASC_NODE: +raan.toFixed(4),
    ARG_OF_PERICENTER: +argp.toFixed(4), MEAN_ANOMALY: +ma.toFixed(4),
    EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: "U", NORAD_CAT_ID: norad++,
    ELEMENT_SET_NO: 999, REV_AT_EPOCH: 10000,
    BSTAR: 0.0001, MEAN_MOTION_DOT: 0.00001, MEAN_MOTION_DDOT: 0,
    OBJECT_TYPE: type
  };
}

const rows = [];
const rand = (a, b) => a + Math.random() * (b - a);

// Starlink: ~550 km shell, 53°, 15.05 rev/day — 20 planes x 20 sats
for (let p = 0; p < 20; p++) for (let s = 0; s < 20; s++)
  rows.push(gp(`STARLINK-${30000 + p * 20 + s}`, 15.05, 0.0001, 53.05, p * 18, 90, s * 18 + p * 3));
// OneWeb: 1200 km, 87.9°, 13.15 rev/day
for (let p = 0; p < 12; p++) for (let s = 0; s < 10; s++)
  rows.push(gp(`ONEWEB-${700 + p * 10 + s}`, 13.15, 0.0002, 87.9, p * 30, 90, s * 36));
// Iridium NEXT: 780 km, 86.4°
for (let p = 0; p < 6; p++) for (let s = 0; s < 11; s++)
  rows.push(gp(`IRIDIUM ${100 + p * 11 + s}`, 14.34, 0.0002, 86.4, p * 60, 90, s * 32.7));
// GPS: MEO 20200 km, 55°, 2 rev/day
for (let i = 0; i < 31; i++)
  rows.push(gp(`NAVSTAR ${60 + i} (USA ${200 + i})`, 2.0057, 0.005, 55, (i % 6) * 60, rand(0, 360), rand(0, 360)));
// Galileo
for (let i = 0; i < 26; i++)
  rows.push(gp(`GALILEO ${i + 1} (GSAT02${String(i).padStart(2, "0")})`, 1.7, 0.0003, 56, (i % 3) * 120, rand(0, 360), rand(0, 360)));
// GEO comms belt
for (let i = 0; i < 40; i++)
  rows.push(gp(`GEO-COMSAT ${i + 1}`, 1.0027, 0.0002, rand(0, 0.15), rand(0, 360), rand(0, 360), i * 9));
// Stations
rows.push(gp("ISS (ZARYA)", 15.5, 0.0004, 51.64, 120, 60, 200));
rows.push(gp("CSS (TIANHE)", 15.6, 0.0004, 41.47, 200, 100, 10));
// ISRO
["CARTOSAT-3", "RISAT-2BR2", "EOS-08", "OCEANSAT-3", "RESOURCESAT-2A", "NVS-02"].forEach((n, i) =>
  rows.push(gp(n, i < 5 ? 14.8 : 2.0, 0.001, i < 5 ? 97.5 : 29, rand(0, 360), rand(0, 360), rand(0, 360))));
// Planet + Spire
for (let i = 0; i < 24; i++) rows.push(gp(`FLOCK 4X-${i + 1}`, 15.2, 0.0008, 97.4, rand(0, 360), 90, i * 15));
for (let i = 0; i < 12; i++) rows.push(gp(`LEMUR-2-${i + 1}`, 15.1, 0.001, 51.6, rand(0, 360), 90, i * 30));
// Weather
["NOAA 20", "NOAA 21", "METOP-C", "GOES 18", "METEOSAT-12"].forEach((n, i) =>
  rows.push(gp(n, i < 3 ? 14.19 : 1.0027, 0.001, i < 3 ? 98.7 : 0.05, rand(0, 360), rand(0, 360), rand(0, 360))));
// Debris cloud (some with low perigee for decay watch)
for (let i = 0; i < 120; i++) {
  const mm = rand(15.6, 16.3), ecc = rand(0.001, 0.02);
  rows.push(gp(`COSMOS 1408 DEB ${i + 1}`, mm, ecc, rand(80, 83), rand(0, 360), rand(0, 360), rand(0, 360), "DEBRIS"));
}
// A couple of deliberate close pairs (for conjunction demo)
const twin = gp("STARLINK-30000", 15.05, 0.0001, 53.05, 0, 90, 0.4); twin.OBJECT_NAME = "SL-DEMO-TWIN";
rows.push(twin);

fs.writeFileSync(path.join(DATA, "celestrak-active.sample.json"), JSON.stringify(rows));
fs.writeFileSync(path.join(DATA, "celestrak-cosmos-1408-debris.sample.json"), "[]");
fs.writeFileSync(path.join(DATA, "celestrak-iridium-33-debris.sample.json"), "[]");

// sample launches
const mkLaunch = (name, provider, loc, hoursFromNow, status) => ({
  id: name.toLowerCase().replace(/\W+/g, "-"), name, status: { abbrev: status },
  net: new Date(now.getTime() + hoursFromNow * 3600e3).toISOString(),
  launch_service_provider: { name: provider },
  pad: { name: "Pad", location: { name: loc } },
  mission: { name: name.split("|")[1]?.trim() || name, orbit: { abbrev: "LEO" } }
});
fs.writeFileSync(path.join(DATA, "launches-upcoming.sample.json"), JSON.stringify({ results: [
  mkLaunch("Falcon 9 | Starlink Group 12-31", "SpaceX", "Cape Canaveral, FL", 18, "Go"),
  mkLaunch("PSLV-XL | RISAT-2C", "ISRO", "Sriharikota, India", 42, "Go"),
  mkLaunch("Electron | Owl For One", "Rocket Lab", "Mahia, New Zealand", 66, "TBC"),
  mkLaunch("Long March 5B | Tianwen-4", "CASC", "Wenchang, China", 90, "TBD"),
  mkLaunch("New Glenn | ESCAPADE-2", "Blue Origin", "Cape Canaveral, FL", 120, "TBC"),
  mkLaunch("Ariane 64 | Galileo FOC FM33", "Arianespace", "Kourou, French Guiana", 160, "Go")
]}));
fs.writeFileSync(path.join(DATA, "launches-previous.sample.json"), JSON.stringify({ results: [
  mkLaunch("Falcon 9 | Starlink Group 12-30", "SpaceX", "Vandenberg SFB, CA", -20, "Success"),
  mkLaunch("Falcon Heavy | USSF-70", "SpaceX", "Kennedy Space Center, FL", -50, "Success"),
  mkLaunch("Soyuz 2.1a | Progress MS-32", "Roscosmos", "Baikonur, Kazakhstan", -80, "Success")
]}));

// sample events
fs.writeFileSync(path.join(DATA, "events-upcoming.sample.json"), JSON.stringify({ results: [
  { id: 1, name: "Progress MS-33 Docking", type: { name: "Docking" }, date: new Date(now.getTime() + 30 * 3600e3).toISOString(), location: "International Space Station", description: "Progress resupply vehicle docking to the Zvezda service module." },
  { id: 2, name: "US EVA 95", type: { name: "Spacewalk" }, date: new Date(now.getTime() + 96 * 3600e3).toISOString(), location: "International Space Station", description: "Crew EVA to install a new ISS Roll-Out Solar Array on the P4 truss." },
  { id: 3, name: "Europa Clipper Gravity Assist", type: { name: "Flyby" }, date: new Date(now.getTime() + 200 * 3600e3).toISOString(), location: "Mars", description: "Europa Clipper performs a Mars gravity assist en route to Jupiter." },
  { id: 4, name: "Starship IFT-12 Static Fire", type: { name: "Static Fire" }, date: new Date(now.getTime() + 60 * 3600e3).toISOString(), location: "Starbase, TX", description: "Full-duration static fire ahead of the next integrated flight test." }
]}));

// synthetic element history so maneuver detection has sample signal
const hist = {};
const prevEpoch = new Date(now.getTime() - 36 * 3600e3).toISOString().replace("Z", "");
const maneuverDemos = [
  ["STARLINK-30007", -0.006, 0, "orbit raise"],
  ["STARLINK-30123", -0.005, 0, "orbit raise"],
  ["STARLINK-30222", 0.007, 0, "orbit lower (deorbit prep)"],
  ["ISS (ZARYA)", -0.004, 0, "reboost"],
  ["ONEWEB-0703", 0, 0.02, "plane trim"],
  ["GEO-COMSAT 7", -0.002, 0.015, "stationkeeping"]
];
for (const r of rows) {
  const demo = maneuverDemos.find(d => d[0] === r.OBJECT_NAME);
  if (demo) {
    hist[r.NORAD_CAT_ID] = {
      epoch: r.EPOCH, meanMotion: r.MEAN_MOTION, incl: r.INCLINATION, raan: r.RA_OF_ASC_NODE, ecc: r.ECCENTRICITY,
      prev: { epoch: prevEpoch, meanMotion: r.MEAN_MOTION + demo[1], incl: r.INCLINATION + demo[2], raan: r.RA_OF_ASC_NODE, ecc: r.ECCENTRICITY }
    };
  }
}
fs.writeFileSync(path.join(DATA, "elements-history.json"), JSON.stringify(hist));

console.log(`Sample data written: ${rows.length} objects + launches + events + ${Object.keys(hist).length} maneuver histories`);
