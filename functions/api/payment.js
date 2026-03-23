/**
 * POST /api/payment
 *
 * Creates a new payment session and stores it in Cloudflare KV.
 * Returns a UUID that the frontend polls against /api/payment/:id.
 *
 * Required KV binding:  PAYMENTS  (namespace: payxmr-payments)
 * Optional env var:     MONERO_RPC_URL  (enables live on-chain detection)
 *
 * No private keys are handled here. The merchant's Monero address is
 * a public value — safe to store and return.
 */

const HEADERS = {
  'Content-Type': 'application/json',
  // Locked to payxmr.app — browsers will block cross-origin POST attempts
  // from any other origin. Not needed for same-origin requests but explicit
  // is better than open (*).
  'Access-Control-Allow-Origin': 'https://payxmr.app',
};

// Standard Monero address:  starts with 4, exactly 95 base58 chars
// Subaddress:               starts with 8, exactly 95 base58 chars
// Integrated address:       starts with 4, exactly 106 base58 chars
// Testnet addresses (9/A) are intentionally rejected — this is mainnet only.
const XMR_ADDRESS_RE = /^[48][0-9A-Za-z]{94}([0-9A-Za-z]{11})?$/;

// Max payment session: 10,000 XMR (~$1.7M at current prices).
// Prevents absurd float values and edge-case piconero overflow.
const MAX_XMR = 10_000;

// KV-based rate limiter: 10 payment creations per IP per minute.
//
// Limitation: KV reads and writes are not atomic. Two simultaneous
// requests from the same IP can both read count=0 and both increment
// to 1, allowing a small burst above the limit. For a payment app
// at this scale that's acceptable — a proper atomic counter would
// require Durable Objects.
//
// Window: fixed clock minute (e.g. :00→:59). A determined caller can
// fire 10 at :59 and 10 at :01 = 20 in 2 seconds. Acceptable tradeoff
// for simplicity. TTL of 120s ensures keys from both sides of the
// boundary are cleaned up promptly.
async function checkRateLimit(env, ip) {
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const key = `rl:${ip}:${minuteBucket}`;
  const count = parseInt(await env.PAYMENTS.get(key) || '0');
  if (count >= 10) return false;
  // Write the incremented count; TTL covers the current minute + one full
  // extra minute so the key is still readable if the clock ticks over.
  await env.PAYMENTS.put(key, String(count + 1), { expirationTtl: 120 });
  return true;
}

export async function onRequestPost({ request, env }) {
  try {
    // CF-Connecting-IP is injected by Cloudflare's edge — always present
    // in production. Falls back to 'unknown' only in local wrangler dev.
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!await checkRateLimit(env, ip)) {
      return new Response(
        JSON.stringify({ error: 'Too many requests — try again in a minute' }),
        { status: 429, headers: HEADERS }
      );
    }

    const { address, amount, note } = await request.json();

    // Validate address format before touching amount — fail fast on the
    // most likely bad input (typo/wrong chain address).
    if (!address || !XMR_ADDRESS_RE.test(address)) {
      return new Response(
        JSON.stringify({ error: 'Invalid Monero address' }),
        { status: 400, headers: HEADERS }
      );
    }

    const parsed = parseFloat(amount);
    if (!amount || isNaN(parsed) || parsed <= 0 || parsed > MAX_XMR) {
      return new Response(
        JSON.stringify({ error: `Amount must be between 0 and ${MAX_XMR} XMR` }),
        { status: 400, headers: HEADERS }
      );
    }

    const id = crypto.randomUUID(); // 128-bit cryptographically random — unguessable

    const payment = {
      id,
      address,                              // merchant's public XMR address
      amount: parsed,                       // in XMR (converted to piconero on RPC check)
      note: note ? String(note).slice(0, 200) : null,  // 200-char cap prevents KV bloat
      status: 'pending',                    // pending | confirmed | expired
      created: Date.now(),                  // ms — used as RPC transfer cutoff
      expires: Date.now() + 30 * 60 * 1000, // 30-minute payment window
      backendEnabled: !!env.MONERO_RPC_URL, // tells frontend whether live detection is active
    };

    // KV TTL: 1 hour — covers the 30-min window + buffer for late confirmations.
    // Confirmed payments get promoted to 24h TTL in /api/payment/:id.
    await env.PAYMENTS.put(`payment:${id}`, JSON.stringify(payment), {
      expirationTtl: 3600,
    });

    // Only return id and backendEnabled — never echo back the full payment
    // object here (address/amount will come from the GET poll instead).
    return new Response(
      JSON.stringify({ id, backendEnabled: payment.backendEnabled }),
      { headers: HEADERS }
    );
  } catch (e) {
    // Log the real error server-side; return a generic message to the client
    // so internal implementation details aren't exposed.
    console.error('payment create error:', e.message);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: HEADERS }
    );
  }
}

// Handles CORS preflight from the browser before the actual POST.
// Required because the request has a Content-Type: application/json header.
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://payxmr.app',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
