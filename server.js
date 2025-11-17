const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const WORDS = [
  'apple',
  'bridge',
  'camera',
  'dragon',
  'mountain',
  'rocket',
  'pizza',
  'guitar',
  'island',
  'forest',
  'castle',
  'helmet',
  'turtle',
  'coffee',
  'flower'
];

const clients = new Map(); // playerId -> {res, heartbeat}
const players = new Map(); // playerId -> {id,name,score}
let joinOrder = [];
let drawerIndex = -1;
let round = {
  active: false,
  word: null,
  drawerId: null,
  guessed: [],
  roundNumber: 0
};

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  let filePath = path.join(__dirname, 'public', urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'text/javascript',
      '.svg': 'image/svg+xml'
    }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1e6) {
        reject(new Error('too large'));
        req.socket.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function sendJSON(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function broadcast(event, data, filter = () => true) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, client] of clients.entries()) {
    if (filter(id)) {
      client.res.write(payload);
    }
  }
}

function sendTo(playerId, event, data) {
  const client = clients.get(playerId);
  if (client) {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

function sanitizeName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return `Guest-${Math.floor(Math.random() * 900 + 100)}`;
  return trimmed.slice(0, 18);
}

function scoreForPlacement(index) {
  return Math.max(30, 100 - index * 20);
}

function updatePlayers() {
  const list = Array.from(players.values()).map(p => ({ id: p.id, name: p.name, score: p.score }));
  broadcast('players', { players: list });
}

function resetRoundState() {
  round.active = false;
  round.word = null;
  round.drawerId = null;
  round.guessed = [];
}

function chooseNextDrawer() {
  if (joinOrder.length === 0) return null;
  drawerIndex = (drawerIndex + 1) % joinOrder.length;
  return joinOrder[drawerIndex];
}

function startRound(requesterId) {
  if (round.active) return { ok: false, message: 'A round is already in progress.' };
  if (players.size < 2) return { ok: false, message: 'Need at least 2 players to start.' };

  const nextDrawer = chooseNextDrawer();
  round.active = true;
  round.word = WORDS[Math.floor(Math.random() * WORDS.length)];
  round.drawerId = nextDrawer;
  round.guessed = [];
  round.roundNumber += 1;

  broadcast('roundStarted', {
    drawerId: nextDrawer,
    drawerName: players.get(nextDrawer)?.name,
    roundNumber: round.roundNumber
  });
  sendTo(nextDrawer, 'word', { word: round.word });
  return { ok: true };
}

function endRound(reason = 'stopped') {
  if (!round.active && !round.word) return;
  broadcast('roundEnded', { reason, word: round.word });
  resetRoundState();
}

function handleGuess(playerId, guessText) {
  if (!round.active || !round.word) return { ok: false, message: 'No active round.' };
  if (playerId === round.drawerId) return { ok: false, message: 'Drawer cannot guess.' };

  const guess = (guessText || '').trim().toLowerCase();
  if (!guess) return { ok: false, message: 'Empty guess ignored.' };

  if (round.guessed.includes(playerId)) {
    return { ok: false, message: 'Already guessed correctly.' };
  }

  if (guess === round.word.toLowerCase()) {
    round.guessed.push(playerId);
    const placementIndex = round.guessed.length - 1;
    const points = scoreForPlacement(placementIndex);
    const drawerBonus = 15;
    const player = players.get(playerId);
    if (player) player.score += points;
    const drawer = players.get(round.drawerId);
    if (drawer) drawer.score += drawerBonus;

    broadcast('guessResult', {
      playerId,
      playerName: player?.name,
      points,
      drawerBonus,
      order: round.guessed.length
    });
    updatePlayers();

    if (round.guessed.length >= Math.max(1, players.size - 1)) {
      endRound('everyone-guessed');
    }
    return { ok: true, correct: true };
  }

  broadcast('chat', {
    from: players.get(playerId)?.name,
    message: guessText,
    type: 'guess'
  });
  return { ok: true, correct: false };
}

function removePlayer(playerId) {
  if (!players.has(playerId)) return;
  const departing = players.get(playerId);
  players.delete(playerId);
  joinOrder = joinOrder.filter(id => id !== playerId);
  if (drawerIndex >= joinOrder.length) {
    drawerIndex = joinOrder.length - 1;
  }
  updatePlayers();
  broadcast('chat', { type: 'system', message: `${departing?.name || 'A player'} left the lobby.` });

  if (round.drawerId === playerId) {
    endRound('drawer-left');
  }
}

async function handleJoin(req, res) {
  if (players.size >= MAX_PLAYERS) {
    sendJSON(res, 403, { message: 'Lobby full. Max 10 players.' });
    return;
  }
  const body = await parseBody(req).catch(() => null);
  if (!body) {
    sendJSON(res, 400, { message: 'Invalid request.' });
    return;
  }
  const playerId = randomUUID();
  const name = sanitizeName(body.name);
  const player = { id: playerId, name, score: 0 };
  players.set(playerId, player);
  joinOrder.push(playerId);
  updatePlayers();
  broadcast('chat', { type: 'system', message: `${name} joined the lobby.` });
  sendJSON(res, 200, {
    player,
    round: { ...round, word: undefined },
    maxPlayers: MAX_PLAYERS
  });
}

function handleStream(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const playerId = url.searchParams.get('playerId');
  if (!players.has(playerId)) {
    res.writeHead(401);
    res.end('Unknown player');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('\n');

  const heartbeat = setInterval(() => {
    res.write('event: ping\ndata: {}\n\n');
  }, 25000);
  clients.set(playerId, { res, heartbeat });

  sendTo(playerId, 'welcome', {
    players: Array.from(players.values()),
    round: { ...round, word: undefined }
  });
  if (round.active && round.drawerId === playerId) {
    sendTo(playerId, 'word', { word: round.word });
  }

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(playerId);
  });
}

async function handleAction(req, res) {
  const body = await parseBody(req).catch(() => null);
  if (!body || !body.playerId || !players.has(body.playerId)) {
    sendJSON(res, 401, { message: 'Unknown player.' });
    return;
  }
  const { playerId, type, payload } = body;
  let response = { ok: true };

  switch (type) {
    case 'guess':
      response = handleGuess(playerId, payload?.text || '');
      break;
    case 'startRound':
      response = startRound(playerId);
      break;
    case 'endRound':
      endRound('stopped');
      break;
    case 'draw':
      if (round.active && playerId === round.drawerId && payload) {
        broadcast('draw', payload, id => id !== playerId);
      }
      break;
    case 'clear':
      if (playerId === round.drawerId) {
        broadcast('clear', {});
      }
      break;
    default:
      response = { ok: false, message: 'Unknown action.' };
  }
  sendJSON(res, 200, response);
}

async function handleLeave(req, res) {
  const body = await parseBody(req).catch(() => null);
  if (!body || !players.has(body.playerId)) {
    sendJSON(res, 400, { ok: false });
    return;
  }
  removePlayer(body.playerId);
  sendJSON(res, 200, { ok: true });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/api/stream')) {
    handleStream(req, res);
    return;
  }
  if (req.method === 'POST' && req.url === '/api/join') {
    handleJoin(req, res);
    return;
  }
  if (req.method === 'POST' && req.url === '/api/action') {
    handleAction(req, res);
    return;
  }
  if (req.method === 'POST' && req.url === '/api/leave') {
    handleLeave(req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Draw It server listening on port ${PORT}`);
});
