// POST /api/payment — create a new payment session
export async function onRequestPost({ request, env }) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  try {
    const { address, amount, note } = await request.json();
    if (!address || !amount) {
      return new Response(JSON.stringify({ error: 'address and amount required' }), { status: 400, headers });
    }

    const id = crypto.randomUUID();
    const payment = {
      id,
      address,
      amount: parseFloat(amount),
      note: note || null,
      status: 'pending',
      created: Date.now(),
      expires: Date.now() + 30 * 60 * 1000,
      backendEnabled: !!env.MONERO_RPC_URL,
    };

    await env.PAYMENTS.put(`payment:${id}`, JSON.stringify(payment), {
      expirationTtl: 3600,
    });

    return new Response(JSON.stringify({ id, backendEnabled: payment.backendEnabled }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
