# Tailscale Network Topology Dashboard

Real-time web app that visualizes your Tailscale network: interactive topology map, live device status over WebSocket, device details, and Prometheus metrics for Grafana.

## Container image

Production image is built from a **Docker Hardened Image**:

- Base: `dhi.io/node:24-alpine` (runtime), built with `dhi.io/node:24-alpine-dev`
- Runs as non-root `node` (uid 1000), no shell in the final image
- `docker scout`: **0 critical / 0 high** vulnerabilities

> First pull may ask you to authenticate once: `docker login dhi.io` (any Docker ID works; the image has a public entitlement).

## Prerequisites

- Docker with Compose v2 (`docker compose version`)
- A Tailscale API key + tailnet name (optional — without them the app runs in **demo mode** with sample data)

Get a key: [Tailscale Admin Console](https://login.tailscale.com/admin) → **Settings → Keys** → Generate API key with `devices:read` (add `devices:write`, `network:read` if you want write operations). Your tailnet name is the `{tailnet}` in `https://login.tailscale.com/admin/machines/{tailnet}` (or the suffix in `device.{tailnet}.ts.net`).

## Start the container

### Option A — Compose (recommended)

```bash
cp .env.example .env   # fill in TAILSCALE_API_KEY / TAILSCALE_TAILNET
./docker-start.sh      # builds, picks a free host port (5000+), and starts
```

The start script checks whether port 5000 is occupied and increments until it finds a free one, then prints the actual URL (e.g. `http://localhost:5001`). Override the starting port with `HOST_PORT=6000 ./docker-start.sh`. The container itself always listens on `PORT` (default 5000); only the host-side mapping moves.

Open the printed URL (default <http://localhost:5000>).

| Variable | Required | Default | What it does |
|---|---|---|---|
| `TAILSCALE_API_KEY` | No (demo mode without it) | — | Tailscale API key |
| `TAILSCALE_TAILNET` | No (demo mode without it) | — | Your tailnet name |
| `PORT` | No | `5000` | Port the server listens on inside the container |
| `DATABASE_URL` | No | in-memory | Postgres URL (unused by default; storage is in-memory) |
| `ALLOWED_ORIGINS` | No | same-origin | Comma-separated CORS origins |
| `NODE_ENV` | No | `production` | Set by Compose/Dockerfile |

### Option B — Plain `docker run`

```bash
docker build -t tailscale-visualizer .
docker run -d --name tailscale-viz -p 5000:5000 \
  -e TAILSCALE_API_KEY=your_key \
  -e TAILSCALE_TAILNET=your_tailnet \
  tailscale-visualizer
```

Without credentials it still works (demo data):

```bash
docker run -d --name tailscale-viz -p 5000:5000 tailscale-visualizer
```

### Check it's healthy

```bash
curl http://localhost:5000/api/network/stats   # JSON stats, 200 = up
curl http://localhost:5000/metrics              # Prometheus metrics
docker inspect --format='{{.State.Health.Status}}' tailscale-viz  # healthy
docker logs tailscale-viz | tail
```

### Stop / update

```bash
docker compose down            # or: docker stop tailscale-viz && docker rm tailscale-viz
docker compose up --build -d   # rebuild after pulling new code
```

> Note: `docker-start.sh` and `docker-compose.grafana.yml` in this repo still reference the old `6000:3000` port mapping and are **not** the supported path — use `docker-compose.yml` (5000:5000) above. The Grafana stack is optional/legacy; the app's own `/metrics` endpoint is what you scrape (see below).

## Using the dashboard

Open <http://localhost:5000>:

### Entering credentials in the browser

Click the **gear icon** in the header to open the Tailscale connection dialog — no need to edit `.env` or restart the container:

- **API key** field masks every character (`••••`) like a password. Tick **“Make secret visible”** to reveal it while typing.
- **Tailnet name** is a plain text field (pre-filled with the current value when known).
- **Save & connect** verifies the key against the live Tailscale API first — a typo returns an error and nothing is stored — then refreshes the dashboard.
- **Forget** removes the browser-entered credentials and reverts to environment variables (or demo mode).
- The status badge shows where credentials come from (“Configured in browser ••••last4”, “Configured via environment”, or demo mode). The full key is never sent back to the browser.

Browser-entered credentials live in server memory only — a container restart clears them (use `.env`/Compose environment for persistence).

### Views

- **Network Topology** tab — interactive map of devices and connections. Zoom in/out, reset view, click a node for details.
- **Device Chart** tab — status donut and per-type bars (live, follows search), plus a compact device list; click a row for details.
- **Header** — live connection dot (green = WebSocket connected), tailnet name (coordinator hostname, device domain, or configured tailnet — never the demo fallback with real data), device search (name/hostname/IP), refresh button (re-pulls from the Tailscale API), **settings (gear) button for entering your Tailscale API key + tailnet in the browser**, dark/light toggle, notifications bell (static count).
- **Sidebar** — online/offline/unstable counts, status filters, device-type counts, live recent-activity feed (seeded from current devices, appended on every WebSocket device update).
- **Device modal** — click any device: status, IP, last seen, OS, hostname, tags. SSH/Ping buttons are stubs (they only log; no connection is opened).

## API reference

Base URL `http://localhost:5000`. All responses are JSON unless noted.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/network/topology` | `{ devices, connections, stats }` |
| `GET` | `/api/devices` | List all devices |
| `GET` | `/api/devices/:id` | One device (`400` bad id, `404` unknown) |
| `POST` | `/api/devices` | Create device (body validated with Zod; `400` + `details` on error) |
| `PATCH` | `/api/devices/:id` | Partial update, e.g. `{"status":"unstable"}` |
| `DELETE` | `/api/devices/:id` | Delete device (`204`, cascades its connections) |
| `GET` | `/api/network/stats` | `{ totalDevices, onlineDevices, offlineDevices, unstableDevices, … }` — also the health probe |
| `POST` | `/api/network/simulate` | Randomly flips one device's status (demo mode only; `404` when empty) |
| `POST` | `/api/network/refresh` | Re-sync from Tailscale API (falls back to `tailscale-devices.json`, then sample data) |
| `GET` | `/api/debug/tailscale` | `not_configured` / `success` (device count) / `error` (`permission_denied`, `unauthorized`) — safe to expose, never returns the key |
| `POST` | `/api/devices/import` | Bulk import from a Tailscale export payload (replaces all devices) |
| `POST` | `/api/config/tailscale` | Save browser-entered `{apiKey, tailnet}` (verified live first; `400` invalid, `502` unverifiable). Never echoes the key |
| `DELETE` | `/api/config/tailscale` | Forget browser credentials, revert to env/demo |
| `GET` | `/api/config/tailscale` | Credential status (`configured`, `source`, `tailnet`, `keyLast4`) — no secret |
| `GET` | `/metrics` | Prometheus text format (`text/plain`) |

Examples:

```bash
# topology + stats
curl http://localhost:5000/api/network/topology | head -c 300; echo
curl http://localhost:5000/api/network/stats

# create → update → delete
curl -X POST http://localhost:5000/api/devices -H 'Content-Type: application/json' -d \
  '{"name":"demo-1","hostname":"demo-1.ts.net","tailscaleId":"demo-1","ipAddress":"100.64.0.50","deviceType":"server","os":"Linux","status":"connected","tags":[],"isCoordinator":false}'
curl -X PATCH http://localhost:5000/api/devices/1 -H 'Content-Type: application/json' -d '{"status":"unstable"}'
curl -X DELETE http://localhost:5000/api/devices/8 -w 'HTTP:%{http_code}\n'

# bulk import from a Tailscale status export (replaces everything)
curl -X POST http://localhost:5000/api/devices/import -H 'Content-Type: application/json' -d @tailscale-export.json
```

### Real-time updates (`/ws`)

Connect to `ws://localhost:5000/ws` (or `wss://` behind TLS). The server sends `{ type, data }`:

- `initial_topology` on connect (full `{ devices, connections, stats }`)
- `device_status`, `device_connected`, `device_disconnected`, `stats_updated`

### Prometheus + Grafana

Scrape `http://<host>:5000/metrics`. Series exported:

- `tailscale_total_devices`, `tailscale_online_devices`, `tailscale_offline_devices`, `tailscale_unstable_devices`
- `tailscale_devices_by_status{status="connected|disconnected|unstable"}`
- `tailscale_device_info{name,hostname,type,os,status}` (value `1` per device; label values are Prometheus-escaped)

Minimal `prometheus.yml` job:

```yaml
scrape_configs:
  - job_name: tailscale
    static_configs:
      - targets: ['tailscale-viz:5000']
```

## Local development (no Docker)

```bash
npm install
cp .env.example .env   # fill in credentials for live data, or skip for demo mode
npm run dev            # NODE_ENV=development tsx server/index.ts → http://localhost:5000
npm run check          # tsc --noEmit (also runs as part of build)
npm run build && npm start
```

Stack: React 19 + Vite 8 + Tailwind 4 frontend; Express 5 + `ws` backend; in-memory storage (`server/storage.ts`); shared Zod/Drizzle schema (`shared/schema.ts`); rate-limited (`/api/`, 300 req/15 min), `helmet` headers, CORS via `ALLOWED_ORIGINS`.

## Secrets policy — nothing secret is ever committed or shipped

- **Git**: real credentials live only in `.env`, which is git-ignored (along with `*.pem`, `*.key`, `secrets/`). Only `*.example` placeholder files are tracked. Run `npm run setup:hooks` once per clone to block secret-bearing commits locally (pre-commit hook → `npm run check:secrets`, which fails on anything resembling a real key/token), and CI (`.github/workflows/secret-scan.yml`) enforces the same check on every push/PR.
- **Browser-entered keys**: the settings dialog stores the API key in server memory only, never writes it to disk, never logs it, and the status API exposes at most its last 4 characters.
- **Docker image**: `.dockerignore` excludes all `.env*` files, the `Dockerfile` sets no secret `ARG`/`ENV`, and the final image contains only `dist/`, `node_modules/`, and `package.json` (verified — no `.env` in `/app`, no secrets in image config).

## Troubleshooting

- **Empty dashboard / demo data**: normal without `TAILSCALE_API_KEY`+`TAILSCALE_TAILNET`. Check `GET /api/debug/tailscale` — `permission_denied` means the key lacks `devices:read`; `unauthorized` means bad key/tailnet.
- **Container unhealthy**: the probe hits `/api/network/stats` inside the container. Check `docker logs`, and confirm nothing else occupies host port 5000.
- **`dhi.io` pull fails**: run `docker login dhi.io` once, then retry the build.
- **WebSocket shows disconnected**: the UI connects to `/ws` on the same host — serve the frontend from the container (don't open `dist/public` files directly) and check for proxies stripping Upgrade headers.
