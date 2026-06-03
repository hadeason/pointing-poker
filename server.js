const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST_KEY = process.env.HOST_KEY || '0723';

// ---------- Estimation scales ----------
const SCALES = {
  fibonacci:   { label: 'Story Points (Fibonacci)', values: ['1','2','3','5','8','13','21','?'], numeric: true },
  tshirt:      { label: 'T-Shirt Sizes',            values: ['XS','S','M','L','XL','XXL','?'],   numeric: false,
                 order: { XS:1, S:2, M:3, L:4, XL:5, XXL:6 } },
  days:        { label: 'Days',                     values: ['0.5','1','2','3','5','8','13','?'], numeric: true },
  weeks:       { label: 'Weeks',                    values: ['0.5','1','2','3','4','6','?'],      numeric: true },
  headache:    { label: 'Headache Level',           values: ['😀','🙂','😐','😟','😫','🤯','?'],
                 numeric: false,
                 order: { '😀':1,'🙂':2,'😐':3,'😟':4,'😫':5,'🤯':6 } },
  oneToTen:    { label: 'Scale of 1-10',            values: ['1','2','3','4','5','6','7','8','9','10','?'], numeric: true },
  goodThings:  { label: 'Scale of Good Things',     values: ['☕','🍪','🍰','🍕','🌮','🏖️','?'],
                 numeric: false,
                 order: { '☕':1, '🍪':2, '🍰':3, '🍕':4, '🌮':5, '🏖️':6 } },
  blastRadius: { label: 'Blast Radius',             values: ['👤','👥','🏢','🌆','🌎','💥','?'],
                 numeric: false,
                 order: { '👤':1, '👥':2, '🏢':3, '🌆':4, '🌎':5, '💥':6 } },
};

const VALID_ROLES = new Set(['junior', 'mid', 'senior', 'other']);

// ---------- Session state ----------
let voters = {};
let revealed = false;
let sseClients = [];
let clientVoterMap = new Map();
let hostId = null;
let sessionActive = false;
let currentScale = 'fibonacci';
let calledOn = new Set();
let defenders = [];
let lastReaction = null;
let roundStartedAt = null;
let sessionStartedAt = null;
let history = [];
let currentRoundRecorded = false;

function broadcast(event, data) {
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  sseClients = sseClients.filter(res => {
    try { res.write(msg); return true; } catch { return false; }
  });
}

function publicVoter(id, v) {
  return {
    id,
    name: v.name,
    role: v.role,
    voted: v.vote !== null,
    vote: revealed ? v.vote : null,
    isHost: id === hostId,
    isDefender: defenders.includes(id),
    isCalledOn: calledOn.has(id),
  };
}

function getState() {
  return {
    voters: Object.entries(voters).map(([id, v]) => publicVoter(id, v)),
    revealed,
    hostId,
    sessionActive,
    scale: currentScale,
    scales: Object.fromEntries(Object.entries(SCALES).map(([k, s]) => [k, { label: s.label, values: s.values, numeric: s.numeric }])),
    reaction: lastReaction,
    roundStartedAt,
    sessionStartedAt,
    history,
  };
}

function removeVoter(id) {
  if (!voters[id]) return;
  const wasHost = (hostId === id);
  delete voters[id];
  calledOn.delete(id);
  defenders = defenders.filter(d => d !== id);
  if (wasHost) {
    const remaining = Object.entries(voters).sort((a, b) => b[1].joinedAt - a[1].joinedAt);
    hostId = remaining.length ? remaining[0][0] : null;
    if (!hostId) sessionActive = false;
  }
  broadcast('state', getState());
}

function startNewRound() {
  revealed = false;
  currentRoundRecorded = false;
  defenders = [];
  calledOn = new Set();
  lastReaction = null;
  roundStartedAt = Date.now();
  for (const id of Object.keys(voters)) voters[id].vote = null;
  broadcast('state', getState());
}

function endSession() {
  const summary = buildSessionSummary();
  const finalHistory = history;
  voters = {};
  revealed = false;
  hostId = null;
  sessionActive = false;
  calledOn = new Set();
  defenders = [];
  lastReaction = null;
  roundStartedAt = null;
  sessionStartedAt = null;
  history = [];
  broadcast('ended', { summary, history: finalHistory });
  sseClients.forEach(res => { try { res.end(); } catch {} });
  sseClients = [];
  clientVoterMap.clear();
}

function pickDefenders() {
  const voted = Object.entries(voters)
    .filter(([, v]) => v.vote !== null && v.vote !== '?')
    .map(([id, v]) => ({ id, role: v.role }));
  if (voted.length === 0) return [];
  const byRole = { junior: [], mid: [], senior: [] };
  voted.forEach(v => { if (byRole[v.role]) byRole[v.role].push(v); });
  for (const r of Object.keys(byRole)) {
    byRole[r] = byRole[r].sort(() => Math.random() - 0.5);
  }
  const picked = [];
  for (const r of ['junior', 'mid', 'senior']) {
    if (byRole[r][0]) picked.push(byRole[r][0].id);
  }
  if (picked.length < 2) {
    const others = voted
      .filter(v => !picked.includes(v.id))
      .sort(() => Math.random() - 0.5);
    while (picked.length < 2 && others.length) picked.push(others.shift().id);
  }
  return picked.slice(0, 3);
}

