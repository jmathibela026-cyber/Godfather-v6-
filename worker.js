// GodFatherEA shop: one Worker file (payments, license keys, email, key check)
// Shared logic: verify a Paystack payment, create the lifetime key, email it.
// Runs on Cloudflare Pages Functions (Workers runtime).

const enc = new TextEncoder();

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

async function hmacHex(algo, secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: algo }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Same payment reference always produces the same key, so a double call
// (webhook + success page) can never create two different keys.
async function makeKey(env, reference) {
  const hex = await hmacHex("SHA-256", env.LICENSE_SECRET, "license:" + reference);
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  let out = "";
  for (let i = 0; i < 20; i++) out += alphabet[parseInt(hex.substr(i * 2, 2), 16) % alphabet.length];
  return "GFEA-" + out.match(/.{5}/g).join("-");
}

async function paystackVerify(env, reference) {
  const r = await fetch("https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference), {
    headers: { Authorization: "Bearer " + env.PAYSTACK_SECRET_KEY },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.status) return { status: "unknown" };
  return j.data;
}

async function sendLicenseEmail(env, { email, name, key }) {
  const support = env.SUPPORT_EMAIL || "";
  const html = `<!doctype html><html><body style="margin:0;background:#05090d;font-family:Arial,Helvetica,sans-serif;color:#e8f6fa">
  <div style="max-width:520px;margin:0 auto;padding:28px 18px">
    <h2 style="color:#22d3ee;margin:0 0 6px">GodFatherEA v6+</h2>
    <p style="color:#7fa3ad;margin:0 0 22px">Powered by AlgoPro</p>
    <p>Hi ${escapeHtml(name || "trader")}, thank you for your purchase. Your lifetime license key:</p>
    <div style="margin:18px 0;padding:18px;border:2px dashed #06b6d4;border-radius:12px;background:#000;
                font-family:Consolas,Menlo,monospace;font-size:20px;letter-spacing:1px;color:#22d3ee;text-align:center">${key}</div>
    <p style="font-weight:bold;margin-bottom:6px">How to activate</p>
    <ol style="color:#c9dfe5;line-height:1.6;padding-left:20px;margin-top:0">
      <li>Open GodFatherEA v6+</li>
      <li>Paste the key above when asked for your license</li>
      <li>Press Start</li>
    </ol>
    <p style="color:#7fa3ad;font-size:13px;line-height:1.5">Keep this email safe. Please do not share your key; it is limited to a few trading accounts.
    ${support ? "Need help? Reply to this email or write to " + escapeHtml(support) + "." : ""}</p>
  </div></body></html>`;

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM, // e.g. "GodFatherEA <licenses@yourdomain.com>"
      to: [email],
      reply_to: support || undefined,
      subject: "Your GodFatherEA v6+ license key",
      html,
      text: `Your GodFatherEA v6+ lifetime license key:\n\n${key}\n\nOpen the EA, paste the key, press Start.`,
    }),
  });
  if (!r.ok) throw new Error("Email send failed: " + r.status + " " + (await r.text()));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Verifies the payment and makes sure the key exists and the email went out.
// Safe to call many times for the same reference.
async function fulfil(env, reference) {
  const tx = await paystackVerify(env, reference);
  if (tx.status !== "success") return { status: tx.status || "unknown" };

  // Never trust the browser: check amount and currency against our own price.
  if (Number(tx.amount) !== Number(env.PRICE_CENTS) || tx.currency !== (env.CURRENCY || "ZAR")) {
    return { status: "failed", reason: "amount_mismatch" };
  }

  const email = String(tx.customer?.email || "").toLowerCase();
  const name = tx.metadata?.name || "";
  const key = await makeKey(env, reference);

  // Store (idempotent: same key every time).
  const existing = await env.LICENSES.get("key:" + key, "json");
  if (!existing) {
    await env.LICENSES.put(
      "key:" + key,
      JSON.stringify({ email, name, reference, paidAt: tx.paid_at, accounts: [], active: true })
    );
  }

  // Email once. Flag first, undo if sending fails so a webhook retry can try again.
  const flag = "emailed:" + reference;
  if (!(await env.LICENSES.get(flag))) {
    await env.LICENSES.put(flag, "1");
    try {
      await sendLicenseEmail(env, { email, name, key });
    } catch (e) {
      await env.LICENSES.delete(flag);
      console.error(e.message);
      return { status: "success", email, key, emailed: false };
    }
  }
  return { status: "success", email, key, emailed: true };
}


