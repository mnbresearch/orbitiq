// ============================================================
// OrbitIQ auth — email/password accounts, sessions, and the
// access-request queue that feeds the admin portal.
// Passwords are scrypt-hashed (never stored in plaintext).
// Self-contained persistence in data/auth.json (backed up with
// the archive when ORBITIQ_GH_TOKEN is set).
// ============================================================
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "data", "auth.json");

let db = { users: [], requests: [], sessions: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { /* fresh */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) { console.error("auth save failed:", e.message); }
  }, 250);
}

// ---------- password hashing (scrypt) ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  return salt + ":" + hash;
}
function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = String(stored).split(":");
    const test = crypto.scryptSync(String(pw), salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(test, "hex"));
  } catch { return false; }
}
const tempPassword = () => crypto.randomBytes(6).toString("base64url");

// ---------- users ----------
export function createUser(email, name, password, role, workspaceId) {
  email = String(email).toLowerCase().trim();
  if (db.users.some(u => u.email === email)) return null;
  const user = {
    id: crypto.randomUUID(), email, name: String(name || email).slice(0, 60),
    passHash: hashPassword(password), role: role || "user",
    workspaceId: workspaceId || null, mustChangePassword: role !== "admin",
    createdAt: new Date().toISOString()
  };
  db.users.push(user); save();
  return user;
}
export const findUser = email => db.users.find(u => u.email === String(email).toLowerCase().trim()) || null;
export const getUser = id => db.users.find(u => u.id === id) || null;
export const listUsers = () => db.users.map(({ passHash, ...u }) => u);

export function bootstrapAdmin(email, password, workspaceId) {
  let admin = db.users.find(u => u.role === "admin");
  if (admin) {
    if (admin.workspaceId !== workspaceId) { admin.workspaceId = workspaceId; save(); }
    return { admin, created: false };
  }
  admin = createUser(email, name(email), password, "admin", workspaceId);
  function name(e) { return "Admin (" + e.split("@")[0] + ")"; }
  console.log(`auth: admin account bootstrapped for ${email} — change the password after first login`);
  return { admin, created: true };
}

export function changePassword(userId, current, next) {
  const u = getUser(userId);
  if (!u) return { error: "User not found" };
  if (!verifyPassword(current, u.passHash)) return { error: "Current password is incorrect" };
  if (String(next).length < 8) return { error: "New password must be at least 8 characters" };
  u.passHash = hashPassword(next); u.mustChangePassword = false; save();
  return { ok: true };
}
export function resetPassword(userId) {
  const u = getUser(userId);
  if (!u) return null;
  const pw = tempPassword();
  u.passHash = hashPassword(pw); u.mustChangePassword = true; save();
  return pw;
}

// ---------- sessions ----------
const SESSION_TTL = 7 * 24 * 3600 * 1000;
export function login(email, password) {
  const u = findUser(email);
  if (!u || !verifyPassword(password, u.passHash)) return null;
  // prune expired sessions
  for (const [t, s] of Object.entries(db.sessions)) if (s.exp < Date.now()) delete db.sessions[t];
  const token = crypto.randomBytes(32).toString("base64url");
  db.sessions[token] = { userId: u.id, exp: Date.now() + SESSION_TTL };
  save();
  return { token, user: u };
}
export function sessionUser(token) {
  const s = db.sessions[token];
  if (!s || s.exp < Date.now()) return null;
  return getUser(s.userId);
}
export function logout(token) { delete db.sessions[token]; save(); }

// ---------- access requests ----------
export function requestAccess({ email, name, org, message, phone, position, plan }) {
  email = String(email || "").toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "Valid email required" };
  if (!String(name || "").trim()) return { error: "Name required" };
  if (!String(phone || "").trim()) return { error: "Phone number required" };
  if (!String(position || "").trim()) return { error: "Position required" };
  if (findUser(email)) return { error: "An account with this email already exists — sign in instead" };
  if (db.requests.some(r => r.email === email && r.status === "pending"))
    return { error: "A request for this email is already pending review" };
  const req = {
    id: crypto.randomUUID(), email,
    name: String(name || "").slice(0, 60),
    phone: String(phone || "").slice(0, 32) || null,
    position: String(position || "").slice(0, 60) || null,
    plan: String(plan || "").slice(0, 24) || null,
    org: String(org || "").slice(0, 40) || null,
    message: String(message || "").slice(0, 280),
    status: "pending", createdAt: new Date().toISOString()
  };
  db.requests.unshift(req); save();
  return { ok: true, request: req };
}
export const listRequests = () => db.requests.slice(0, 100);
export function decideRequest(id, approved, workspaceId) {
  const r = db.requests.find(x => x.id === id && x.status === "pending");
  if (!r) return { error: "Request not found or already decided" };
  r.status = approved ? "approved" : "denied";
  r.decidedAt = new Date().toISOString();
  if (!approved) { save(); return { ok: true, request: r }; }
  const pw = tempPassword();
  const user = createUser(r.email, r.name, pw, "user", workspaceId);
  save();
  return { ok: true, request: r, user, tempPassword: pw };
}

export const stats = () => ({
  users: db.users.length,
  pendingRequests: db.requests.filter(r => r.status === "pending").length,
  activeSessions: Object.values(db.sessions).filter(s => s.exp > Date.now()).length
});