function checkSeniorConsensus() {
  const seniors = Object.values(voters).filter(v => v.role === 'senior');
  if (seniors.length < 2) return null;
  const votes = seniors.map(v => v.vote).filter(x => x !== null && x !== '?');
  if (votes.length !== seniors.length) return null;
  const first = votes[0];
  if (votes.every(x => x === first)) return first;
  return null;
}

function checkTeamConsensus() {
  const all = Object.values(voters).filter(v => v.vote !== null && v.vote !== '?');
  if (all.length < 2) return null;
  if (all.length !== Object.keys(voters).length) return null;
  const first = all[0].vote;
  if (all.every(v => v.vote === first)) return first;
  return null;
}

function detectDiscrepancy() {
  const scale = SCALES[currentScale];
  const voted = Object.values(voters).map(v => v.vote).filter(x => x !== null && x !== '?');
  if (voted.length < 2) return false;
  const distinct = new Set(voted);
  if (distinct.size >= 3) return true;
  let ranks;
  if (scale.numeric) {
    ranks = voted.map(v => parseFloat(v));
  } else if (scale.order) {
    ranks = voted.map(v => scale.order[v]).filter(x => x !== undefined);
  }
  if (!ranks || ranks.length < 2) return false;
  const sorted = ranks.slice().sort((a, b) => a - b);
  const span = sorted[sorted.length - 1] - sorted[0];
  const numericValues = scale.values.filter(v => v !== '?').map(parseFloat).filter(n => !Number.isNaN(n));
  const total = scale.numeric && numericValues.length
    ? Math.max(...numericValues) - Math.min(...numericValues)
    : (scale.order ? Object.keys(scale.order).length - 1 : 0);
  return total > 0 && (span / total) >= 0.5;
}

function recordRound(acceptedEstimate, wasSeniorConsensus, wasTeamConsensus) {
  if (!roundStartedAt) return;
  if (currentRoundRecorded) return;
  currentRoundRecorded = true;
  const now = Date.now();
  const snapshot = Object.values(voters).map(v => ({
    name: v.name, role: v.role, vote: v.vote,
  }));
  history.push({
    roundNumber: history.length + 1,
    scale: currentScale,
    scaleLabel: SCALES[currentScale].label,
    startedAt: roundStartedAt,
    revealedAt: now,
    durationMs: now - roundStartedAt,
    acceptedEstimate,
    votes: snapshot,
    seniorConsensus: !!wasSeniorConsensus,
    teamConsensus: !!wasTeamConsensus,
  });
}

function buildSessionSummary() {
  const totalMs = sessionStartedAt ? (Date.now() - sessionStartedAt) : 0;
  const perScale = {};
  for (const round of history) {
    const key = round.scale;
    if (!perScale[key]) {
      perScale[key] = {
        scale: key,
        label: round.scaleLabel,
        rounds: 0,
        seniorConsensus: 0,
        teamConsensus: 0,
        estimates: [],
        durations: [],
      };
    }
    const s = perScale[key];
    s.rounds += 1;
    if (round.seniorConsensus) s.seniorConsensus += 1;
    if (round.teamConsensus) s.teamConsensus += 1;
    if (round.acceptedEstimate != null) s.estimates.push(round.acceptedEstimate);
    s.durations.push(round.durationMs);
  }
  for (const key of Object.keys(perScale)) {
    const s = perScale[key];
    const scale = SCALES[key];
    const numeric = scale && scale.numeric;
    if (numeric && s.estimates.length) {
      const nums = s.estimates.map(parseFloat).filter(x => !Number.isNaN(x));
      s.avgEstimate = nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2) : null;
    } else {
      s.avgEstimate = null;
    }
    if (s.estimates.length) {
      const counts = {};
      s.estimates.forEach(e => { counts[e] = (counts[e] || 0) + 1; });
      s.mostCommon = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    } else {
      s.mostCommon = null;
    }
    s.avgDurationMs = s.durations.length
      ? Math.round(s.durations.reduce((a, b) => a + b, 0) / s.durations.length)
      : 0;
    delete s.durations;
  }
  const totalSeniorConsensus = history.filter(r => r.seniorConsensus).length;
  const totalTeamConsensus = history.filter(r => r.teamConsensus).length;
  return {
    totalMs,
    totalRounds: history.length,
    totalSeniorConsensus,
    totalTeamConsensus,
    perScale,
    rounds: history,
  };
}

