// VibeFarm Multiplayer Relay Server
// Deploy on Render: Web Service → Node → start command: node server.js
// Render sets process.env.PORT automatically.

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;

// ── HTTP server (health-check for Render) ───────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('VibeFarm Multiplayer Server — OK');
});

// ── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

// rooms:   code (string) → Set<ws>
// clients: ws → { id, name, room }
const rooms   = new Map();
const clients = new Map();

function uid()  { return Math.random().toString(36).slice(2, 10); }
function genCode() {
  const C = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += C[Math.floor(Math.random() * C.length)];
  return s;
}

function send(ws, obj) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (_) {}
}

function broadcast(code, obj, exceptId) {
  const members = rooms.get(code);
  if (!members) return;
  for (const ws of members) {
    const c = clients.get(ws);
    if (c && c.id !== exceptId) send(ws, obj);
  }
}

function leaveRoom(ws) {
  const c = clients.get(ws);
  if (!c || !c.room) return;
  const members = rooms.get(c.room);
  if (members) {
    members.delete(ws);
    if (members.size === 0) rooms.delete(c.room);
    else broadcast(c.room, { type: 'peer-leave', id: c.id });
  }
  c.room = null;
}

wss.on('connection', (ws) => {
  const clientId = uid();
  clients.set(ws, { id: clientId, name: 'Farmer', room: null });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch (_) { return; }
    const c = clients.get(ws);
    if (!c || !data || !data.type) return;

    switch (data.type) {

      case 'host': {
        leaveRoom(ws);
        c.name = (data.name || 'Farmer').slice(0, 24);
        let code;
        for (let i = 0; i < 20; i++) { code = genCode(); if (!rooms.has(code)) break; }
        rooms.set(code, new Set([ws]));
        c.room = code;
        send(ws, { type: 'hosted', room: code, clientId: c.id });
        break;
      }

      case 'join': {
        const code = (data.room || '').trim().toUpperCase();
        if (!rooms.has(code)) { send(ws, { type: 'error', msg: 'Room not found — check the code' }); return; }
        leaveRoom(ws);
        c.name = (data.name || 'Farmer').slice(0, 24);
        const members = rooms.get(code);
        const peers = [];
        for (const mws of members) {
          const mc = clients.get(mws);
          if (mc) peers.push({ id: mc.id, name: mc.name });
        }
        members.add(ws);
        c.room = code;
        send(ws, { type: 'joined', room: code, clientId: c.id, peers });
        broadcast(code, { type: 'peer-join', id: c.id, name: c.name }, c.id);
        break;
      }

      case 'relay': {
        if (!c.room || !data.msg) return;
        broadcast(c.room, { type: 'relay', from: c.id, msg: data.msg }, c.id);
        break;
      }

      case 'rename': {
        c.name = (data.name || c.name).slice(0, 24);
        if (c.room) broadcast(c.room, { type: 'peer-rename', id: c.id, name: c.name }, c.id);
        break;
      }

      case 'ping': send(ws, { type: 'pong' }); break;
    }
  });

  ws.on('close', () => { leaveRoom(ws); clients.delete(ws); });
  ws.on('error', () => {});
});

// Purge empty rooms every minute
setInterval(() => {
  for (const [code, members] of rooms) if (members.size === 0) rooms.delete(code);
}, 60_000);

httpServer.listen(PORT, () =>
  console.log(`VibeFarm server running on port ${PORT}`)
);
