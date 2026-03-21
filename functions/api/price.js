// GET /api/price — CoinGecko proxy with CF edge caching
export async function onRequestGet({ env }) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=60',
  };

  try {
    const resp = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd',
      { cf: { cacheTtl: 60, cacheEverything: true } }
    );
    const data = await resp.json();
    return new Response(JSON.stringify({ usd: data?.monero?.usd ?? null }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ usd: null }), { headers });
  }
}
