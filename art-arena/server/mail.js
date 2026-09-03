'use strict';
/**
 * ============================================================================
 *  ART ARENA™ — EMAIL DELIVERY LAYER  (the provider swap point)
 * ============================================================================
 *  The auth flow ONLY ever calls:
 *
 *      await sendEmail(user, subject, token, kind)
 *
 *  It knows nothing about providers, APIs, or inboxes. Choosing a transport
 *  happens HERE, by environment:
 *
 *      MAIL_PROVIDER=dev       (default in development)
 *          → simulated mailbox (dev-outbox.json), readable via
 *            GET /api/dev/outbox?to=<email> — the 📬 buttons in the UI.
 *            Honest stand-in for "the user checks their inbox".
 *      MAIL_PROVIDER=resend
 *          → Resend API (needs RESEND_API_KEY).
 *      MAIL_PROVIDER=postmark
 *          → Postmark API (needs POSTMARK_SERVER_TOKEN).
 *
 *  GOING TO PRODUCTION (Resend or Postmark) = edit .env only:
 *
 *      NODE_ENV=production
 *      MAIL_PROVIDER=resend            # or: postmark
 *      RESEND_API_KEY=re_xxxx          # or: POSTMARK_SERVER_TOKEN=xxxx
 *      MAIL_FROM=Art Arena <noreply@yourdomain.com>
 *
 *  No auth-flow code changes. The dev simulated inbox stays available in
 *  development for the entire dev/test phase.
 *
 *  Semantics:
 *   - One-time codes are NEVER in API responses and NEVER on UI forms —
 *     they only ever exist in this layer (email body / dev outbox entry).
 *   - Delivery failures THROW. A register/forgot call then fails loudly
 *     instead of silently stranding a user without their code. (The account
 *     row survives — the user can log in and use "Resend", since login is
 *     not gated on verification.)
 *   - Code lifetimes live here (TTL_HOURS) so the email text and the DB
 *     expiry can never drift apart.
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');

const DEV = (process.env.NODE_ENV || 'development') !== 'production';
const MAIL_PROVIDER = (process.env.MAIL_PROVIDER || '').toLowerCase() || null;
const OUTBOX_FILE = path.join(__dirname, 'dev-outbox.json'); // dev simulated mailbox

// Single source of truth for one-time code lifetimes.
const TTL_HOURS = { verification: 24, reset: 1 };

// ---------------------------------------------------------------------------
// Email body — built once, rendered identically for every provider.
// v44: every mail is BRANDED — dark Art Arena theme (the brand stays dark
// even in emails), pink→purple wordmark gradient, a big monospace code chip,
// and email-safe table layout + inline styles (works in Gmail/Outlook).
// A plain-text twin travels along for clients that block HTML.
// ---------------------------------------------------------------------------
function buildBody(kind, token) {
  if (kind === 'reset') {
    return [
      'Your Art Arena password reset code:',
      '',
      token,
      '',
      `It expires in ${TTL_HOURS.reset} hour.`,
      'If you did not request a password reset, ignore this email — your password has not been changed.',
    ].join('\n');
  }
  // kind === 'verification'
  return [
    'Your Art Arena verification code:',
    '',
    token,
    '',
    `It expires in ${TTL_HOURS[kind] || 24} hours.`,
    'If you did not create an Art Arena account, ignore this email.',
  ].join('\n');
}

// The branded HTML twin. Kept deliberately simple and static: no images to
// load (the wordmark is styled text), no external assets, one accent color
// pair, generous code letter-spacing so 6-char codes never wrap.
function buildHtml(kind, token) {
  const isReset = kind === 'reset';
  const heading = isReset ? 'Password reset code' : 'Verify your account';
  const sub = isReset
    ? 'Enter this code to choose a new password for your Art Arena account.'
    : 'Enter this code in Art Arena to verify your email and unlock everything.';
  const ttl = `Expires in ${TTL_HOURS[kind] || 24} ${isReset ? 'hour' : 'hours'}`;
  const caution = isReset
    ? 'If you did not request a reset, ignore this email — your password has not been changed.'
    : 'If you did not create an Art Arena account, you can ignore this email.';
  return `<!doctype html><html><body style="margin:0;padding:0;background:#09070d;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#09070d;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#161022;border:1px solid #2c2142;border-radius:14px;overflow:hidden;">
  <tr><td style="padding:26px 28px 10px;">
    <div style="font-size:22px;font-weight:800;letter-spacing:1.5px;">
      <span style="color:#ff3cac;">ART</span> <span style="color:#9b8fb5;">ARENA</span>
      <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:linear-gradient(135deg,#ff3cac,#7b2cff);margin-left:4px;"></span>
    </div>
  </td></tr>
  <tr><td style="padding:8px 28px 0;">
    <h1 style="margin:14px 0 6px;font-size:18px;color:#f4f0fa;">${heading}</h1>
    <p style="margin:0 0 18px;font-size:14px;line-height:1.55;color:#9b8fb5;">${sub}</p>
  </td></tr>
  <tr><td style="padding:0 28px;">
    <div style="background:#0d0917;border:1px solid #2c2142;border-radius:12px;padding:16px;text-align:center;">
      <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#9b8fb5;">YOUR CODE</div>
      <div style="margin-top:8px;font-size:30px;font-weight:800;letter-spacing:10px;color:#f4f0fa;">${token}</div>
      <div style="margin-top:10px;font-size:12px;color:#9b8fb5;">${ttl}</div>
    </div>
  </td></tr>
  <tr><td style="padding:18px 28px 26px;">
    <p style="margin:0;font-size:12px;line-height:1.55;color:#9b8fb5;">${caution}</p>
    <p style="margin:14px 0 0;font-size:11px;color:#6a5f85;border-top:1px solid #2c2142;padding-top:14px;">Art Arena — the live art battle platform. Never share this code with anyone; Art Arena will never ask for it in chat.</p>
  </td></tr>
</table></td></tr></table></body></html>`;
}


// ---------------------------------------------------------------------------
// Providers — each implements: async send({ to, subject, body, kind, token })
// ---------------------------------------------------------------------------
function outboxRead() {
  try {
    return JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8'));
  } catch {
    return [];
  }
}

const providers = {
  // Simulated mailbox (development). Entry shape is consumed by the UI's
  // 📬 dev-inbox buttons (they read `token`), so keep those fields stable.
  dev: {
    name: 'dev-inbox',
    async send({ to, subject, body, html, kind, token }) {
      const entry = {
        to,
        subject,
        kind,
        token,
        text: body,
        html: html || null, // v44: branded twin (dev inbox can render it)
        sent_at: new Date().toISOString(),
      };
      const list = outboxRead();
      list.push(entry);
      fs.writeFileSync(OUTBOX_FILE, JSON.stringify(list.slice(-50), null, 2));
      console.log(
        `[mail:dev-inbox] to=${to} subject="${subject}" (${kind} code, ${TTL_HOURS[kind]}h) — simulated inbox: /api/dev/outbox?to=${encodeURIComponent(to)}`
      );
    },
  },

  // Resend — https://resend.com/docs/api-reference/emails/send-email
  resend: {
    name: 'resend',
    async send({ to, subject, body, html }) {
      const key = process.env.RESEND_API_KEY;
      if (!key) throw new Error('RESEND_API_KEY is not set — add it to .env to use the Resend provider.');
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.MAIL_FROM || 'Art Arena <onboarding@resend.dev>',
          to: [to],
          subject,
          text: body,        // plain-text twin (clients that block HTML)
          html: html || body, // v44: branded template
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Resend rejected the email: ${j.message || res.status}`);
      console.log(`[mail:resend] to=${to} subject="${subject}" id=${j.id || 'n/a'}`);
    },
  },

  // Postmark — https://postmarkapp.com/developer/api/send-message-api
  postmark: {
    name: 'postmark',
    async send({ to, subject, body, html }) {
      const key = process.env.POSTMARK_SERVER_TOKEN;
      if (!key) throw new Error('POSTMARK_SERVER_TOKEN is not set — add it to .env to use the Postmark provider.');
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Postmark-Server-Token': key,
        },
        body: JSON.stringify({
          From: process.env.MAIL_FROM || 'Art Arena <noreply@artarena.dev>',
          To: to,
          Subject: subject,
          TextBody: body,
          HtmlBody: html || body, // v44: branded template
          MessageTemplate: false,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Postmark rejected the email: ${j.Message || res.status}`);
      console.log(`[mail:postmark] to=${to} subject="${subject}" messageId=${j.MessageId || 'n/a'}`);
    },
  },
};

function resolveProvider() {
  const name = MAIL_PROVIDER || (DEV ? 'dev' : null);
  if (!name) {
    throw new Error(
      'MAIL_PROVIDER is not set. Set MAIL_PROVIDER=dev|resend|postmark in .env (dev is the default in development only).'
    );
  }
  const p = providers[name];
  if (!p) throw new Error(`Unknown MAIL_PROVIDER "${name}" (expected: dev, resend, postmark).`);
  if (name === 'dev' && !DEV) {
    throw new Error(
      'MAIL_PROVIDER=dev is not allowed with NODE_ENV=production — production must use a real provider (resend or postmark).'
    );
  }
  return p;
}

/**
 * THE single email seam for the whole app.
 * @param {{email:string}} user  recipient (only the `email` field is used)
 * @param {string} subject
 * @param {string} token         one-time code (generated + hashed by the caller)
 * @param {'verification'|'reset'} kind
 */
async function sendEmail(user, subject, token, kind) {
  const provider = resolveProvider();
  await provider.send({
    to: user.email,
    subject,
    body: buildBody(kind, token),      // plain text (always present)
    html: buildHtml(kind, token),      // v44: branded Art Arena template
    kind,
    token,
  });
}

module.exports = { sendEmail, resolveProvider, providers, buildBody, buildHtml, TTL_HOURS, outboxRead };
