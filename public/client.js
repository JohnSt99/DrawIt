const joinPanel = document.getElementById('join-panel');
const gameSection = document.getElementById('game');
const nameInput = document.getElementById('name-input');
const joinBtn = document.getElementById('join-btn');
const joinError = document.getElementById('join-error');
const statusText = document.getElementById('status-text');
const wordReveal = document.getElementById('word-reveal');
const playerList = document.getElementById('player-list');
const messages = document.getElementById('messages');
const guessForm = document.getElementById('guess-form');
const guessInput = document.getElementById('guess-input');
const startBtn = document.getElementById('start-btn');
const endBtn = document.getElementById('end-btn');
const clearBtn = document.getElementById('clear-btn');
const canvas = document.getElementById('board');

const ctx = canvas.getContext('2d');
ctx.lineJoin = 'round';
ctx.lineCap = 'round';
ctx.lineWidth = 4;
ctx.strokeStyle = '#0f172a';

let playerId = null;
let isDrawer = false;
let drawerId = null;
let roundActive = false;
let source = null;
let painting = false;
let lastPoint = null;
let playerState = [];

function resizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  const { width } = canvas.getBoundingClientRect();
  const height = width * 0.65;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.style.height = `${height}px`;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.lineWidth = 4;
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function appendMessage({ message, from, type }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'message';
  if (type === 'system') {
    const span = document.createElement('span');
    span.className = 'system';
    span.textContent = message;
    wrapper.appendChild(span);
  } else if (type === 'guess') {
    const author = document.createElement('span');
    author.className = 'author';
    author.textContent = `${from || 'Guest'}: `;
    const text = document.createElement('span');
    text.textContent = message;
    wrapper.appendChild(author);
    wrapper.appendChild(text);
  } else {
    wrapper.textContent = message;
  }
  messages.appendChild(wrapper);
  messages.scrollTop = messages.scrollHeight;
}

function renderPlayers(list) {
  playerState = list;
  playerList.innerHTML = '';
  [...list]
    .sort((a, b) => b.score - a.score)
    .forEach(player => {
      const item = document.createElement('li');
      item.className = 'player-item';
      if (player.id === drawerId) {
        item.classList.add('drawer');
      }
      const name = document.createElement('span');
      name.textContent = `${player.name}${player.id === playerId ? ' (you)' : ''}`;
      const score = document.createElement('span');
      score.className = 'score';
      score.textContent = `${player.score} pts`;
      item.appendChild(name);
      item.appendChild(score);
      playerList.appendChild(item);
    });
}

function connectStream() {
  source = new EventSource(`/api/stream?playerId=${playerId}`);

  source.addEventListener('welcome', evt => {
    const data = JSON.parse(evt.data);
    renderPlayers(data.players || []);
    roundActive = !!data.round?.active;
    drawerId = data.round?.drawerId || null;
    isDrawer = drawerId === playerId;
    updateStatus(data.round);
    refreshControls();
  });

  source.addEventListener('players', evt => {
    const data = JSON.parse(evt.data);
    renderPlayers(data.players || []);
  });

  source.addEventListener('chat', evt => {
    appendMessage(JSON.parse(evt.data));
  });

  source.addEventListener('roundStarted', evt => {
    const data = JSON.parse(evt.data);
    roundActive = true;
    drawerId = data.drawerId;
    isDrawer = drawerId === playerId;
    wordReveal.textContent = isDrawer ? `Your word: hidden` : 'Guess the word!';
    statusText.textContent = `Round ${data.roundNumber} — ${data.drawerName} is drawing`;
    clearBoard();
    renderPlayers(playerState);
    refreshControls();
  });

  source.addEventListener('roundEnded', evt => {
    const data = JSON.parse(evt.data);
    roundActive = false;
    isDrawer = false;
    drawerId = null;
    statusText.textContent = `Round ended (${data.reason}).`;
    wordReveal.textContent = data.word ? `Word was: ${data.word}` : '';
    renderPlayers(playerState);
    refreshControls();
  });

  source.addEventListener('word', evt => {
    const data = JSON.parse(evt.data);
    isDrawer = true;
    drawerId = playerId;
    wordReveal.textContent = `Your word: ${data.word}`;
    statusText.textContent = 'You are drawing!';
    refreshControls();
  });

  source.addEventListener('guessResult', evt => {
    const data = JSON.parse(evt.data);
    const suffix = data.order === 1 ? 'st' : data.order === 2 ? 'nd' : 'th';
    appendMessage({
      message: `${data.playerName} guessed correctly (${data.order}${suffix}) +${data.points} pts! Drawer +${data.drawerBonus} pts.`,
      type: 'system'
    });
  });

  source.addEventListener('draw', evt => {
    const data = JSON.parse(evt.data);
    drawFromData(data, false);
  });

  source.addEventListener('clear', () => clearBoard());

  source.onerror = () => {
    statusText.textContent = 'Connection lost. Reconnecting…';
  };
}

