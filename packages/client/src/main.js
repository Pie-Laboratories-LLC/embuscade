import { Direction } from '@bolo/shared/Direction.js';
import { getVerticalIcons } from '@bolo/shared/MazeGeometry.js';
import { PRESET_SPRITES, TRANSPARENT } from '@bolo/shared/PresetSprites.js';
import { DEFAULT_THEME } from '@bolo/shared/Theme.js';

const TANK_RADIUS = 14;
const SPRITE_SIZE = 32;
const VIEWPORT_WIDTH = 640;
const VIEWPORT_HEIGHT = 480;
const FOG_RADIUS = 256;
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
let chatMessages = [];

const identities = new Map();

function isLikelyMobile() {
    const hasCoarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const noKeyboardHint = window.matchMedia && window.matchMedia('(hover: none)').matches;
    const narrowViewport = window.innerWidth < 1280;

    const pointerSaysMobile = window.matchMedia ? (hasCoarsePointer && noKeyboardHint) : false;

    return pointerSaysMobile || narrowViewport;
}

function getOrCreateSessionToken() {
    let token = localStorage.getItem(SESSION_TOKEN_KEY);
    if (!token) {
        token = crypto.randomUUID();
        localStorage.setItem(SESSION_TOKEN_KEY, token);
    }
    return token;
}

