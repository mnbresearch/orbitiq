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
