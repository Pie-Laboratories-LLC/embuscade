import { Direction } from '@bolo/shared/Direction.js';
import { getVerticalIcons } from '@bolo/shared/MazeGeometry.js';
import { PRESET_SPRITES, TRANSPARENT } from '@bolo/shared/PresetSprites.js';
import { DEFAULT_THEME } from '@bolo/shared/Theme.js';

const TANK_RADIUS = 14;
const SPRITE_SIZE = 32;
const VIEWPORT_WIDTH = 640;
const VIEWPORT_HEIGHT = 480;
const FOG_RADIUS = 128;
const PING_INTERVAL_MS = 25000;
const RECONNECT_RETRY_MS = 2000;
const PROFILE_STORAGE_KEY = 'bolo:playerProfile';
const SESSION_TOKEN_KEY = 'bolo:sessionToken';
const CELLS_PER_PLAYER = 6.25;

let playerId = null;
let maze = null;
let mazeConfig = null;
let tanks = [];
let shots = [];
let ws = null;
let isHost = false;
let playerProfile = null;
let pingIntervalId = null;

const identities = new Map();

function getOrCreateSessionToken() {
    let token = localStorage.getItem(SESSION_TOKEN_KEY);
    if (!token) {
        token = crypto.randomUUID();
        localStorage.setItem(SESSION_TOKEN_KEY, token);
    }
    return token;
}

const sessionToken = getOrCreateSessionToken();

function renderSpriteToCanvas(grid, primaryColor, secondaryColor) {
    const spriteCanvas = document.createElement('canvas');
    spriteCanvas.width = SPRITE_SIZE;
    spriteCanvas.height = SPRITE_SIZE;
    const sctx = spriteCanvas.getContext('2d');

    const palette = [DEFAULT_THEME.light, DEFAULT_THEME.dark, primaryColor, secondaryColor];

    for (let y = 0; y < SPRITE_SIZE; y++) {
        for (let x = 0; x < SPRITE_SIZE; x++) {
            const value = grid[y * SPRITE_SIZE + x];
            if (value === TRANSPARENT) continue;
            sctx.fillStyle = palette[value];
            sctx.fillRect(x, y, 1, 1);
        }
    }

    return spriteCanvas;
}

function registerIdentity(entry) {
    const canvas = renderSpriteToCanvas(entry.sprite, entry.primaryColor, entry.secondaryColor);
    identities.set(entry.playerId, { ...entry, canvas });
}

function makeRosterRow(entry) {
    const li = document.createElement('li');

    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = SPRITE_SIZE;
    previewCanvas.height = SPRITE_SIZE;
    previewCanvas.className = 'roster-sprite';
    const pctx = previewCanvas.getContext('2d');
    const cached = renderSpriteToCanvas(entry.sprite, entry.primaryColor, entry.secondaryColor);
    pctx.drawImage(cached, 0, 0);

    const nameSpan = document.createElement('span');
    nameSpan.textContent = entry.name + (entry.isHost ? ' (host)' : '');

    li.appendChild(previewCanvas);
    li.appendChild(nameSpan);

    if (entry.afk) {
        const afkSpan = document.createElement('span');
        afkSpan.textContent = 'AFK';
        afkSpan.style.color = '#f66';
        afkSpan.style.fontWeight = 'bold';
        afkSpan.style.fontSize = '11px';
        li.appendChild(afkSpan);
    }

    return li;
}

const loadingEl = document.getElementById('loading-status');
const dialogEl = document.getElementById('join-dialog');
const browserScreenEl = document.getElementById('browser-screen');
const builderDialogEl = document.getElementById('builder-dialog');
const lobbyDialogEl = document.getElementById('lobby-dialog');
const gameViewEl = document.getElementById('game-view');

function hideAllScreens() {
    loadingEl.style.display = 'none';
    dialogEl.style.display = 'none';
    browserScreenEl.style.display = 'none';
    builderDialogEl.style.display = 'none';
    lobbyDialogEl.style.display = 'none';
    gameViewEl.style.display = 'none';
}

