import { json } from "../_lib/fulfil.js";

// POST /api/init  { name, email }  ->  { url }  (Paystack hosted checkout)
export async function onRequestPost({ request, env }) {
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
