// Shared logic: verify a Paystack payment, create the lifetime key, email it.
// Runs on Cloudflare Pages Functions (Workers runtime).

const enc = new TextEncoder();

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export async function hmacHex(algo, secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: algo }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Same payment reference always produces the same key, so a double call
// (webhook + success page) can never create two different keys.
export async function makeKey(env, reference) {
  const hex = await hmacHex("SHA-256", env.LICENSE_SECRET, "license:" + reference);
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  let out = "";
  for (let i = 0; i < 20; i++) out += alphabet[parseInt(hex.substr(i * 2, 2), 16) % alphabet.length];
  return "GFEA-" + out.match(/.{5}/g).join("-");
}

export async function paystackVerify(env, reference) {
  const r = await fetch("https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference), {
    headers: { Authorization: "Bearer " + env.PAYSTACK_SECRET_KEY },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.status) return { status: "unknown" };
  return j.data;
}

export async function sendLicenseEmail(env, { email, name, key }) {
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
export async function fulfil(env, reference) {
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
