/**
 * GET /api/payment/:id
 *
 * Polls the status of a payment session. Called every 10 seconds by the
 * merchant's browser after generating a QR code.
 *
 * Flow:
 *   1. Validate UUID format (blocks KV lookup on garbage input)
 *   2. Load session from KV
 *   3. Short-circuit if already confirmed (no RPC call needed)
 *   4. Check expiry — reject if past the 30-minute window
 *   5. If MONERO_RPC_URL is set, call monero-wallet-rpc to check on-chain
 *   6. Re-check expiry after RPC (RPC can be slow — prevents confirming late payments)
 *   7. Return current payment state
 *
 * Required KV binding:  PAYMENTS  (namespace: payxmr-payments)
 * Optional env var:     MONERO_RPC_URL  — full URL to monero-wallet-rpc instance.
 *                       Should use a VIEW-ONLY wallet (has view key, no spend key).
 *                       Recommend setting --rpc-login user:pass and including
 *                       credentials in the URL: http://user:pass@host:18083
 *
 * Without MONERO_RPC_URL the endpoint still works — it returns 'pending'
 * indefinitely until the merchant taps the manual confirm button in the UI.
 */

// Validate that :id is a proper v4 UUID before hitting KV.
// Prevents unnecessary KV reads and potential key-injection abuse.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function onRequestGet({ params, env }) {
  const headers = { 'Content-Type': 'application/json' };
  const { id } = params;

  if (!UUID_RE.test(id)) {
    return new Response(JSON.stringify({ error: 'Invalid payment ID' }), { status: 400, headers });
  }

  const raw = await env.PAYMENTS.get(`payment:${id}`);
  if (!raw) {
    // Either expired from KV naturally or never existed
    return new Response(JSON.stringify({ error: 'Payment not found' }), { status: 404, headers });
  }

  const payment = JSON.parse(raw);

  // Already confirmed — skip all checks and return immediately.
  // Confirmed payments have a 24h KV TTL so receipts stay accessible.
  if (payment.status === 'confirmed') {
    return new Response(JSON.stringify(payment), { headers });
  }

  // Expiry check BEFORE the RPC call — the RPC can take several seconds.
  // If we checked after RPC, a payment received at 29:58 could be confirmed
  // at 30:02 after the slow RPC response, which is past the merchant's window.
  if (Date.now() > payment.expires) {
    if (payment.status !== 'expired') {
      payment.status = 'expired';
      // Use a shorter TTL for expired sessions — no need to keep them long.
      // Don't use the original TTL (it resets the clock); 1800s = 30 min.
      await env.PAYMENTS.put(`payment:${id}`, JSON.stringify(payment), { expirationTtl: 1800 });
    }
    return new Response(JSON.stringify(payment), { headers });
  }

  // Live on-chain detection via monero-wallet-rpc (optional).
  // If not configured, the merchant uses the manual confirm button in the UI.
  if (env.MONERO_RPC_URL) {
    const confirmed = await checkWalletRpc(env.MONERO_RPC_URL, payment);

    // Re-check expiry here — RPC call could have taken several seconds.
    // This is the critical double-check that prevents confirming a late payment.
    if (confirmed && Date.now() <= payment.expires) {
      payment.status = 'confirmed';
      payment.confirmedAt = Date.now();
      // Promote to 24h TTL so merchant can reference the confirmed session later
      await env.PAYMENTS.put(`payment:${id}`, JSON.stringify(payment), { expirationTtl: 86400 });
    }
  }

  return new Response(JSON.stringify(payment), { headers });
}

/**
 * Calls monero-wallet-rpc to check whether a matching transfer has arrived.
 *
 * Uses get_transfers (in + pending) so unconfirmed transactions trigger
 * the success screen immediately — merchants don't wait for full confirmation.
 * For small retail payments this is safe; large transfers should wait for
 * confirmations (not implemented here — out of scope for point-of-sale).
 *
 * Amount matching uses piconero (1 XMR = 1,000,000,000,000 piconero) because
 * that's the unit monero-wallet-rpc returns. The 1000 piconero tolerance
 * (~$0.0000002) absorbs floating-point rounding that occurs when the frontend
 * converts USD → XMR → piconero across multiple decimal operations.
 *
 * Address matching is critical for merchants who use subaddresses or run
 * a single wallet-rpc against multiple addresses — we only confirm if the
 * payment landed on the exact address the QR code was generated for.
 */
async function checkWalletRpc(rpcUrl, payment) {
  // Convert XMR amount to piconero for comparison with wallet-rpc response
  const targetPiconero = Math.round(payment.amount * 1e12);

  // Accept transfers timestamped up to 60s before the payment was created.
  // Buffer accounts for clock skew between the CF edge and the Monero node,
  // and for the case where the customer scanned and sent before the session
  // was fully written to KV.
  const cutoffMs = payment.created - 60_000;

  try {
    const resp = await fetch(`${rpcUrl}/json_rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '0',
        method: 'get_transfers',
        params: {
          in: true,      // confirmed incoming transfers
          pending: true, // unconfirmed incoming transfers (in mempool)
          filter_by_height: false, // don't restrict by block height — check all
        },
      }),
      // Hard timeout — CF Workers have a 30s CPU limit; 8s leaves headroom
      // for the rest of the request processing on slow RPC nodes.
      signal: AbortSignal.timeout(8000),
    });

    const data = await resp.json();

    // Merge confirmed and pending into one list to check
    const transfers = [
      ...(data.result?.in || []),
      ...(data.result?.pending || []),
    ];

    for (const tx of transfers) {
      const txMs = tx.timestamp * 1000; // wallet-rpc gives seconds, we use ms

      if (
        txMs >= cutoffMs &&                                  // not too old
        Math.abs(tx.amount - targetPiconero) <= 1000 &&      // amount matches (within tolerance)
        tx.address === payment.address                        // right address (critical)
      ) {
        return true;
      }
    }

    return false;
  } catch (e) {
    // RPC unreachable or timed out — log it and fall back gracefully.
    // The merchant will see "Waiting…" and can use manual confirm.
    console.error('wallet-rpc check failed:', e.message);
    return false;
  }
}
