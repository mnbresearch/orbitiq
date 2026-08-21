// ============================================================
// OrbitIQ transactional mail — Resend
//
// Setup (Render → Environment):
//   ORBITIQ_RESEND_KEY   re_xxxxxxxxxxxx      (required to send)
//   ORBITIQ_MAIL_FROM    OrbitIQ <notifications@mnbresearch.com>
//   ORBITIQ_MAIL_TO      mnbgotyou@gmail.com  (where leads land)
//
// Without a key this module is a silent no-op: every request is
// still persisted and visible in the admin portal, nothing throws.
// ============================================================
const KEY = process.env.ORBITIQ_RESEND_KEY || null;
const FROM = process.env.ORBITIQ_MAIL_FROM || "OrbitIQ <notifications@mnbresearch.com>";
const TO = process.env.ORBITIQ_MAIL_TO || "mnbgotyou@gmail.com";
const BRAND = "MNB Research";

let state = { enabled: !!KEY, sent: 0, failed: 0, lastError: null, lastSentAt: null };
export const status = () => ({ ...state, from: FROM, to: TO });
export const enabled = () => !!KEY;

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function send({ to, subject, html, replyTo }) {
  if (!KEY) return { ok: false, skipped: true };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        ...(replyTo ? { reply_to: replyTo } : {})
      })
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`Resend ${r.status}: ${body.slice(0, 180)}`);
    }
    state.sent++;
    state.lastSentAt = new Date().toISOString();
    state.lastError = null;
    return { ok: true };
  } catch (e) {
    state.failed++;
    state.lastError = e.message;
    console.error("mailer:", e.message);
    return { ok: false, error: e.message };
  }
}

/** Send a fully-formed message. Used by the fleet watch for alert mail. */
export async function sendRaw({ to, subject, html, replyTo }) {
  return send({ to, subject, html, replyTo });
}

const shell = (title, inner) => `<!doctype html><html><body style="margin:0;background:#04060c;padding:28px 16px;font-family:-apple-system,Segoe UI,Inter,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#0b101c;border:1px solid rgba(90,130,200,.22);border-radius:16px;padding:28px 26px;color:#e6edfa">
<div style="font-size:19px;font-weight:650;letter-spacing:-.01em;margin-bottom:4px">Orbit<span style="color:#38bdf8">IQ</span></div>
<div style="font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:#7385a3;margin-bottom:22px">${esc(title)}</div>
${inner}
<div style="margin-top:26px;padding-top:16px;border-top:1px solid rgba(90,130,200,.18);font-size:11.5px;color:#7385a3">
Built by ${BRAND} and its team · <a href="https://orbit.mnbresearch.com" style="color:#38bdf8;text-decoration:none">orbit.mnbresearch.com</a>
</div></div></body></html>`;

const row = (k, v) =>
  `<tr><td style="padding:7px 14px 7px 0;color:#7385a3;font-size:12.5px;white-space:nowrap;vertical-align:top">${esc(k)}</td>
   <td style="padding:7px 0;font-size:13.5px;color:#e6edfa">${esc(v || "—")}</td></tr>`;

// ---------- 1. new access request → operator inbox ----------
export async function notifyAccessRequest(req) {
  const inner = `<p style="margin:0 0 18px;font-size:14px;line-height:1.55;color:#c3cfe4">
A new access request just came in through the OrbitIQ landing page.</p>
<table style="width:100%;border-collapse:collapse;background:#060a15;border:1px solid rgba(90,130,200,.18);border-radius:10px;padding:6px 14px">
${row("Name", req.name)}${row("Email", req.email)}${row("Phone", req.phone)}${row("Position", req.position)}
${row("Organization", req.org)}${row("Plan interest", req.plan)}${row("Message", req.message)}
${row("Received", new Date(req.createdAt || Date.now()).toUTCString())}</table>
<p style="margin:20px 0 0;font-size:13px;line-height:1.55;color:#c3cfe4">
Approve or decline in the <a href="https://orbit.mnbresearch.com/admin.html" style="color:#38bdf8;text-decoration:none">admin portal</a>.
Approving provisions a workspace, issues an API key and emails the credentials automatically.</p>`;
  return send({ to: TO, subject: `OrbitIQ access request — ${req.name || req.email}`, html: shell("New access request", inner), replyTo: req.email });
}