function showBrowserScreen() {
    hideAllScreens();
    browserScreenEl.style.display = 'flex';
    if (ws && ws.readyState === WebSocket.OPEN && playerProfile) {
        ws.send(JSON.stringify({
            type: 'browse',
            playerName: playerProfile.name,
            primaryColor: playerProfile.primaryColor,
            secondaryColor: playerProfile.secondaryColor,
            sprite: playerProfile.sprite
        }));
    }
}

const connectionDotEl = document.getElementById('connection-dot');
const connectionTextEl = document.getElementById('connection-text');

function setConnectionStatus(connected) {
    connectionDotEl.classList.toggle('disconnected', !connected);
    connectionTextEl.textContent = connected ? '' : 'client disconnected';
}

// --- Écran: profil ---

const nameInput = document.getElementById('player-name');
const primaryColorInput = document.getElementById('primary-color');
const secondaryColorInput = document.getElementById('secondary-color');
const presetListEl = document.getElementById('preset-list');
const joinButton = document.getElementById('join-button');

const PRESET_KEYS = ['tank', 'racecar', 'spaceship'];
let selectedPreset = 'tank';

function loadSavedProfile() {
    try {
        const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function saveProfile(profile) {
    try {
        localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
    } catch {
        // pas grave
    }
}

function renderPresetPicker() {
    presetListEl.innerHTML = '';

    for (const key of PRESET_KEYS) {
        const option = document.createElement('div');
        option.className = 'preset-option' + (key === selectedPreset ? ' selected' : '');
        option.dataset.preset = key;

        const previewCanvas = document.createElement('canvas');
        previewCanvas.width = SPRITE_SIZE;
        previewCanvas.height = SPRITE_SIZE;
        previewCanvas.style.width = '48px';
        previewCanvas.style.height = '48px';

        const label = document.createElement('div');
        label.textContent = key;

        option.appendChild(previewCanvas);
        option.appendChild(label);
        presetListEl.appendChild(option);

        drawPresetPreview(previewCanvas, key);

        option.addEventListener('click', () => {
            selectedPreset = key;
            renderPresetPicker();
        });
    }

    const customOption = document.createElement('div');
    customOption.className = 'preset-option disabled';
    customOption.title = 'Coming soon';
    customOption.textContent = 'Custom (soon)';
    presetListEl.appendChild(customOption);
}

function drawPresetPreview(canvasEl, presetKey) {
    const pctx = canvasEl.getContext('2d');
    pctx.clearRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
    const grid = PRESET_SPRITES[presetKey];
    const palette = [DEFAULT_THEME.light, DEFAULT_THEME.dark, primaryColorInput.value, secondaryColorInput.value];

    for (let y = 0; y < SPRITE_SIZE; y++) {
        for (let x = 0; x < SPRITE_SIZE; x++) {
            const value = grid[y * SPRITE_SIZE + x];
            if (value === TRANSPARENT) continue;
            pctx.fillStyle = palette[value];
            pctx.fillRect(x, y, 1, 1);
        }
    }
}

function refreshAllPreviews() {
    for (const el of presetListEl.querySelectorAll('.preset-option[data-preset]')) {
        const canvasEl = el.querySelector('canvas');
        drawPresetPreview(canvasEl, el.dataset.preset);
    }
}

const saved = loadSavedProfile();
if (saved) {
    nameInput.value = saved.name ?? '';
    primaryColorInput.value = saved.primaryColor ?? '#0af';
    secondaryColorInput.value = saved.secondaryColor ?? '#f80';
    selectedPreset = PRESET_KEYS.includes(saved.preset) ? saved.preset : 'tank';
} else {
    primaryColorInput.value = '#0af';
    secondaryColorInput.value = '#f80';
}

renderPresetPicker();

primaryColorInput.addEventListener('input', refreshAllPreviews);
secondaryColorInput.addEventListener('input', refreshAllPreviews);

joinButton.addEventListener('click', () => {
    const name = nameInput.value.trim() || 'Player';
    const primaryColor = primaryColorInput.value;
    const secondaryColor = secondaryColorInput.value;
    const sprite = PRESET_SPRITES[selectedPreset];

    saveProfile({ name, primaryColor, secondaryColor, preset: selectedPreset });
    playerProfile = { name, primaryColor, secondaryColor, sprite };

    showBrowserScreen();
});

// --- Connexion WebSocket ---

function connectSocket() {
    ws = new WebSocket('ws://localhost:8082');

    ws.addEventListener('open', () => {
        setConnectionStatus(true);

        if (pingIntervalId) clearInterval(pingIntervalId);
        pingIntervalId = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ping' }));
            }
        }, PING_INTERVAL_MS);

        ws.send(JSON.stringify({ type: 'resume', sessionToken }));
    });

    ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'resumed') {
            playerId = msg.playerId;
            for (const entry of msg.roster) {
                registerIdentity(entry);
            }

            if (msg.started) {
                mazeConfig = {
                    largeur: msg.maze.largeur,
                    longeur: msg.maze.longeur,
                    hauteur: msg.maze.hauteur,
                    cellSize: msg.maze.cellSize
                };
                maze = msg.maze.cells;

                hideAllScreens();
                gameViewEl.style.display = 'flex';
                setupInputHandling();
                drawScene();
            } else {
                hideAllScreens();
                lobbyDialogEl.style.display = 'block';
                renderLobby(msg);
            }
        } else if (msg.type === 'resume-failed') {
            const savedProfile = loadSavedProfile();
            if (savedProfile) {
                playerProfile = {
                    name: savedProfile.name,
                    primaryColor: savedProfile.primaryColor,
                    secondaryColor: savedProfile.secondaryColor,
                    sprite: PRESET_SPRITES[savedProfile.preset] ?? PRESET_SPRITES.tank
                };
                showBrowserScreen();
            } else {
                hideAllScreens();
                dialogEl.style.display = 'block';
            }
        } else if (msg.type === 'games-list') {
            renderGamesList(msg.games);
        } else if (msg.type === 'browser-players') {
            renderBrowserPlayers(msg.players);
        } else if (msg.type === 'join-rejected') {
            alert(msg.reason === 'bad-password' ? 'Incorrect password.' : 'That game is full.');
        } else if (msg.type === 'lobby-joined') {
            playerId = msg.playerId;
            registerIdentity({ playerId, ...playerProfile });

            hideAllScreens();
            lobbyDialogEl.style.display = 'block';
        } else if (msg.type === 'lobby-state') {
            renderLobby(msg);
        } else if (msg.type === 'left-game') {
            playerId = null;
            tanks = [];
            shots = [];
            maze = null;
            showBrowserScreen();
        } else if (msg.type === 'game-started') {
            mazeConfig = {
                largeur: msg.maze.largeur,
                longeur: msg.maze.longeur,
                hauteur: msg.maze.hauteur,
                cellSize: msg.maze.cellSize
            };
            maze = msg.maze.cells;

            for (const entry of msg.roster) {
                if (!identities.has(entry.playerId)) registerIdentity(entry);
            }

            hideAllScreens();
            gameViewEl.style.display = 'flex';
            setupInputHandling();
            drawScene();
        } else if (msg.type === 'state') {
            tanks = msg.tanks;
            shots = msg.shots;
            drawScene();
        }
    });

    ws.addEventListener('close', () => {
        setConnectionStatus(false);
        console.log('Disconnected from Lobo server');
        setTimeout(connectSocket, RECONNECT_RETRY_MS);
    });

    ws.addEventListener('error', () => {
        setConnectionStatus(false);
    });
}