function updateStatus(round) {
  if (round?.active) {
    const label = drawerId ? ` — ${playerState.find(p => p.id === drawerId)?.name || 'drawing'}` : '';
    statusText.textContent = `Round ${round.roundNumber || ''} in progress${label}`;
  } else {
    statusText.textContent = 'Waiting for someone to start…';
  }
}

async function joinLobby() {
  joinBtn.disabled = true;
  joinError.textContent = '';
  const name = nameInput.value.trim();
  try {
    const res = await fetch('/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || 'Unable to join.');
    }
    const data = await res.json();
    playerId = data.player.id;
    joinPanel.classList.add('hidden');
    gameSection.classList.remove('hidden');
    connectStream();
    renderPlayers([]);
    statusText.textContent = 'Connected!';
    appendMessage({ message: 'Joined lobby.', type: 'system' });
    refreshControls();
  } catch (err) {
    joinError.textContent = err.message;
  } finally {
    joinBtn.disabled = false;
  }
}

async function sendAction(type, payload = {}) {
  if (!playerId) return;
  const res = await fetch('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, type, payload })
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok && data.message) {
    appendMessage({ message: data.message, type: 'system' });
  }
}

function refreshControls() {
  clearBtn.disabled = !isDrawer;
  endBtn.disabled = !roundActive;
  startBtn.disabled = roundActive;
  guessInput.disabled = isDrawer;
}

function clearBoard() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawFromData(point, isLocal) {
  if (!point) return;
  ctx.beginPath();
  ctx.moveTo(point.from.x, point.from.y);
  ctx.lineTo(point.to.x, point.to.y);
  ctx.stroke();
  if (!isLocal) {
    lastPoint = point.to;
  }
}

function pointerPos(evt) {
  const rect = canvas.getBoundingClientRect();
  const point = evt.touches?.[0] || evt;
  return {
    x: (point.clientX || 0) - rect.left,
    y: (point.clientY || 0) - rect.top
  };
}

function startStroke(evt) {
  if (!isDrawer || !roundActive) return;
  evt.preventDefault();
  painting = true;
  lastPoint = pointerPos(evt);
}

function endStroke() {
  painting = false;
  lastPoint = null;
}

function moveStroke(evt) {
  if (!painting || !isDrawer) return;
  evt.preventDefault();
  const current = pointerPos(evt);
  if (!lastPoint) {
    return;
  }
  const point = { from: lastPoint, to: current };
  drawFromData(point, true);
  lastPoint = current;
  sendAction('draw', point);
}

joinBtn.addEventListener('click', joinLobby);
nameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') joinLobby();
});

startBtn.addEventListener('click', () => sendAction('startRound'));
endBtn.addEventListener('click', () => sendAction('endRound'));
clearBtn.addEventListener('click', () => clearBoard() || sendAction('clear'));

guessForm.addEventListener('submit', e => {
  e.preventDefault();
  const text = guessInput.value.trim();
  if (!text) return;
  appendMessage({ from: 'You', message: text, type: 'guess' });
  sendAction('guess', { text });
  guessInput.value = '';
});

canvas.addEventListener('pointerdown', startStroke);
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointerout', endStroke);
canvas.addEventListener('pointermove', moveStroke);
canvas.addEventListener('touchstart', startStroke);
canvas.addEventListener('touchend', endStroke);
canvas.addEventListener('touchmove', moveStroke);

window.addEventListener('beforeunload', () => {
  if (playerId) {
    navigator.sendBeacon('/api/leave', JSON.stringify({ playerId }));
  }
});
