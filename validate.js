import { json } from "../_lib/fulfil.js";

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

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  return json(await check(env, u.searchParams.get("key"), u.searchParams.get("account")));
}

export async function onRequestPost({ request, env }) {
  let b = {};
  const text = await request.text();
  try { b = JSON.parse(text); } catch { b = Object.fromEntries(new URLSearchParams(text)); }
  return json(await check(env, b.key, b.account));
}