hideAllScreens();
loadingEl.style.display = 'block';
connectSocket();

// --- Écran: parcourir les parties ---

const gamesListEl = document.getElementById('games-list');
const browserEmptyMessageEl = document.getElementById('browser-empty-message');
const browserCreateButton = document.getElementById('browser-create-button');
const browserLeaveButton = document.getElementById('browser-leave-button');
const browserPlayersListEl = document.getElementById('browser-players-list');

function renderGamesList(games) {
    gamesListEl.innerHTML = '';
    browserEmptyMessageEl.style.display = games.length === 0 ? 'block' : 'none';

    for (const game of games) {
        const li = document.createElement('li');

        const info = document.createElement('div');
        info.className = 'game-info';
        info.textContent = `${game.name} -- ${game.width}x${game.length}x${game.height} -- `
            + `${game.playerCount}/${game.humanSlots} players`
            + (game.aiSlots > 0 ? ` + ${game.aiSlots} AI` : '')
            + (game.hasPassword ? ' -- 🔒' : '');

        const joinBtn = document.createElement('button');
        joinBtn.textContent = 'Join';
        joinBtn.disabled = game.playerCount >= game.humanSlots;
        joinBtn.addEventListener('click', () => {
            let password = null;
            if (game.hasPassword) {
                password = prompt('This game requires a password:') ?? '';
            }
            ws.send(JSON.stringify({
                type: 'join-game',
                gameId: game.id,
                password,
                sessionToken,
                playerName: playerProfile.name,
                primaryColor: playerProfile.primaryColor,
                secondaryColor: playerProfile.secondaryColor,
                sprite: playerProfile.sprite
            }));
        });

        li.appendChild(info);
        li.appendChild(joinBtn);
        gamesListEl.appendChild(li);
    }
}

