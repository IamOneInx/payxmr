# PayXMR

**Accept Monero payments anywhere. No app, no account, no fees.**

PayXMR is a free, open-source web app that lets any merchant generate a Monero payment QR code in seconds. Customers scan it with any Monero wallet. Money goes directly wallet-to-wallet — PayXMR sees nothing and takes nothing.

🌐 **Live at [payxmr.app](https://payxmr.app)**

---

## How it works

**Merchant** opens payxmr.app/app → enters amount → shows QR
**Customer** scans with Cake Wallet, Monerujo, Feather, etc. → sends XMR
**Merchant** sees confirmation → done

No sign-up. No merchant account. No payment processor taking 3%. Just Monero.

---

## Architecture

```
payxmr.app (Cloudflare Pages)
├── /                  → Marketing landing page (static HTML)
├── /app               → Payment app (PWA, static HTML + JS)
└── /functions/api/
    ├── price.js       → GET  /api/price        — XMR/USD via CoinGecko (edge cached)
    ├── payment.js     → POST /api/payment       — Create payment session in KV
    └── payment/
        └── [id].js    → GET  /api/payment/:id  — Poll status, optional wallet-rpc check
```

**Storage:** Cloudflare KV (`payxmr-payments`) — payment sessions expire automatically
**No database.** No user accounts. No server state beyond 30-minute payment windows.

### Payment detection modes

| Mode | Setup required | How it works |
|---|---|---|
| **Manual confirm** | None | Merchant taps "Customer confirmed payment" |
| **Live detection** | `MONERO_RPC_URL` env var | Backend polls `monero-wallet-rpc` every 10s |

Live detection uses a **view-only wallet** — it can see incoming transactions but has no spend key. Funds are never at risk.

---

## Self-hosting

PayXMR runs on Cloudflare Pages (free tier). Deploy your own instance:

```bash
# 1. Clone
git clone https://github.com/IamOneInx/payxmr.git
cd payxmr

# 2. Deploy to Cloudflare Pages
npx wrangler pages deploy . --project-name my-payxmr

# 3. Create KV namespace and bind it
npx wrangler kv namespace create payxmr-payments
# Add the namespace ID to your Pages project as binding: PAYMENTS
```

### Enable live payment detection (optional)

Run `monero-wallet-rpc` with a view-only wallet and set `MONERO_RPC_URL` in your Pages environment variables.

See [docker/README.md](docker/README.md) for the full Docker + Cloudflare Tunnel setup.

---

## Security

- **No private keys** — the app only ever handles public Monero addresses
- **View-only wallet** — wallet-rpc has no spend capability
- **Rate limiting** — 10 payment sessions per IP per minute
- **Input validation** — Monero address format, amount bounds, UUID format
- **SRI on CDN scripts** — QR library integrity verified by the browser
- **CORS locked** — API only accepts requests from payxmr.app

---

## Monero URI format

Payment QR codes use the standard Monero URI scheme:

```
monero:<address>?tx_amount=<xmr>&tx_description=<note>
```

Compatible with all major Monero wallets.

---

## Contributing

PRs welcome. The codebase is intentionally small — three backend functions and one frontend HTML file. Every non-obvious decision is commented in the code.

**Good first issues:**
- PWA icons (192px and 512px SVG-to-PNG)
- Sliding window rate limiter using Durable Objects
- Multi-language support for the merchant UI

---

## License

MIT — do whatever you want with it. Attribution appreciated but not required.

---

*Built to make Monero usable at your local coffee shop.*