function main() {
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

    // --- Chat (partagé entre les écrans browse/lobby/game -- une seule salle
    // active à la fois côté serveur, donc un seul historique local ici aussi) ---

    function clearChat() {
        chatMessages = [];
        renderAllChatPanels();
    }

    function appendChatMessage(entry) {
        chatMessages.push(entry);
        if (chatMessages.length > 200) chatMessages.shift(); // borne la mémoire locale
        renderAllChatPanels();
    }

    function renderChatInto(container) {
        container.innerHTML = '';
        for (const entry of chatMessages) {
            const row = document.createElement('div');
            row.className = 'chat-message-row';

            const spriteCanvas = document.createElement('canvas');
            spriteCanvas.width = SPRITE_SIZE;
            spriteCanvas.height = SPRITE_SIZE;
            spriteCanvas.className = 'chat-sprite';
            const pctx = spriteCanvas.getContext('2d');
            const rendered = renderSpriteToCanvas(entry.sprite, entry.primaryColor, entry.secondaryColor);
            pctx.drawImage(rendered, 0, 0);

            const nameSpan = document.createElement('span');
            nameSpan.className = 'chat-name';
            nameSpan.textContent = entry.name + ':';

            const textSpan = document.createElement('span');
            textSpan.className = 'chat-text';
            textSpan.textContent = entry.text;

            row.appendChild(spriteCanvas);
            row.appendChild(nameSpan);
            row.appendChild(textSpan);
            container.appendChild(row);
        }
        container.scrollTop = container.scrollHeight;
    }

    function sendChat(text) {
        const trimmed = text.trim();
        if (!trimmed) return;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'chat', text: trimmed }));
        }
    }

    let browserPlayersList = [];

    function openWhoModal(players) {
        whoModalList.innerHTML = '';
        for (const entry of players) {
            whoModalList.appendChild(makeRosterRow(entry));
        }
        whoModalOverlay.style.display = 'flex';
    }

    function closeWhoModal() {
        whoModalOverlay.style.display = 'none';
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && whoModalOverlay.style.display !== 'none') {
            closeWhoModal();
        }
    });

    // --- Éléments des différents écrans ---

    const whoModalOverlay = document.getElementById('who-modal-overlay');
    const whoModalClose = document.getElementById('who-modal-close');
    const whoModalList = document.getElementById('who-modal-list');

    const loadingEl = document.getElementById('loading-status');
    const dialogEl = document.getElementById('join-dialog');
    const browserScreenEl = document.getElementById('browser-screen');
    const builderDialogEl = document.getElementById('builder-dialog');
    const lobbyScreenEl = document.getElementById('lobby-screen');
    const gameViewEl = document.getElementById('game-view');

    const connectionDotEl = document.getElementById('connection-dot');
    const connectionTextEl = document.getElementById('connection-text');

    const nameInput = document.getElementById('player-name');
    const primaryColorInput = document.getElementById('primary-color');
    const secondaryColorInput = document.getElementById('secondary-color');
    const presetListEl = document.getElementById('preset-list');
    const joinButton = document.getElementById('join-button');

    const gamesListEl = document.getElementById('games-list');
    const browserEmptyMessageEl = document.getElementById('browser-empty-message');
    const browserCreateButton = document.getElementById('browser-create-button');
    const browserLeaveButton = document.getElementById('browser-leave-button');
    const browserChatMessagesEl = document.getElementById('browser-chat-messages');
    const browserChatInput = document.getElementById('browser-chat-input');
    const browserChatSendButton = document.getElementById('browser-chat-send-button');
    const browserWhoButton = document.getElementById('browser-who-button');

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

    const lobbyGameNameEl = document.getElementById('lobby-game-name');
    const lobbySizeEl = document.getElementById('lobby-size');
    const lobbyRosterEl = document.getElementById('lobby-roster');
    const startGameButton = document.getElementById('start-game-button');
    const lobbyLeaveButton = document.getElementById('lobby-leave-button');
    const lobbyWaitingMessageEl = document.getElementById('lobby-waiting-message');
    const lobbyChatMessagesEl = document.getElementById('lobby-chat-messages');
    const lobbyChatInput = document.getElementById('lobby-chat-input');
    const lobbyChatSendButton = document.getElementById('lobby-chat-send-button');

    const gameLeaveButton = document.getElementById('game-leave-button');
    const gameChatMessagesEl = document.getElementById('game-chat-messages');
    const gameChatInput = document.getElementById('game-chat-input');
    const gameChatSendButton = document.getElementById('game-chat-send-button');

    const gameChatPanelEl = document.getElementById('game-chat-panel');
    const gameChatHintEl = document.getElementById('game-chat-hint');
    const gameChatInputRow = document.getElementById('game-chat-input-row');

    const scoreTargetInput = document.getElementById('score-target');
    const scoreTargetValueEl = document.getElementById('score-target-value');
    const unlimitedTimeCheckbox = document.getElementById('unlimited-time-checkbox');
    const timeLimitRow = document.getElementById('time-limit-row');
    const timeLimitInput = document.getElementById('time-limit');
    const timeLimitValueEl = document.getElementById('time-limit-value');

    const gameEndOverlay = document.getElementById('game-end-overlay');
    const gameEndSprite = document.getElementById('game-end-sprite');
    const gameEndTitle = document.getElementById('game-end-title');
    const endChatMessagesEl = document.getElementById('end-chat-messages');
    const endChatInput = document.getElementById('end-chat-input');
    const endChatSendButton = document.getElementById('end-chat-send-button');
    const endWhoButton = document.getElementById('end-who-button');
    const gameEndLeaveButton = document.getElementById('game-end-leave-button');

    const scoreboardEl = document.getElementById('scoreboard');

    whoModalClose.addEventListener('click', closeWhoModal);
    whoModalOverlay.addEventListener('click', (e) => {
        if (e.target === whoModalOverlay) closeWhoModal(); // clic sur le fond, pas la boîte
    });

    function hideAllScreens() {
        loadingEl.style.display = 'none';
        dialogEl.style.display = 'none';
        browserScreenEl.style.display = 'none';
        builderDialogEl.style.display = 'none';
        lobbyScreenEl.style.display = 'none';
        gameViewEl.style.display = 'none';
    }

    function showBrowserScreen() {
        hideAllScreens();
        browserScreenEl.style.display = 'flex';
        renderAllChatPanels();
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

    function setConnectionStatus(connected) {
        connectionDotEl.classList.toggle('disconnected', !connected);
        connectionTextEl.textContent = connected ? '' : 'client disconnected';
    }

    // --- Écran: profil ---

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
    let endGamePlayersList = [];

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

                const savedProfile = loadSavedProfile();
                if (savedProfile) {
                    playerProfile = {
                        name: savedProfile.name,
                        primaryColor: savedProfile.primaryColor,
                        secondaryColor: savedProfile.secondaryColor,
                        sprite: PRESET_SPRITES[savedProfile.preset] ?? PRESET_SPRITES.tank
                    };
                }

                for (const entry of msg.roster) {
                    registerIdentity(entry);
                }
                clearChat();

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
                    hideGameChatInput();
                    drawScene();
                } else {
                    hideAllScreens();
                    lobbyScreenEl.style.display = 'flex';
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
                browserPlayersList = msg.players;
            } else if (msg.type === 'chat-message') {
                appendChatMessage(msg);
            } else if (msg.type === 'join-rejected') {
                alert(msg.reason === 'bad-password' ? 'Incorrect password.' : 'That game is full.');
            } else if (msg.type === 'lobby-joined') {
                playerId = msg.playerId;
                registerIdentity({ playerId, ...playerProfile });
                clearChat();

                hideAllScreens();
                lobbyScreenEl.style.display = 'flex';
            } else if (msg.type === 'lobby-state') {
                renderLobby(msg);
            } else if (msg.type === 'left-game') {
                playerId = null;
                tanks = [];
                shots = [];
                maze = null;
                clearChat();
                gameEndOverlay.style.display = 'none';
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
                renderAllChatPanels();
                hideGameChatInput();
                drawScene();
            } else if (msg.type === 'state') {
                tanks = msg.tanks;
                shots = msg.shots;
                drawScene();
            } else if (msg.type === 'game-ended') {
                endGamePlayersList = msg.scores;
                const winnerCanvas = renderSpriteToCanvas(msg.winner.sprite, msg.winner.primaryColor, msg.winner.secondaryColor);
                gameEndSprite.getContext('2d').drawImage(winnerCanvas, 0, 0);
                gameEndTitle.textContent = `${msg.winner.name} Wins!`;
                gameEndOverlay.style.display = 'flex';
                renderAllChatPanels();
            } else if (msg.type === 'left-game') {
                playerId = null;
                tanks = [];
                shots = [];
                maze = null;
                clearChat();
                gameEndOverlay.style.display = 'none';
                showBrowserScreen();
            }

        });

        ws.addEventListener('close', () => {
            setConnectionStatus(false);
            console.log('Disconnected from Bolo server');
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
                + ` -- ${game.preview}`;
            if (game.hasPassword) {
                const lockTag = document.createElement('span');
                lockTag.textContent = ' 🔒';
                info.appendChild(lockTag);
            }

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

    browserCreateButton.addEventListener('click', () => {
        hideAllScreens();
        builderDialogEl.style.display = 'block';
    });

    browserLeaveButton.addEventListener('click', () => {
        hideAllScreens();
        dialogEl.style.display = 'block';
    });

    browserChatSendButton.addEventListener('click', () => {
        sendChat(browserChatInput.value);
        browserChatInput.value = '';
    });
    browserChatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            sendChat(browserChatInput.value);
            browserChatInput.value = '';
        }
    });
    browserWhoButton.addEventListener('click', () => {
        openWhoModal(browserPlayersList);
    });

    // --- Écran: jeu sur partie ---
    endChatSendButton.addEventListener('click', () => {
        sendChat(endChatInput.value);
        endChatInput.value = '';
    });
    endChatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            sendChat(endChatInput.value);
            endChatInput.value = '';
        }
    });
    endWhoButton.addEventListener('click', () => {
        openWhoModal(endGamePlayersList);
    });
    gameEndLeaveButton.addEventListener('click', () => {
        ws.send(JSON.stringify({ type: 'leave-game' }));
    });

    // --- Écran: créer une partie ---

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

    scoreTargetInput.addEventListener('input', () => {
        scoreTargetValueEl.textContent = scoreTargetInput.value;
    });

    unlimitedTimeCheckbox.addEventListener('change', () => {
        timeLimitRow.style.display = unlimitedTimeCheckbox.checked ? 'none' : 'flex';
    });

    timeLimitInput.addEventListener('input', () => {
        timeLimitValueEl.textContent = timeLimitInput.value;
    });

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
            sprite: playerProfile.sprite,
            scoreTarget: parseInt(scoreTargetInput.value, 10),
            timeLimitMs: unlimitedTimeCheckbox.checked ? null : parseInt(timeLimitInput.value, 10),
        }));
    });

    updateMazeSizeSummary();

    // --- Écran: lobby (salle d'attente avant démarrage) ---

    function renderLobby(msg) {
        lobbyGameNameEl.textContent = msg.name;
        if (msg.hasPassword) {
            lobbyGameNameEl.textContent += ' 🔒';
        }
        lobbySizeEl.textContent = `${msg.width} x ${msg.length} x ${msg.height} -- ${msg.humanSlots} human, ${msg.aiSlots} AI -- ${msg.preview}`;

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

        renderAllChatPanels();
    }

    startGameButton.addEventListener('click', () => {
        ws.send(JSON.stringify({ type: 'start-game' }));
    });

    lobbyLeaveButton.addEventListener('click', () => {
        ws.send(JSON.stringify({ type: 'leave-game' }));
    });

    lobbyChatSendButton.addEventListener('click', () => {
        sendChat(lobbyChatInput.value);
        lobbyChatInput.value = '';
    });
    lobbyChatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            sendChat(lobbyChatInput.value);
            lobbyChatInput.value = '';
        }
    });

    // --- Rail droit du jeu ---

    function renderAllChatPanels() {
        for (const el of [browserChatMessagesEl, lobbyChatMessagesEl, gameChatMessagesEl, endChatMessagesEl]) {
            if (el && el.offsetParent !== null) renderChatInto(el);
        }
    }

    gameLeaveButton.addEventListener('click', () => {
        ws.send(JSON.stringify({ type: 'leave-game' }));
    });

    function sendGameChatAndBlur() {
        sendChat(gameChatInput.value);
        gameChatInput.value = '';
        gameChatInput.blur();
    }

    function showGameChatInput() {
        gameChatInputRow.style.display = 'flex';
        gameChatHintEl.style.display = 'none';
        gameChatInput.focus();
    }

    function hideGameChatInput() {
        gameChatInputRow.style.display = 'none';
        gameChatHintEl.style.display = 'block';
        gameChatInput.blur();
    }

    function sendGameChatAndClose() {
        sendChat(gameChatInput.value);
        gameChatInput.value = '';
        hideGameChatInput();
    }

    gameChatSendButton.addEventListener('click', sendGameChatAndClose);
    gameChatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            sendGameChatAndClose();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            gameChatInput.value = '';
            hideGameChatInput();
        }
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
            if (document.activeElement === gameChatInput) return; // ne pas piloter le char en tapant un message

            if (e.key === '/') {
                e.preventDefault();
                showGameChatInput();
                return;
            }


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

        document.addEventListener('visibilitychange', () => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'visibility', hidden: document.hidden }));
            }
        });
    }

    // --- Rendu du jeu ---

    const canvas = document.getElementById('maze-canvas');
    canvas.width = VIEWPORT_WIDTH;
    canvas.height = VIEWPORT_HEIGHT;
    const ctx = canvas.getContext('2d');

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

        ctx.globalAlpha = alpha;
        if (identity) {
            drawNameLabel(screenX, screenY, identity.name);
        }
        if (tank.afk) {
            drawAfkLabel(screenX, screenY);
        }
        ctx.globalAlpha = 1;
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

    const deathEffects = new Map(); // playerId -> { x, y, z, lastPopTime, pops: [{x, y, spawnTime}] }

    function updateDeathEffects() {
        const currentDeadIds = new Set(tanks.filter(t => t.dead).map(t => t.playerId));
        const currentAliveIds = new Set(tanks.filter(t => !t.dead).map(t => t.playerId));

        for (const tank of tanks) {
            if (tank.dead && !deathEffects.has(tank.playerId)) {
                const lastKnown = lastKnownTankPositions.get(tank.playerId);
                if (!lastKnown) continue;
                deathEffects.set(tank.playerId, {
                    x: lastKnown.x, y: lastKnown.y, z: lastKnown.z,
                    lastPopTime: 0, pops: []
                });
            }
        }

        for (const id of deathEffects.keys()) {
            if (!currentDeadIds.has(id)) deathEffects.delete(id);
        }

        for (const effect of deathEffects.values()) {
            const now = Date.now();
            if (now - effect.lastPopTime > 150 + Math.random() * 200) {
                effect.lastPopTime = now;
                effect.pops.push({
                    x: effect.x + (Math.random() - 0.5) * TANK_RADIUS * 1.5,
                    y: effect.y + (Math.random() - 0.5) * TANK_RADIUS * 1.5,
                    spawnTime: now
                });
            }
        }

        for (const tank of tanks) {
            if (!tank.dead) {
                lastKnownTankPositions.set(tank.playerId, { x: tank.x, y: tank.y, z: tank.z });
            }
        }
    }

    const lastKnownTankPositions = new Map();

    function drawDeathEffects(camX, camY, localZ) {
        for (const effect of deathEffects.values()) {
            if (effect.z !== localZ) continue;

            for (const pop of effect.pops) {
                const screenX = pop.x - camX + VIEWPORT_WIDTH / 2;
                const screenY = pop.y - camY + VIEWPORT_HEIGHT / 2;

                ctx.save();
                ctx.font = '20px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('🔥', screenX, screenY);
                ctx.restore();
            }
        }
    }

    function renderScoreboard() {
        const sorted = [...tanks].sort((a, b) => b.score - a.score);
        scoreboardEl.innerHTML = '';
        for (const tank of sorted) {
            const identity = identities.get(tank.playerId);
            if (!identity) continue;

            const li = document.createElement('li');

            const spriteCanvas = document.createElement('canvas');
            spriteCanvas.width = SPRITE_SIZE;
            spriteCanvas.height = SPRITE_SIZE;
            spriteCanvas.className = 'roster-sprite';
            spriteCanvas.getContext('2d').drawImage(identity.canvas, 0, 0);

            const nameSpan = document.createElement('span');
            nameSpan.textContent = identity.name;

            const scoreSpan = document.createElement('span');
            scoreSpan.className = 'score-value';
            scoreSpan.textContent = tank.score;

            li.appendChild(spriteCanvas);
            li.appendChild(nameSpan);
            li.appendChild(scoreSpan);
            scoreboardEl.appendChild(li);
        }
    }

    function drawScene() {
        if (!maze) return;

        ctx.clearRect(0, 0, VIEWPORT_WIDTH, VIEWPORT_HEIGHT);

        const myTank = findMyTank();
        let camX, camY, localZ;

        if (myTank) {
            camX = myTank.x;
            camY = myTank.y;
            localZ = myDisplayedZ(myTank);
        } else {
            const lastKnown = playerId !== null ? lastKnownTankPositions.get(playerId) : null;
            camX = lastKnown ? lastKnown.x : 0;
            camY = lastKnown ? lastKnown.y : 0;
            localZ = lastKnown ? lastKnown.z : 0;
        }

        drawMazeLevel(localZ, camX, camY, myTank);

        for (const tank of tanks) {
            if (tank.dead) continue;
            const zSet = tankActiveZSet(tank);
            if (!zSet.includes(localZ)) continue;
            const alpha = tank.transitioning ? 0.55 : 1;
            drawTank(tank, camX, camY, alpha);
        }

        updateDeathEffects();
        drawDeathEffects(camX, camY, localZ);

        for (const shot of shots) {
            if (shot.z !== localZ) continue;
            drawShot(shot, camX, camY);
        }

        drawFog();
        renderScoreboard();
    }
}
if (isLikelyMobile()) {
    document.getElementById('mobile-block').style.display = 'flex';
}
else {
    main();
}