// POST /api/init  { name, email }  ->  { url }  (Paystack hosted checkout)
async function initPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400); }

  const name = String(body.name || "").trim().slice(0, 80);
  const email = String(body.email || "").trim().toLowerCase().slice(0, 120);
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return json({ error: "Invalid name or email" }, 400);
  }

  const origin = new URL(request.url).origin;
  const rand = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const reference = "GF-" + Date.now().toString(36) + "-" + rand;

  const r = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.PAYSTACK_SECRET_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      amount: Number(env.PRICE_CENTS),          // price lives on the server, not the browser
      currency: env.CURRENCY || "ZAR",
      reference,
      callback_url: origin + "/success.html",
      metadata: { name, product: "GodFatherEA v6+ lifetime" },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.status) return json({ error: "Payment provider error" }, 502);
  return json({ url: j.data.authorization_url, reference });
}


// GET /api/status?reference=GF-...  -> { status, email?, key? }
// Called by success.html after Paystack redirects the buyer back.
async function statusGet({ request, env }) {
  const reference = new URL(request.url).searchParams.get("reference") || "";
  if (!/^GF-[a-z0-9-]{10,60}$/i.test(reference)) return json({ status: "unknown" }, 400);
  const res = await fulfil(env, reference);
  return json(res);
}


// POST /api/webhook  (set this URL in Paystack dashboard -> Settings -> API Keys & Webhooks)
// Makes sure the key is emailed even if the buyer closes the browser after paying.
async function webhookPost({ request, env }) {
  const raw = await request.text();
  const sig = request.headers.get("x-paystack-signature") || "";
  const expected = await hmacHex("SHA-512", env.PAYSTACK_SECRET_KEY, raw);
  if (sig !== expected) return json({ error: "bad signature" }, 401);

  const event = JSON.parse(raw);
  if (event.event === "charge.success" && event.data?.reference) {
    const res = await fulfil(env, event.data.reference);
    // Non-200 makes Paystack retry later (e.g. email provider hiccup).
    if (res.status === "success" && res.emailed === false) return json({ error: "email failed" }, 500);
  }
  return json({ ok: true });
}


// GET or POST /api/validate?key=GFEA-XXXXX-XXXXX-XXXXX-XXXXX&account=12345678
// Called by the EA (MQL5 WebRequest). The first MAX_ACCOUNTS accounts that use a key
// are locked in, so one key cannot be shared with the whole world.
async function check(env, key, account) {
  key = String(key || "").trim().toUpperCase();
  account = String(account || "").trim();
  if (!/^GFEA-([A-Z0-9]{5}-){3}[A-Z0-9]{5}$/.test(key)) return { valid: false, reason: "format" };

  const rec = await env.LICENSES.get("key:" + key, "json");
  if (!rec || !rec.active) return { valid: false, reason: "unknown_or_disabled" };

  const max = Number(env.MAX_ACCOUNTS || 3);
  if (account) {
    if (!rec.accounts.includes(account)) {
      if (rec.accounts.length >= max) return { valid: false, reason: "account_limit" };
      rec.accounts.push(account);
      await env.LICENSES.put("key:" + key, JSON.stringify(rec));
    }
  }
  return { valid: true, plan: "lifetime" };
}

async function validateGet({ request, env }) {
  const u = new URL(request.url);
  return json(await check(env, u.searchParams.get("key"), u.searchParams.get("account")));
}

async function validatePost({ request, env }) {
  let b = {};
  const text = await request.text();
  try { b = JSON.parse(text); } catch { b = Object.fromEntries(new URLSearchParams(text)); }
  return json(await check(env, b.key, b.account));
}

const routes = {
  "/api/init": { POST: initPost },
  "/api/status": { GET: statusGet },
  "/api/webhook": { POST: webhookPost },
  "/api/validate": { GET: validateGet, POST: validatePost },
};

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const route = routes[pathname];
    if (route) {
      const handler = route[request.method];
      if (!handler) return new Response("Method not allowed", { status: 405 });
      return handler({ request, env, ctx });
    }
    return env.ASSETS.fetch(request);
  },
};
