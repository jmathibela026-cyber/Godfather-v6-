# GodFatherEA Shop: Setup Guide

Everything is free to host. Total setup is about 30 minutes.

## How it works

1. Client opens your site, enters name + email, taps **Pay**.
2. Paystack's secure page takes the payment (card / instant EFT).
3. Paystack tells your server the payment succeeded.
4. Server creates a lifetime key, emails it, and shows it on the success page.

## Files

```
index.html          checkout page (edit CONFIG at the bottom)
success.html        shows the key after payment
assets/             images
functions/api/      backend (runs on Cloudflare)
  init.js           starts the Paystack payment
  status.js         confirms payment, returns key
  webhook.js        Paystack calls this, so the email is sent even if the client closes the page
  validate.js       your EA calls this to check a key
functions/_lib/fulfil.js   shared logic
```

## Step 1: Put it on Cloudflare Pages (not GitHub Pages)

GitHub Pages can't run the backend, so use Cloudflare Pages. It connects to GitHub.

1. Upload this folder to a GitHub repo.
2. Cloudflare dashboard > **Workers & Pages** > **Create** > **Pages** > connect the repo.
3. Build command: leave empty. Output directory: `/`.
4. Deploy. You get a `yourname.pages.dev` link. Add your own domain later under **Custom domains**.

## Step 2: Create the key storage (KV)

1. Cloudflare > **Storage & Databases** > **KV** > **Create namespace**, name it `licenses`.
2. Your Pages project > **Settings** > **Bindings** > **Add** > **KV namespace**.
   - Variable name: `LICENSES`  (exactly this)
   - Namespace: `licenses`

## Step 3: Paystack

1. Sign up at paystack.com and finish business verification (needed to go live).
2. **Settings > API Keys & Webhooks**:
   - Copy your **Secret key** (`sk_live_...`; use `sk_test_...` first to test).
   - Webhook URL: `https://YOUR-SITE/api/webhook`

## Step 4: Email (Resend)

1. Sign up at resend.com, add and verify your domain (adds a few DNS records).
2. Create an API key.
3. Without your own domain, emails will land in spam, so do verify one.

## Step 5: Environment variables

Pages project > **Settings > Variables and Secrets** (mark the secrets as Secret):

| Name | Value |
|---|---|
| `PAYSTACK_SECRET_KEY` | `sk_test_...` then `sk_live_...` |
| `LICENSE_SECRET` | any long random text (e.g. 40 random characters). **Never change it later** or old keys stop matching |
| `PRICE_CENTS` | price x 100. R200 = `20000` |
| `CURRENCY` | `ZAR` |
| `RESEND_API_KEY` | from Resend |
| `EMAIL_FROM` | `GodFatherEA <licenses@yourdomain.com>` |
| `SUPPORT_EMAIL` | your support email |
| `MAX_ACCOUNTS` | how many trading accounts one key may use (default 3) |

Then **redeploy**. Also edit `CONFIG` at the bottom of `index.html` (displayed price, your WhatsApp number, support email). The displayed price must match `PRICE_CENTS`; the server always charges `PRICE_CENTS`, so nobody can change the price in their browser.

## Step 6: Test before going live

1. Use the `sk_test_` key and Paystack's test card: `4084 0840 8408 4081`, any future expiry, CVV `408`.
2. Pay with your own email. You should get the email and see the key on the success page.
3. Check the key works: open `https://YOUR-SITE/api/validate?key=YOUR-KEY` and look for `{"valid":true,...}`.
4. Swap in the `sk_live_` key and redeploy.

## Step 7: Make the EA check the key (MQL5)

Without this the key does nothing, because a key that the EA never checks doesn't protect anything.

1. In MetaTrader: **Tools > Options > Expert Advisors > Allow WebRequest for listed URL** and add `https://YOUR-SITE`. Tell clients to do this too (put it in your setup instructions).
2. Add an input `input string LicenseKey = "";` and call this in `OnInit()`:

```mql5
bool CheckLicense()
{
   string url  = "https://YOUR-SITE/api/validate?key=" + LicenseKey +
                 "&account=" + (string)AccountInfoInteger(ACCOUNT_LOGIN);
   char post[], result[];
   string headers;
   int code = WebRequest("GET", url, "", 5000, post, result, headers);
   if(code != 200) { Print("License check failed, HTTP ", code); return false; }
   string body = CharArrayToString(result);
   return StringFind(body, "\"valid\":true") >= 0;
}

int OnInit()
{
   if(!CheckLicense())
   {
      Alert("GodFatherEA: invalid or missing license key.");
      return INIT_FAILED;
   }
   return INIT_SUCCEEDED;
}
```

Also re-check once a day (in `OnTimer`) so you can disable a key later.

Important: compiled `.ex5` files can be cracked by determined people. This setup stops casual sharing; it can't stop an expert. Always distribute the `.ex5`, never the `.mq5` source.

## Managing keys

- **Disable a key** (refund / chargeback): Cloudflare > KV > `licenses` > find `key:GFEA-...` > edit the value and set `"active":false`.
- **Reset a client's accounts**: same place, set `"accounts":[]`.
- **Resend a lost key**: the key is the same every time. Find it by searching the KV for the client's email, and email it to them.
- Payments and refunds are all visible in your Paystack dashboard.

## Before you launch

- Add a short Terms and Refund policy (SA consumer rules apply, and Paystack asks for it).
- Never put your `sk_` secret key in `index.html`. It only goes in Cloudflare variables.
