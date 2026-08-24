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
// The data directory is overridable so the test suite can run against a
// throwaway directory. Without this, importing this module in a test writes
// real accounts into data/auth.json — which happened, and also made the
// tests non-repeatable because the fixture email was already taken on the
// second run.
const DATA_DIR = process.env.ORBITIQ_DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "auth.json");

let db = { users: [], requests: [], sessions: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { /* fresh */ }

let saveTimer = null;
let dirty = false;

function writeNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!dirty) return false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(db));
    dirty = false;
    return true;
  } catch (e) { console.error("auth save failed:", e.message); return false; }
}

function save() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, 250);
  saveTimer.unref?.();
}

/**
 * Write pending account changes to disk immediately.
 *
 * This exists because the shutdown path flushed the workspace store, the fleet
 * registry and the trend tracker — and silently skipped accounts. Saves here
 * are debounced by 250 ms, so approving a user and then redeploying (which is
 * a completely ordinary sequence) could drop the account entirely. On a host
 * with an ephemeral disk that loss is permanent.
 */
export function flush() { return writeNow(); }

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
  // Sign-in history. `firstSignIn` is computed BEFORE the counter moves, so the
  // caller can tell a brand-new operator from a returning one; it is the whole
  // basis for deciding whether to send the welcome mail, and it must be true
  // exactly once per account for the lifetime of that account.
  const firstSignIn = !u.signInCount;
  u.signInCount = (u.signInCount || 0) + 1;
  u.lastSignInAt = new Date().toISOString();
  if (firstSignIn) u.firstSignInAt = u.lastSignInAt;
  save();
  return { token, user: u, firstSignIn };
}

/**
 * Change the address a user signs in with.
 *
 * Email is the login identifier here, so this is an identity change, not a
 * profile edit: it must stay unique, and it must not silently hand the account
 * to a different mailbox. Returns the previous address so the caller can tell
 * BOTH sides that it happened.
 */
export function changeEmail(userId, nextEmail) {
  const u = getUser(userId);
  if (!u) return { error: "User not found" };
  const email = String(nextEmail || "").toLowerCase().trim();
  // Deliberately conservative: one @, a dot in the domain, no whitespace.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "That is not a valid email address" };
  if (email.length > 190) return { error: "Email address is too long" };
  if (email === u.email) return { error: "That is already this user's address" };
  const clash = db.users.find(x => x.email === email && x.id !== u.id);
  if (clash) return { error: "Another account already uses that address" };
  const previous = u.email;
  u.email = email;
  u.emailChangedAt = new Date().toISOString();
  // Signing in is what proves control of an address, so make them do it again:
  // every existing session for this user is dropped.
  let revoked = 0;
  for (const [t, s] of Object.entries(db.sessions)) {
    if (s.userId === u.id) { delete db.sessions[t]; revoked++; }
  }
  save();
  return { ok: true, previous, email, revokedSessions: revoked };
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