function revealAndMaybeAccept({ auto = false, accepted = null, wasSeniorConsensus = false } = {}) {
  if (revealed) return;
  revealed = true;
  defenders = pickDefenders();
  const team = checkTeamConsensus();
  if (auto && wasSeniorConsensus) {
    lastReaction = { type: 'senior-consensus', at: Date.now(), value: accepted };
  } else if (team) {
    lastReaction = { type: 'consensus', at: Date.now() };
  } else if (detectDiscrepancy()) {
    lastReaction = { type: 'discrepancy', at: Date.now() };
  }
  if (auto && accepted != null) {
    recordRound(accepted, wasSeniorConsensus, !!team);
  }
  broadcast('state', getState());
}

function serveStatic(req, res, file, type) {
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(path.join(__dirname, file)).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);

  if (url.pathname === '/' || url.pathname === '/index.html') return serveStatic(req, res, 'index.html', 'text/html');
  if (url.pathname === '/style.css') return serveStatic(req, res, 'style.css', 'text/css');
  if (url.pathname === '/client.js') return serveStatic(req, res, 'client.js', 'application/javascript');

  if (url.pathname === '/events') {
    const voterId = url.searchParams.get('id');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
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
      const json = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (url.pathname === '/join') {
        const name = (data.name || '').trim();
        const hostKey = (data.hostKey || '').trim();
        const role = VALID_ROLES.has(data.role) ? data.role : 'other';
        if (!name) return json({ error: 'Name required' });
        const isHost = hostKey === HOST_KEY;
        if (!isHost && !sessionActive) return json({ error: 'Waiting for host to start the session' });
        const id = crypto.randomUUID();
        voters[id] = { name, role, vote: null, joinedAt: Date.now() };
        if (isHost) {
          hostId = id;
          sessionActive = true;
          if (!sessionStartedAt) sessionStartedAt = Date.now();
          if (!roundStartedAt) roundStartedAt = Date.now();
        }
        broadcast('state', getState());
        return json({ id, hostId, isHost });
      }

      if (url.pathname === '/vote') {
        const { id, vote } = data;
        if (!voters[id]) return json({ error: 'Unknown voter' });
        if (revealed) return json({ error: 'Round already revealed' });
        voters[id].vote = vote;
        broadcast('state', getState());
        const seniorVal = checkSeniorConsensus();
        if (seniorVal != null) {
          revealAndMaybeAccept({ auto: true, accepted: seniorVal, wasSeniorConsensus: true });
        }
        return json({ ok: true });
      }

      if (url.pathname === '/reveal') {
        if (data.id !== hostId) return json({ error: 'Only the host can reveal' });
        revealAndMaybeAccept({ auto: false });
        return json({ ok: true });
      }

      if (url.pathname === '/accept') {
        if (data.id !== hostId) return json({ error: 'Only the host can accept' });
        if (!revealed) return json({ error: 'Reveal votes before accepting' });
        const teamVal = checkTeamConsensus();
        const seniorVal = checkSeniorConsensus();
        recordRound(data.estimate ?? null, !!seniorVal, !!teamVal);
        if (data.estimate != null && teamVal && data.estimate === teamVal) {
          lastReaction = { type: 'consensus', at: Date.now() };
        }
        startNewRound();
        return json({ ok: true });
      }

      if (url.pathname === '/reset') {
        if (data.id !== hostId) return json({ error: 'Only the host can reset' });
        startNewRound();
        return json({ ok: true });
      }

      if (url.pathname === '/scale') {
        if (data.id !== hostId) return json({ error: 'Only the host can change the scale' });
        if (!SCALES[data.scale]) return json({ error: 'Unknown scale' });
        currentScale = data.scale;
        for (const id of Object.keys(voters)) voters[id].vote = null;
        revealed = false;
        defenders = [];
        roundStartedAt = Date.now();
        broadcast('state', getState());
        return json({ ok: true });
      }

      if (url.pathname === '/role') {
        const { id, targetId, role } = data;
        if (!VALID_ROLES.has(role)) return json({ error: 'Invalid role' });
        const target = targetId || id;
        if (!voters[target]) return json({ error: 'Unknown voter' });
        if (target !== id && id !== hostId) return json({ error: 'Only the host can change others’ roles' });
        voters[target].role = role;
        broadcast('state', getState());
        return json({ ok: true });
      }

      if (url.pathname === '/call-on') {
        if (data.id !== hostId) return json({ error: 'Only the host can call on voters' });
        const target = data.targetId;
        if (!voters[target]) return json({ error: 'Unknown voter' });
        if (calledOn.has(target)) calledOn.delete(target);
        else calledOn.add(target);
        broadcast('state', getState());
        return json({ ok: true });
      }

      if (url.pathname === '/pick-defenders') {
        if (data.id !== hostId) return json({ error: 'Only the host can pick defenders' });
        defenders = pickDefenders();
        broadcast('state', getState());
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

      res.writeHead(404);
      res.end('Not found');
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('Pointing Poker running on port ' + PORT);
});
