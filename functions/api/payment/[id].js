// GET /api/payment/:id — check payment status, optionally trigger wallet-rpc check
export async function onRequestGet({ params, env }) {
  const headers = { 'Content-Type': 'application/json' };
  const { id } = params;

  const raw = await env.PAYMENTS.get(`payment:${id}`);
  if (!raw) {
    return new Response(JSON.stringify({ error: 'Payment not found' }), { status: 404, headers });
  }

  const payment = JSON.parse(raw);

  if (payment.status === 'confirmed') {
    return new Response(JSON.stringify(payment), { headers });
  }

  // Check expiry before anything else — prevents confirming a late payment
  if (Date.now() > payment.expires) {
    if (payment.status !== 'expired') {
      payment.status = 'expired';
      // Don't reset TTL — let the original KV expiry clean up naturally
      await env.PAYMENTS.put(`payment:${id}`, JSON.stringify(payment), { expirationTtl: 1800 });
    }
    return new Response(JSON.stringify(payment), { headers });
  }

  // Live check via monero-wallet-rpc if configured
  if (env.MONERO_RPC_URL) {
    const confirmed = await checkWalletRpc(env.MONERO_RPC_URL, payment);
    // Re-check expiry after the (potentially slow) RPC call
    if (confirmed && Date.now() <= payment.expires) {
      payment.status = 'confirmed';
      payment.confirmedAt = Date.now();
      await env.PAYMENTS.put(`payment:${id}`, JSON.stringify(payment), { expirationTtl: 86400 });
    }
  }

  return new Response(JSON.stringify(payment), { headers });
}

async function checkWalletRpc(rpcUrl, payment) {
  // Amount in piconero (1 XMR = 1e12 piconero)
  const targetPiconero = Math.round(payment.amount * 1e12);
  // Accept transfers from 60s before payment was created (buffer for slow backends)
  const cutoffMs = payment.created - 60_000;

  try {
    const resp = await fetch(`${rpcUrl}/json_rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '0',
        method: 'get_transfers',
        params: { in: true, pending: true, filter_by_height: false },
      }),
      signal: AbortSignal.timeout(8000),
    });

    const data = await resp.json();
    const transfers = [
      ...(data.result?.in || []),
      ...(data.result?.pending || []),
    ];

    for (const tx of transfers) {
      const txMs = tx.timestamp * 1000;
      // Tolerance: 1000 piconero (~$0.0000002) to absorb float rounding on both sides
      // Also verify the receiving address matches — critical for multi-address wallets
      if (
        txMs >= cutoffMs &&
        Math.abs(tx.amount - targetPiconero) <= 1000 &&
        tx.address === payment.address
      ) {
        return true;
      }
    }
    return false;
  } catch (e) {
    console.error('wallet-rpc check failed:', e.message);
    return false;
  }
}
