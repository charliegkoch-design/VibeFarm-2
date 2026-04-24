# VibeFarm Cloud

Multiplayer backend for VibeFarm — built with **Cloudflare Workers + Durable Objects** in TypeScript.

Each "world" is a Durable Object with its own persistent state and a WebSocket fan-out. Players host a world, share the 6-character room code (or a direct URL) with friends, and join together in real time.

## Deploy in 2 minutes

### 1. Install dependencies

```bash
cd cloud
npm install
```

### 2. Log in to Cloudflare

```bash
npx wrangler login
```

(Opens a browser, click "Allow". Free account is fine — Durable Objects & WebSockets are included.)

### 3. Deploy

```bash
npm run deploy
```

Wrangler will print a URL like:

```
Published vibefarm-cloud
https://vibefarm-cloud.<your-subdomain>.workers.dev
```

### 4. Plug the URL into the game

In VibeFarm, click the ⚙️ Settings button (bottom-right) → paste your URL into **"Cloud server URL"** and press Save.

That's it — click **🌐 Multiplayer** → **Host World**, share the room code with a friend, and play together.

## How it works

- `POST /rooms` → Creates a new room, returns `{ code: "ABC123" }`.
- `GET /rooms/:code/ws` → Upgrades to WebSocket. Clients exchange these messages:

| Direction | Type | Purpose |
|---|---|---|
| C→S | `snap` | Position + tool snapshot (5Hz) |
| C→S | `action` | Tile change, chop, mine, build, etc. |
| C→S | `chat` | Chat message (max 200 chars) |
| C→S | `world-snapshot` | Host uploads the full world for persistence |
| C→S | `rename` | Change display name |
| S→C | `welcome` | Sent on join with peer list + stored world |
| S→C | `peer-join` / `peer-leave` | Another player connected/left |
| S→C | `snap` | Other player's position update |
| S→C | `action` | Tile/entity change from a peer |
| S→C | `chat` | Chat from another player |
| S→C | `peer-rename` | Someone changed their name |

World state persists in the Durable Object's KV-style storage between sessions, so people returning to the same room code pick up where they left off.

## Local development

```bash
npm run dev
```

Starts `wrangler dev` at `http://localhost:8787`. Use `ws://localhost:8787` as the cloud URL in the game to test locally.

## Costs

Cloudflare's free plan covers:
- 100,000 Worker requests / day
- 400,000 Durable Object GB-seconds / day
- Unlimited WebSocket time while hibernating

For a small group of friends this is effectively free.

## Architecture

```
Browser A ─┐
           │  wss://your-worker/rooms/ABC123/ws
Browser B ─┼────────────→  [ Durable Object: ABC123 ]
           │                (persists world state)
Browser C ─┘
```

Every Durable Object instance lives on a single machine close to the first connecting client, so latency within a friend group is minimal.

## Data stored

Per Durable Object:
- `createdAt` — timestamp
- `world` — latest world snapshot uploaded by the host (tiles, buildings, etc.)
- WebSocket session attachments (id, name)

Nothing leaves your Cloudflare account.
