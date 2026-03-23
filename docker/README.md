# Live Payment Detection — Docker Setup

This sets up `monero-wallet-rpc` in Docker so PayXMR can automatically detect
when a customer's payment arrives on-chain. Without this, merchants tap a manual
confirm button instead.

---

## Prerequisites

- Docker + Docker Compose
- Cloudflare Tunnel (you already have this)
- Your Monero wallet's **private view key** (NOT your spend key)

---

## Step 1 — Get your private view key

In **Cake Wallet:**
Settings → Your wallet → Show seed/keys → Copy "Private View Key"

In **Monerujo:**
Settings → Show spend/view keys → Copy "Private View Key"

Your view key looks like: `a1b2c3...` (64 hex chars)
Your address looks like: `4...` (95 chars)

---

## Step 2 — Create the view-only wallet file

Run this once to generate the wallet files. Replace the placeholders:

```bash
cd docker
mkdir -p wallet

docker run --rm -v $(pwd)/wallet:/wallet \
  sethsimmons/simple-monero-wallet-rpc:latest \
  monero-wallet-cli \
  --generate-from-view-key /wallet/payxmr \
  --address YOUR_MONERO_ADDRESS \
  --viewkey YOUR_PRIVATE_VIEW_KEY \
  --password "" \
  --daemon-address node.moneroworld.com:18089 \
  --non-interactive \
  --restore-height 0
```

This creates three files in `./wallet/`:
- `payxmr` — wallet data
- `payxmr.keys` — encrypted key file (view key only, no spend key)
- `payxmr.address.txt` — your address

---

## Step 3 — Configure

```bash
cp .env.example .env
# Edit .env — set a strong RPC_LOGIN password
```

---

## Step 4 — Start

```bash
docker compose up -d
docker compose logs -f   # watch it sync (fast — view-only with remote node)
```

Test it's working:
```bash
curl -u payxmr:changeme http://localhost:18083/json_rpc \
  -d '{"jsonrpc":"2.0","id":"0","method":"get_version"}' \
  -H 'Content-Type: application/json'
# Should return: {"id":"0","jsonrpc":"2.0","result":{"version":...}}
```

---

## Step 5 — Expose via Cloudflare Tunnel

Add this to your Cloudflare Tunnel config (`~/.cloudflared/config.yml`):

```yaml
ingress:
  - hostname: rpc.payxmr.app     # or any subdomain you control
    service: http://localhost:18083
    originRequest:
      noTLSVerify: false
  # ... your other tunnel entries
```

Then restart cloudflared:
```bash
brew services restart cloudflared
# or: launchctl stop/start com.cloudflare.cloudflared
```

---

## Step 6 — Set MONERO_RPC_URL in Cloudflare Pages

Go to Cloudflare Dashboard → Pages → payxmr → Settings → Environment Variables

Add:
```
MONERO_RPC_URL = https://payxmr:changeme@rpc.payxmr.app
```

(Include the `user:pass@` credentials in the URL — the backend passes them with every RPC call.)

Redeploy the Pages project for the variable to take effect.

---

## Security notes

- The wallet file contains your **view key only** — no spend key, no funds at risk
- RPC is bound to `127.0.0.1` — not reachable from the internet directly
- Cloudflare Tunnel provides TLS — traffic is encrypted end-to-end
- Always set a strong `RPC_LOGIN` password — it's the only thing protecting your transaction history from being read by anyone who finds the tunnel URL

---

## Auto-start on Mac

Docker containers already restart automatically (`restart: unless-stopped`).
Make sure Docker Desktop is set to start at login.
