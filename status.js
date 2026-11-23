import { json, fulfil } from "../_lib/fulfil.js";

// GET /api/status?reference=GF-...  -> { status, email?, key? }
// Called by success.html after Paystack redirects the buyer back.
export async function onRequestGet({ request, env }) {
  const reference = new URL(request.url).searchParams.get("reference") || "";
  if (!/^GF-[a-z0-9-]{10,60}$/i.test(reference)) return json({ status: "unknown" }, 400);
  const res = await fulfil(env, reference);
  return json(res);
}