// ---------- 2. acknowledgement → the requester ----------
export async function acknowledgeRequest(req) {
  if (!req?.email) return { ok: false };
  const inner = `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#c3cfe4">
${req.name ? esc(req.name.split(" ")[0]) + "," : "Hello,"} thank you for requesting access to OrbitIQ.</p>
<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#c3cfe4">
Access is granted by review rather than self-service, so every workspace is provisioned deliberately. Our team is looking at your request now and will come back to you with credentials or a short set of follow-up questions.</p>
<p style="margin:0;font-size:14px;line-height:1.6;color:#c3cfe4">If anything changes in the meantime, simply reply to this message.</p>`;
  return send({ to: req.email, subject: "Your OrbitIQ access request", html: shell("Request received", inner) });
}

// ---------- 3. approval → credentials ----------
export async function sendCredentials({ email, name, tempPassword, plan, apiKey }) {
  if (!email) return { ok: false };
  const inner = `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#c3cfe4">
${name ? esc(String(name).split(" ")[0]) + "," : "Hello,"} your OrbitIQ workspace is live.</p>
<table style="width:100%;border-collapse:collapse;background:#060a15;border:1px solid rgba(90,130,200,.18);border-radius:10px;padding:6px 14px">
${row("Sign in", "https://orbit.mnbresearch.com/login.html")}${row("Email", email)}
${row("Temporary password", tempPassword)}${row("Plan", plan)}${apiKey ? row("API key", apiKey) : ""}</table>
<p style="margin:18px 0 0;font-size:13.5px;line-height:1.6;color:#c3cfe4">
You will be asked to choose a new password on first sign-in. Keep the API key private — it carries your plan's full entitlements.</p>`;
  return send({ to: email, subject: "Your OrbitIQ workspace is ready", html: shell("Access approved", inner) });
}

// ---------- 4. decline ----------
export async function sendDecline({ email, name }) {
  if (!email) return { ok: false };
  const inner = `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#c3cfe4">
${name ? esc(String(name).split(" ")[0]) + "," : "Hello,"} thank you for your interest in OrbitIQ.</p>
<p style="margin:0;font-size:14px;line-height:1.6;color:#c3cfe4">
We are not able to open a workspace for you at this time. Operational capacity is allocated in cohorts, so this may change — you are welcome to reply to this message and we will revisit it.</p>`;
  return send({ to: email, subject: "About your OrbitIQ access request", html: shell("Request update", inner) });
}

// ---------- 5. sign-in → operator inbox ----------
// Fires on every successful sign-in. `firstTime` separates the moment that
// actually matters — a newly approved operator using their workspace for the
// first time — from routine returning traffic, because both land in the same
// inbox and only one of them is news.
export async function notifySignIn({ email, name, org, plan, ip, userAgent, firstTime, at }) {
  if (!email) return { ok: false };
  const when = new Date(at || Date.now()).toUTCString();
  const lead = firstTime
    ? `<strong style="color:#3EE89B">${esc(name || email)}</strong> signed in to OrbitIQ for the first time.`
    : `${esc(name || email)} signed in to OrbitIQ.`;
  const inner = `<p style="margin:0 0 18px;font-size:14px;line-height:1.55;color:#c3cfe4">${lead}</p>
<table style="width:100%;border-collapse:collapse;background:#060a15;border:1px solid rgba(90,130,200,.18);border-radius:10px;padding:6px 14px">
${row("Name", name)}${row("Email", email)}${row("Organization", org)}${row("Plan", plan)}
${row("First sign-in", firstTime ? "yes" : "no")}${row("IP address", ip)}${row("Device", userAgent)}
${row("Signed in", when)}</table>
<p style="margin:20px 0 0;font-size:13px;line-height:1.55;color:#c3cfe4">
Manage this operator in the <a href="https://orbit.mnbresearch.com/admin.html" style="color:#38bdf8;text-decoration:none">admin portal</a> —
you can change their plan, reset their password or update their email address there.</p>`;
  return send({
    to: TO,
    subject: firstTime
      ? `OrbitIQ — first sign-in: ${name || email}`
      : `OrbitIQ sign-in — ${name || email}`,
    html: shell(firstTime ? "New operator active" : "Sign-in", inner),
    replyTo: email
  });
}