function renderBrowserPlayers(players) {
    browserPlayersListEl.innerHTML = '';
    for (const entry of players) {
        browserPlayersListEl.appendChild(makeRosterRow(entry));
    }
}

browserCreateButton.addEventListener('click', () => {
    hideAllScreens();
    builderDialogEl.style.display = 'block';
});

browserLeaveButton.addEventListener('click', () => {
    hideAllScreens();
    dialogEl.style.display = 'block';
});

// --- Écran: créer une partie ---

const gameNameInput = document.getElementById('game-name');
const gamePasswordInput = document.getElementById('game-password');
const humanCountInput = document.getElementById('human-count');
const aiCountInput = document.getElementById('ai-count');
const humanCountValueEl = document.getElementById('human-count-value');
const aiCountValueEl = document.getElementById('ai-count-value');
const mazeWidthInput = document.getElementById('maze-width');
const mazeLengthInput = document.getElementById('maze-length');
const mazeHeightInput = document.getElementById('maze-height');
const mazeWidthValueEl = document.getElementById('maze-width-value');
const mazeLengthValueEl = document.getElementById('maze-length-value');
const mazeHeightValueEl = document.getElementById('maze-height-value');
const mazeSizeSummaryEl = document.getElementById('maze-size-summary');
const mazeSizeErrorEl = document.getElementById('maze-size-error');
const createGameButton = document.getElementById('create-game-button');

function currentTotalPlayers() {
    return parseInt(humanCountInput.value, 10) + parseInt(aiCountInput.value, 10);
}

function updateCreateButtonState() {
    const width = parseInt(mazeWidthInput.value, 10);
    const length = parseInt(mazeLengthInput.value, 10);
    const height = parseInt(mazeHeightInput.value, 10);
    const actualCells = width * length * height;
    const total = currentTotalPlayers();
    const tooCramped = actualCells < total;
    const nameEmpty = gameNameInput.value.trim().length === 0;

    createGameButton.disabled = tooCramped || nameEmpty;
}

function updateMazeSizeSummary() {
    const total = currentTotalPlayers();
    const recommendedCells = Math.floor(total * CELLS_PER_PLAYER);

    const width = parseInt(mazeWidthInput.value, 10);
    const length = parseInt(mazeLengthInput.value, 10);
    const height = parseInt(mazeHeightInput.value, 10);
    const actualCells = width * length * height;

    mazeWidthValueEl.textContent = width;
    mazeLengthValueEl.textContent = length;
    mazeHeightValueEl.textContent = height;

    mazeSizeSummaryEl.textContent =
        `Maze size: ${width} x ${length} x ${height} = ${actualCells} cells. ` +
        `Recommended size is ${recommendedCells} cells (~${CELLS_PER_PLAYER}/player) for ${total} player${total === 1 ? '' : 's'}.`;

    const tooCramped = actualCells < total;
    if (tooCramped) {
        mazeSizeErrorEl.textContent =
            `Too cramped: ${actualCells} cells for ${total} players is below the 1 cell/player minimum. Increase maze size or reduce player count.`;
        mazeSizeErrorEl.style.display = 'block';
    } else {
        mazeSizeErrorEl.style.display = 'none';
    }

    updateCreateButtonState();
}

humanCountInput.addEventListener('input', () => {
    humanCountValueEl.textContent = humanCountInput.value;
    if (currentTotalPlayers() > 16) {
        aiCountInput.value = Math.max(0, 16 - parseInt(humanCountInput.value, 10));
        aiCountValueEl.textContent = aiCountInput.value;
    }
    updateMazeSizeSummary();
});

