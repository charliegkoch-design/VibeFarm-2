// VibeFarm Cloud — multiplayer backend
// Cloudflare Workers + Durable Objects
// Each room has its own Durable Object instance that persists state and
// fans-out WebSocket messages between connected players.

export interface Env {
  ROOMS: DurableObjectNamespace;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400',
} as const;

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extraHeaders },
  });
}

function generateRoomCode(): string {
  // Unambiguous chars — no 0/O, no 1/I, no similar pairs
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // Health / root
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'vibefarm-cloud', ts: Date.now() });
    }

    // Create a new room. Returns { code }.
    if (url.pathname === '/rooms' && request.method === 'POST') {
      const code = generateRoomCode();
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);
      await stub.fetch(new Request('https://room/init', { method: 'POST' }));
      return json({ code });
    }

    // WebSocket upgrade to /rooms/:code/ws
    const m = url.pathname.match(/^\/rooms\/([A-Z0-9]+)\/ws$/i);
    if (m) {
      const code = m[1].toUpperCase();
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    return json({ error: 'not_found' }, 404);
  },
};

// ─── Durable Object per room ──────────────────────────────────────────────────

type Session = {
  ws: WebSocket;
  id: string;
  name: string;
  snap?: unknown;
};

export class Room {
  state: DurableObjectState;
  env: Env;
  sessions: Map<string, Session> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Rehydrate any hibernated WebSockets
    for (const ws of this.state.getWebSockets()) {
      const att = (ws.deserializeAttachment() as { id?: string; name?: string } | null) || {};
      if (att.id) {
        this.sessions.set(att.id, { ws, id: att.id, name: att.name || 'Player' });
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/init') {
      if (!(await this.state.storage.get('createdAt'))) {
        await this.state.storage.put('createdAt', Date.now());
      }
      return json({ ok: true });
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      const id = crypto.randomUUID().slice(0, 8);
      const name = (url.searchParams.get('name') || 'Player').slice(0, 24);

      server.serializeAttachment({ id, name });
      this.state.acceptWebSocket(server);
      this.sessions.set(id, { ws: server, id, name });

      // Welcome payload — list of existing peers with last-known snapshots,
      // and the last saved world snapshot (if any).
      const peers = Array.from(this.sessions.values())
        .filter(s => s.id !== id)
        .map(s => ({ id: s.id, name: s.name, snap: s.snap }));
      const world = await this.state.storage.get('world');

      try {
        server.send(JSON.stringify({ type: 'welcome', id, name, peers, world }));
      } catch {}

      this.broadcast({ type: 'peer-join', id, name }, id);

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('not_found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== 'string') return;
    const att = (ws.deserializeAttachment() as { id?: string } | null) || {};
    if (!att.id) return;
    const sess = this.sessions.get(att.id);
    if (!sess) return;

    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

    if (msg.type === 'snap' && msg.snap && typeof msg.snap === 'object') {
      sess.snap = msg.snap;
      this.broadcast({ type: 'snap', id: sess.id, snap: msg.snap }, sess.id);
      return;
    }

    if (msg.type === 'action' && msg.data && typeof msg.data === 'object') {
      this.broadcast({ type: 'action', id: sess.id, name: sess.name, data: msg.data }, sess.id);
      return;
    }

    if (msg.type === 'chat' && typeof msg.msg === 'string') {
      const text = msg.msg.slice(0, 200);
      this.broadcast({ type: 'chat', id: sess.id, name: sess.name, msg: text });
      return;
    }

    if (msg.type === 'world-snapshot' && msg.world && typeof msg.world === 'object') {
      // Host-authoritative world snapshot persistence
      await this.state.storage.put('world', msg.world);
      return;
    }

    if (msg.type === 'rename' && typeof msg.name === 'string') {
      const newName = msg.name.slice(0, 24);
      sess.name = newName;
      ws.serializeAttachment({ id: sess.id, name: newName });
      this.broadcast({ type: 'peer-rename', id: sess.id, name: newName });
      return;
    }
  }

  webSocketClose(ws: WebSocket): void {
    const att = (ws.deserializeAttachment() as { id?: string } | null) || {};
    if (!att.id) return;
    this.sessions.delete(att.id);
    this.broadcast({ type: 'peer-leave', id: att.id }, att.id);
  }

  webSocketError(ws: WebSocket): void {
    const att = (ws.deserializeAttachment() as { id?: string } | null) || {};
    if (att.id) {
      this.sessions.delete(att.id);
      this.broadcast({ type: 'peer-leave', id: att.id }, att.id);
    }
  }

  broadcast(msg: unknown, exceptId?: string): void {
    const str = JSON.stringify(msg);
    for (const [id, s] of this.sessions) {
      if (id === exceptId) continue;
      try {
        s.ws.send(str);
      } catch {
        this.sessions.delete(id);
      }
    }
  }
}
