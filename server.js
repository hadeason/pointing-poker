const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const HOST_KEY = '0723';

let voters = {};
let revealed = false;
let sseClients = [];
let hostId = null;
let sessionActive = false;
let clientVoterMap = new Map();

function broadcast(event, data) {
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  sseClients = sseClients.filter(res => {
    try { res.write(msg); return true; } catch { return false; }
  });
}

function getState() {
  const list = Object.entries(voters).map(([id, v]) => ({
    id, name: v.name, voted: v.vote !== null,
    vote: revealed ? v.vote : null, isHost: id === hostId,
  }));
  return { voters: list, revealed, hostId, sessionActive };
}

function removeVoter(id) {
  if (!voters[id]) return;
  const wasHost = (hostId === id);
  delete voters[id];
  if (wasHost) {
    // Find most recently joined voter still connected
    const remaining = Object.entries(voters).sort((a, b) => b[1].joinedAt - a[1].joinedAt);
    hostId = remaining.length ? remaining[0][0] : null;
    if (!hostId) sessionActive = false;
  }
  broadcast('state', getState());
}

function resetRound() {
  revealed = false;
  for (const id of Object.keys(voters)) voters[id].vote = null;
  broadcast('state', getState());
}

function endSession() {
  voters = {};
  revealed = false;
  hostId = null;
  sessionActive = false;
  broadcast('ended', {});
  // Close all SSE connections
  sseClients.forEach(res => { try { res.end(); } catch {} });
  sseClients = [];
  clientVoterMap.clear();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    return;
  }

  if (url.pathname === '/events') {
    const voterId = url.searchParams.get('id');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('\n');
    sseClients.push(res);
    if (voterId) clientVoterMap.set(res, voterId);
    res.write('event: state\ndata: ' + JSON.stringify(getState()) + '\n\n');
    req.on('close', () => {
      sseClients = sseClients.filter(c => c !== res);
      const vid = clientVoterMap.get(res);
      clientVoterMap.delete(res);
      if (vid) removeVoter(vid);
    });
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let data = {};
      try { data = JSON.parse(body); } catch {}
      const json = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

      if (url.pathname === '/join') {
        const name = (data.name || '').trim();
        const hostKey = (data.hostKey || '').trim();
        if (!name) return json({ error: 'Name required' });
        const isHost = hostKey === HOST_KEY;
        if (!isHost && !sessionActive) return json({ error: 'Waiting for host to start the session' });
        const id = crypto.randomUUID();
        voters[id] = { name, vote: null, joinedAt: Date.now() };
        if (isHost) { hostId = id; sessionActive = true; }
        broadcast('state', getState());
        return json({ id, hostId, isHost });
      }
      if (url.pathname === '/vote') {
        const { id, vote } = data;
        if (!voters[id]) return json({ error: 'Unknown voter' });
        if (revealed) return json({ error: 'Round already revealed' });
        voters[id].vote = vote;
        broadcast('state', getState());
        return json({ ok: true });
      }
      if (url.pathname === '/reveal') {
        if (data.id !== hostId) return json({ error: 'Only the host can reveal' });
        revealed = true;
        broadcast('state', getState());
        return json({ ok: true });
      }
      if (url.pathname === '/reset') {
        if (data.id !== hostId) return json({ error: 'Only the host can reset' });
        resetRound();
        return json({ ok: true });
      }
      if (url.pathname === '/end') {
        if (data.id !== hostId) return json({ error: 'Only the host can end the session' });
        endSession();
        return json({ ok: true });
      }
      if (url.pathname === '/leave') {
        if (voters[data.id]) removeVoter(data.id);
        return json({ ok: true });
      }
      if (url.pathname === '/status') {
        return json({ sessionActive, hasHost: !!hostId });
      }
      res.writeHead(404); res.end('Not found');
    });
    return;
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => { console.log('Pointing Poker running on port ' + PORT); });const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PORT = process.env.PORT || 3000;

let voters = {};
let revealed = false;
let sseClients = [];
let hostId = null;
let clientVoterMap = new Map();

function broadcast(event, data) {
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  sseClients = sseClients.filter(res => {
    try { res.write(msg); return true; } catch { return false; }
  });
}

function getState() {
  const list = Object.entries(voters).map(([id, v]) => ({
    id, name: v.name, voted: v.vote !== null,
    vote: revealed ? v.vote : null,
  }));
  return { voters: list, revealed, hostId };
}

function removeVoter(id) {
  if (!voters[id]) return;
  delete voters[id];
  if (hostId === id) {
    const remaining = Object.keys(voters);
    hostId = remaining.length ? remaining[0] : null;
  }
  broadcast('state', getState());
}

function resetRound() {
  revealed = false;
  for (const id of Object.keys(voters)) voters[id].vote = null;
  broadcast('state', getState());
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    return;
  }

  if (url.pathname === '/events') {
    const voterId = url.searchParams.get('id');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('\n');
    sseClients.push(res);
    if (voterId) clientVoterMap.set(res, voterId);
    res.write('event: state\ndata: ' + JSON.stringify(getState()) + '\n\n');
    req.on('close', () => {
      sseClients = sseClients.filter(c => c !== res);
      const vid = clientVoterMap.get(res);
      clientVoterMap.delete(res);
      if (vid) removeVoter(vid);
    });
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let data = {};
      try { data = JSON.parse(body); } catch {}
      const json = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

      if (url.pathname === '/join') {
        const name = (data.name || '').trim();
        if (!name) return json({ error: 'Name required' });
        const id = crypto.randomUUID();
        voters[id] = { name, vote: null, joinedAt: Date.now() };
        if (!hostId) hostId = id;
        broadcast('state', getState());
        return json({ id, hostId });
      }
      if (url.pathname === '/vote') {
        const { id, vote } = data;
        if (!voters[id]) return json({ error: 'Unknown voter' });
        if (revealed) return json({ error: 'Round already revealed' });
        voters[id].vote = vote;
        broadcast('state', getState());
        return json({ ok: true });
      }
      if (url.pathname === '/reveal') {
        if (data.id !== hostId) return json({ error: 'Only the host can reveal' });
        revealed = true;
        broadcast('state', getState());
        return json({ ok: true });
      }
      if (url.pathname === '/reset') {
        if (data.id !== hostId) return json({ error: 'Only the host can reset' });
        resetRound();
        return json({ ok: true });
      }
      if (url.pathname === '/leave') {
        if (voters[data.id]) removeVoter(data.id);
        return json({ ok: true });
      }
      res.writeHead(404); res.end('Not found');
    });
    return;
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => { console.log('Pointing Poker running on port ' + PORT); });
