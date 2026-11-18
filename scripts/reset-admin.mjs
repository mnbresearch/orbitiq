#!/usr/bin/env node
// ============================================================
// OrbitIQ Admin Recovery & Password Reset Utility
// Allows the operator to recover or reset their admin credentials
// Usage: node scripts/reset-admin.mjs [newPassword] [adminEmail]
// ============================================================
import crypto from "crypto";
import * as store from "../src/store.js";
import * as auth from "../src/auth.js";

const args = process.argv.slice(2);
let newPassword = args[0];
let adminEmail = args[1];

const { admin: adminWs } = store.ensureAdmin(process.env.ORBITIQ_ADMIN_KEY || null);

const currentAdmin = auth.findAdmin();
if (!adminEmail) {
  adminEmail = currentAdmin ? currentAdmin.email : (process.env.ORBITIQ_ADMIN_EMAIL || "admin@orbitiq.local");
}

if (!newPassword) {
  newPassword = crypto.randomBytes(9).toString("base64url");
}

const adminUser = auth.setAdminPassword(newPassword, adminEmail, adminWs.id);

console.log("\n" + "═".repeat(64));
console.log("  ORBITIQ ADMIN CREDENTIALS RECOVERED / RESET");
console.log("═".repeat(64));
console.log(`  Admin Email:     ${adminUser.email}`);
console.log(`  Admin Password:  ${newPassword}`);
console.log(`  Admin API Key:   ${adminWs.apiKey}`);
console.log("─".repeat(64));
console.log("  Sign in options:");
console.log("    1. Web Portal:  http://localhost:3000/login.html");
console.log("       Enter your email and password above.");
console.log("    2. Admin Portal: http://localhost:3000/admin.html");
console.log("    3. Direct Key:   You can also enter your Admin API Key directly");
console.log("       into the login form to bypass the password.");
if (process.env.PUBLIC_URL || "https://orbit.mnbresearch.com") {
  console.log(`    4. Live URL:    ${process.env.PUBLIC_URL || "https://orbit.mnbresearch.com"}/login.html`);
}
console.log("═".repeat(64) + "\n");
process.exit(0);
