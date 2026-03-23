/**
 * GET /api/price
 *
 * Returns the current XMR/USD price as a simple { usd: number } object.
 *
 * Acts as a proxy to CoinGecko's free API for two reasons:
 *   1. Cloudflare edge caching — the { cf: cacheTtl } option means only
 *      one actual CoinGecko request is made per 60 seconds globally,
 *      regardless of how many merchants are using the app simultaneously.
 *   2. Avoids exposing a CoinGecko API key in client-side code (not needed
 *      for the free tier, but good practice).
 *
 * Cache-Control: public, max-age=60 tells the browser it can also cache
 * the response for 60 seconds — reduces requests to this function entirely.
 *
 * If CoinGecko is unreachable, returns { usd: null } so the frontend can
 * fall back to direct CoinGecko fetch or prompt the merchant to enter XMR
 * amount directly instead of USD.
 *
 * No env bindings required — this function is stateless.
 */
export async function onRequestGet() {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=60',
  };

  try {
    const resp = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd',
      {
        // CF-specific cache directive — caches at the edge for 60 seconds.
        // This is separate from the Cache-Control header sent to browsers.
        cf: { cacheTtl: 60, cacheEverything: true },
      }
    );
    const data = await resp.json();
    // Null-coalesce: if CoinGecko changes their response shape, return null
    // rather than throwing — the frontend handles null gracefully.
    return new Response(JSON.stringify({ usd: data?.monero?.usd ?? null }), { headers });
  } catch (e) {
    // CoinGecko unreachable — return null so the app degrades gracefully.
    // Frontend fallback: direct CoinGecko fetch, then "enter XMR directly" prompt.
    return new Response(JSON.stringify({ usd: null }), { headers });
  }
}