aiCountInput.addEventListener('input', () => {
    aiCountValueEl.textContent = aiCountInput.value;
    if (currentTotalPlayers() > 16) {
        humanCountInput.value = Math.max(1, 16 - parseInt(aiCountInput.value, 10));
        humanCountValueEl.textContent = humanCountInput.value;
    }
    updateMazeSizeSummary();
});

mazeWidthInput.addEventListener('input', updateMazeSizeSummary);
mazeLengthInput.addEventListener('input', updateMazeSizeSummary);
mazeHeightInput.addEventListener('input', updateMazeSizeSummary);
gameNameInput.addEventListener('input', updateCreateButtonState);

createGameButton.addEventListener('click', () => {
    ws.send(JSON.stringify({
        type: 'create-game',
        name: gameNameInput.value.trim() || 'Untitled Game',
        password: gamePasswordInput.value || null,
        humanCount: parseInt(humanCountInput.value, 10),
        aiCount: parseInt(aiCountInput.value, 10),
        width: parseInt(mazeWidthInput.value, 10),
        length: parseInt(mazeLengthInput.value, 10),
        height: parseInt(mazeHeightInput.value, 10),
        sessionToken,
        playerName: playerProfile.name,
        primaryColor: playerProfile.primaryColor,
        secondaryColor: playerProfile.secondaryColor,
        sprite: playerProfile.sprite
    }));
});

updateMazeSizeSummary();

// --- Écran: lobby (salle d'attente avant démarrage) ---

const lobbyGameNameEl = document.getElementById('lobby-game-name');
const lobbySizeEl = document.getElementById('lobby-size');
const lobbyRosterEl = document.getElementById('lobby-roster');
const startGameButton = document.getElementById('start-game-button');
const lobbyLeaveButton = document.getElementById('lobby-leave-button');
const lobbyWaitingMessageEl = document.getElementById('lobby-waiting-message');

function renderLobby(msg) {
    lobbyGameNameEl.textContent = msg.name;
    lobbySizeEl.textContent = `${msg.width} x ${msg.length} x ${msg.height} -- ${msg.humanSlots} human, ${msg.aiSlots} AI`;

    lobbyRosterEl.innerHTML = '';
    for (const entry of msg.roster) {
        if (!identities.has(entry.playerId)) {
            registerIdentity(entry);
        }
        lobbyRosterEl.appendChild(makeRosterRow(entry));

        if (entry.playerId === playerId) {
            isHost = entry.isHost;
        }
    }

    startGameButton.style.display = isHost ? 'inline-block' : 'none';
    lobbyWaitingMessageEl.style.display = isHost ? 'none' : 'block';
}

startGameButton.addEventListener('click', () => {
    ws.send(JSON.stringify({ type: 'start-game' }));
});

lobbyLeaveButton.addEventListener('click', () => {
    ws.send(JSON.stringify({ type: 'leave-game' }));
});

// --- Rail droit du jeu ---

const gameLeaveButton = document.getElementById('game-leave-button');
gameLeaveButton.addEventListener('click', () => {
    ws.send(JSON.stringify({ type: 'leave-game' }));
});

// --- Entrée clavier ---

const input = {
    turnLeft: false,
    turnRight: false,
    throttleUp: false,
    throttleDown: false
};

function sendInput() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', ...input }));
    }
}

const KEY_MAP = {
    ArrowLeft: 'turnLeft',
    ArrowRight: 'turnRight',
    ArrowUp: 'throttleUp',
    ArrowDown: 'throttleDown'
};

const FIRE_KEY_MAP = {
    w: 'fireForward',
    s: 'fireBack',
    a: 'fireLeft',
    d: 'fireRight'
};

let inputHandlingReady = false;

function setupInputHandling() {
    if (inputHandlingReady) return;
    inputHandlingReady = true;

    window.addEventListener('keydown', (e) => {
        const fireDirection = FIRE_KEY_MAP[e.key.toLowerCase()];
        if (fireDirection) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'fire', direction: fireDirection }));
            }
            return;
        }

        const field = KEY_MAP[e.key];
        if (!field || input[field]) return;
        input[field] = true;
        sendInput();
    });

    window.addEventListener('keyup', (e) => {
        const field = KEY_MAP[e.key];
        if (!field) return;
        input[field] = false;
        sendInput();
    });

}

