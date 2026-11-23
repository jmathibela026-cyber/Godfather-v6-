import { json, hmacHex, fulfil } from "../_lib/fulfil.js";

// POST /api/webhook  (set this URL in Paystack dashboard -> Settings -> API Keys & Webhooks)
// Makes sure the key is emailed even if the buyer closes the browser after paying.
export async function onRequestPost({ request, env }) {
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