// ---------- 6. welcome → the operator, first sign-in only ----------
// Deliberately not sent on every sign-in. A "thanks for signing in" message
// that arrives daily is indistinguishable from spam, and the fastest way to
// get a sending domain filtered is to send mail nobody opens.
export async function welcomeOnFirstSignIn({ email, name, plan, org }) {
  if (!email) return { ok: false };
  const first = name ? esc(String(name).split(" ")[0]) + "," : "Hello,";
  const inner = `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#c3cfe4">
${first} welcome to OrbitIQ — and thank you for signing in.</p>
<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#c3cfe4">
Your workspace is live. From here you can screen ${org ? esc(org) + "'s" : "your"} spacecraft against the
public catalogue of tracked objects, see probability of collision computed by Foster's encounter-plane
method rather than a miss-distance rule of thumb, plan avoidance manoeuvres, and read back a permanent
archive of every detection we have made for you.</p>
<table style="width:100%;border-collapse:collapse;background:#060a15;border:1px solid rgba(90,130,200,.18);border-radius:10px;padding:6px 14px">
${row("Console", "https://orbit.mnbresearch.com/app")}
${row("API reference", "https://orbit.mnbresearch.com/docs.html")}
${row("Service status", "https://orbit.mnbresearch.com/status.html")}
${plan ? row("Your plan", plan) : ""}</table>
<p style="margin:18px 0 0;font-size:14px;line-height:1.6;color:#c3cfe4">
OrbitIQ is built by <a href="https://www.mnbresearch.com" style="color:#38bdf8;text-decoration:none">MNB Research</a>,
and the product page lives at
<a href="https://www.mnbresearch.com/orbitiq" style="color:#38bdf8;text-decoration:none">mnbresearch.com/orbitiq</a>.
If you want a walkthrough, or something in the data looks wrong, reply to this message and it reaches our team directly.</p>
<p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#7385a3">
One note on honesty: conjunction screening is a decision aid, not a guarantee. We publish what we screened,
when, and to what completeness, so you can judge the answer rather than take it on trust.</p>`;
  return send({ to: email, subject: "Welcome to OrbitIQ", html: shell("Welcome aboard", inner) });
}

// ---------- 7. email address changed → both addresses ----------
// Sent to the OLD address as well as the new one. An account silently
// repointed to an attacker's mailbox is the classic takeover; telling the
// previous owner is what makes that loud instead of quiet.
export async function notifyEmailChanged({ oldEmail, newEmail, name, by }) {
  const inner = (audience) => `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#c3cfe4">
${name ? esc(String(name).split(" ")[0]) + "," : "Hello,"} the email address on your OrbitIQ account was changed${by ? " by " + esc(by) : ""}.</p>
<table style="width:100%;border-collapse:collapse;background:#060a15;border:1px solid rgba(90,130,200,.18);border-radius:10px;padding:6px 14px">
${row("Previous address", oldEmail)}${row("New address", newEmail)}${row("Changed", new Date().toUTCString())}</table>
<p style="margin:18px 0 0;font-size:14px;line-height:1.6;color:#c3cfe4">
${audience === "old"
    ? "Sign in from now on with the new address. If you did not expect this change, reply immediately — we will lock the account while we look into it."
    : "You can now sign in with this address. Your password and API key are unchanged."}</p>`;
  const jobs = [];
  if (oldEmail) jobs.push(send({ to: oldEmail, subject: "Your OrbitIQ sign-in address was changed", html: shell("Account updated", inner("old")) }));
  if (newEmail) jobs.push(send({ to: newEmail, subject: "Your OrbitIQ sign-in address was changed", html: shell("Account updated", inner("new")) }));
  const out = await Promise.all(jobs);
  return { ok: out.every(r => r.ok) };
}