document.addEventListener('visibilitychange', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'visibility', hidden: document.hidden }));
    }
});

// --- Rendu du jeu ---

const canvas = document.getElementById('maze-canvas');
canvas.width = VIEWPORT_WIDTH;
canvas.height = VIEWPORT_HEIGHT;
const ctx = canvas.getContext('2d');
const levelLabel = document.getElementById('level-label');

function findMyTank() {
    return tanks.find(t => t.playerId === playerId);
}

function myDisplayedZ(myTank) {
    if (!myTank) return 0;
    if (!myTank.transitioning) return myTank.z;
    return myTank.transitionProgress >= 0.5 ? myTank.transitionToZ : myTank.transitionFromZ;
}

function tankActiveZSet(tank) {
    return tank.transitioning ? [tank.transitionFromZ, tank.transitionToZ] : [tank.z];
}

function drawMazeLevel(z, camX, camY, myTank) {
    ctx.strokeStyle = '#0f0';
    ctx.lineWidth = 2;

    const firstCellX = Math.max(0, Math.floor((camX - VIEWPORT_WIDTH / 2) / mazeConfig.cellSize));
    const lastCellX = Math.min(mazeConfig.largeur - 1, Math.ceil((camX + VIEWPORT_WIDTH / 2) / mazeConfig.cellSize));
    const firstCellY = Math.max(0, Math.floor((camY - VIEWPORT_HEIGHT / 2) / mazeConfig.cellSize));
    const lastCellY = Math.min(mazeConfig.longeur - 1, Math.ceil((camY + VIEWPORT_HEIGHT / 2) / mazeConfig.cellSize));

    for (let y = firstCellY; y <= lastCellY; y++) {
        for (let x = firstCellX; x <= lastCellX; x++) {
            const cell = maze[z][y][x];
            const left = x * mazeConfig.cellSize - camX + VIEWPORT_WIDTH / 2;
            const top = y * mazeConfig.cellSize - camY + VIEWPORT_HEIGHT / 2;
            const right = left + mazeConfig.cellSize;
            const bottom = top + mazeConfig.cellSize;

            ctx.beginPath();

            if (!(cell & Direction.North)) { ctx.moveTo(left, top); ctx.lineTo(right, top); }
            if (!(cell & Direction.South)) { ctx.moveTo(left, bottom); ctx.lineTo(right, bottom); }
            if (!(cell & Direction.West)) { ctx.moveTo(left, top); ctx.lineTo(left, bottom); }
            if (!(cell & Direction.East)) { ctx.moveTo(right, top); ctx.lineTo(right, bottom); }

            ctx.stroke();

            const icons = getVerticalIcons(mazeConfig.cellSize, x, y, cell, Direction);
            ctx.font = 'bold 32px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            for (const icon of icons) {
                const screenX = icon.x - camX + VIEWPORT_WIDTH / 2;
                const screenY = icon.y - camY + VIEWPORT_HEIGHT / 2;

                const onCooldown = myTank
                    && myTank.verticalCooldown
                    && myTank.verticalCooldown.direction === icon.dir
                    && myTank.verticalCooldown.cellX === x
                    && myTank.verticalCooldown.cellY === y;

                ctx.globalAlpha = onCooldown ? 0.3 : 1;
                ctx.fillStyle = '#0af';
                ctx.fillText(icon.dir === 'up' ? '↑' : '↓', screenX, screenY);
                ctx.globalAlpha = 1;
            }
        }
    }
}

const HEALTH_BAR_WIDTH = 6;
const HEALTH_BAR_HEIGHT = 24;
const HEALTH_BAR_GAP = 4;
const HEALTH_BAR_SPACING = 2;
const HEALTH_SEGMENTS = 10;

function drawHealthBarColumn(x, y, fraction) {
    const segmentHeight = HEALTH_BAR_HEIGHT / HEALTH_SEGMENTS;
    const filledSegments = Math.round(fraction * HEALTH_SEGMENTS);

    ctx.strokeStyle = '#0f0';
    ctx.lineWidth = 2;

    for (let i = 0; i < HEALTH_SEGMENTS; i++) {
        if (i >= filledSegments) continue;
        const segTop = y + HEALTH_BAR_HEIGHT - (i + 1) * segmentHeight;
        const lineY = segTop + segmentHeight / 2;
        ctx.beginPath();
        ctx.moveTo(x, lineY);
        ctx.lineTo(x + HEALTH_BAR_WIDTH, lineY);
        ctx.stroke();
    }
}

function drawHealthBar(tank) {
    const health = tank.health ?? 100;
    const primaryFraction = Math.min(health, 100) / 100;
    const overflowFraction = Math.max(0, health - 100) / 100;

    const barLeft = TANK_RADIUS + HEALTH_BAR_GAP;
    const barTop = -HEALTH_BAR_HEIGHT / 2;

    ctx.save();
    ctx.rotate(Math.PI / 2);
    drawHealthBarColumn(barLeft, barTop, primaryFraction);
    if (health > 100) {
        drawHealthBarColumn(barLeft + HEALTH_BAR_WIDTH + HEALTH_BAR_SPACING, barTop, overflowFraction);
    }
    ctx.restore();
}

function drawAfkLabel(screenX, screenY) {
    ctx.save();
    ctx.font = 'bold 14px Impact, "Arial Narrow", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f00';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.strokeText('AFK', screenX, screenY - TANK_RADIUS - 10);
    ctx.fillText('AFK', screenX, screenY - TANK_RADIUS - 10);
    ctx.restore();
}

function drawNameLabel(screenX, screenY, name) {
    ctx.save();
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.strokeText(name, screenX, screenY + TANK_RADIUS + 12);
    ctx.fillText(name, screenX, screenY + TANK_RADIUS + 12);
    ctx.restore();
}

function drawTank(tank, camX, camY, alpha) {
    const screenX = tank.x - camX + VIEWPORT_WIDTH / 2;
    const screenY = tank.y - camY + VIEWPORT_HEIGHT / 2;
    const identity = identities.get(tank.playerId);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(screenX, screenY);
    ctx.rotate(tank.heading);

    if (identity) {
        ctx.drawImage(identity.canvas, -SPRITE_SIZE / 2, -SPRITE_SIZE / 2, SPRITE_SIZE, SPRITE_SIZE);
    } else {
        ctx.fillStyle = '#888';
        ctx.beginPath();
        ctx.arc(0, 0, TANK_RADIUS, 0, Math.PI * 2);
        ctx.fill();
    }

    drawHealthBar(tank);

    ctx.restore();

    if (identity) {
        drawNameLabel(screenX, screenY, identity.name);
    }

    if (tank.afk) {
        ctx.globalAlpha = alpha;
        drawAfkLabel(screenX, screenY);
        ctx.globalAlpha = 1;
    }
}

function drawShot(shot, camX, camY) {
    const screenX = shot.x - camX + VIEWPORT_WIDTH / 2;
    const screenY = shot.y - camY + VIEWPORT_HEIGHT / 2;
    ctx.fillStyle = '#ff0';
    ctx.fillRect(screenX - 2, screenY - 2, 4, 4);
}

function drawFog() {
    const centerX = VIEWPORT_WIDTH / 2;
    const centerY = VIEWPORT_HEIGHT / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    ctx.arc(centerX, centerY, FOG_RADIUS, 0, Math.PI * 2, true);
    ctx.closePath();
    ctx.fillStyle = '#000';
    ctx.fill('evenodd');
    ctx.restore();
}

function drawScene() {
    if (!maze) return;

    ctx.clearRect(0, 0, VIEWPORT_WIDTH, VIEWPORT_HEIGHT);

    const myTank = findMyTank();
    const camX = myTank ? myTank.x : 0;
    const camY = myTank ? myTank.y : 0;
    const localZ = myDisplayedZ(myTank);

    drawMazeLevel(localZ, camX, camY, myTank);

    for (const tank of tanks) {
        const zSet = tankActiveZSet(tank);
        if (!zSet.includes(localZ)) continue;
        const alpha = tank.transitioning ? 0.55 : 1;
        drawTank(tank, camX, camY, alpha);
    }

    for (const shot of shots) {
        if (shot.z !== localZ) continue;
        drawShot(shot, camX, camY);
    }

    drawFog();

    levelLabel.textContent = `Player ${playerId ?? '?'} -- Level (z): ${localZ}`;
}
