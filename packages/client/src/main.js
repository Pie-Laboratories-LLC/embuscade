import { Direction } from '@bolo/shared/Direction.js';
import { getVerticalIcons } from '@bolo/shared/MazeGeometry.js';
import { PRESET_SPRITES, TRANSPARENT } from '@bolo/shared/PresetSprites.js';
import { DEFAULT_THEME } from '@bolo/shared/Theme.js';
import { CHAT_MAX_BYTES, PLAYER_NAME_MAX_BYTES, truncateToBytes } from '@bolo/shared/Limits.js';
import { initAudio, resumeAudioContext, playPositional, playSound } from './AudioManager.js';
import { loadFonts, STENCIL_FONT_FAMILY } from './fonts.js';
import { showSplashScreen, hideSplashScreen } from './splash.js';
import { showHelpModal, hideHelpModal } from './help.js';
import { Builder } from './builder.js';
import { createVoiceChat } from './voiceChat.js';
import './embuscade.css';

const TANK_RADIUS = 14;
const SPRITE_SIZE = 32;
const RAM_HORNS_CAPACITY = 75;
const VIEWPORT_WIDTH = 640;
const VIEWPORT_HEIGHT = 480;
const FOG_RADIUS = 256;
const PING_INTERVAL_MS = 25000;
const RECONNECT_RETRY_MS = 2000;
const PROFILE_STORAGE_KEY = 'bolo:playerProfile';
const SESSION_TOKEN_KEY = 'bolo:sessionToken';
const VOICE_CHAT_STORAGE_KEY = 'bolo:voiceChatEnabled';

// Everything mount() renders into its container. Ids are emb- prefixed so
// they can't collide with a host page's own (see embuscade.css's header).
const MARKUP = `
    <div id="emb-mobile-block" style="display: none;">
      <div id="emb-mobile-block-box">
        <h2>Embuscade needs a keyboard</h2>
        <p>Embuscade is played with arrow keys, WASD, and other keyboard shortcuts -- it isn't playable on a phone or touch-only tablet.</p>
        <p>Please come back on a desktop, laptop, or a tablet with a physical keyboard attached.</p>
      </div>
    </div>

    <div class="embuscade-screens">
      <div id="emb-loading-status">Connecting...</div>

      <div id="emb-join-dialog" style="display: none;">
        <h2>Join Embuscade</h2>
        <label for="emb-player-name">Name</label>
        <input type="text" id="emb-player-name" maxlength="32" />

        <label for="emb-primary-color">Primary colour</label>
        <input type="color" id="emb-primary-color" />

        <label for="emb-secondary-color">Secondary colour</label>
        <input type="color" id="emb-secondary-color" />

        <label>Tank style</label>
        <div id="emb-preset-list"></div>

        <div class="button-row">
          <button id="emb-join-button">Join</button>
          <button id="emb-join-cancel-button">Cancel</button>
        </div>
      </div>

      <div id="emb-browser-screen" class="screen-with-rail" style="display: none;">
        <div class="chat-main">
          <div id="emb-browser-chat-messages" class="chat-messages"></div>
          <div class="chat-input-row">
            <button id="emb-browser-who-button">Who</button>
            <input type="text" id="emb-browser-chat-input" placeholder="/ Say something" />
            <button id="emb-browser-chat-send-button">Chat</button>
          </div>
        </div>
        <div id="emb-right-rail">
          <h3>Games</h3>
          <div class="button-row">
            <button id="emb-browser-create-button">Create Game</button>
            <button id="emb-browser-leave-button">Leave Game</button>
          </div>
          <ul id="emb-games-list"></ul>
          <div id="emb-browser-empty-message">No open games -- create one!</div>
        </div>
      </div>

      <div id="emb-builder-dialog" style="display: none;">
        <h2 id="emb-builder-title">Create Game</h2>
        <label for="emb-game-name">Game name</label>
        <input type="text" id="emb-game-name" maxlength="64" placeholder="My Embuscade Game" />

        <label for="emb-game-password">Password (optional)</label>
        <input type="text" id="emb-game-password" maxlength="64" placeholder="Leave blank for no password" />

        <label for="emb-human-count">Human players: <span id="emb-human-count-value">2</span></label>
        <div class="slider-row"><input type="range" id="emb-human-count" min="1" max="16" value="2" /></div>

        <label for="emb-ai-count">AI players: <span id="emb-ai-count-value">0</span></label>
        <div class="slider-row"><input type="range" id="emb-ai-count" min="0" max="15" value="0" /></div>

        <label for="emb-maze-width">Width: <span id="emb-maze-width-value">10</span></label>
        <div class="slider-row"><input type="range" id="emb-maze-width" min="2" max="10" value="10" /></div>

        <label for="emb-maze-length">Length: <span id="emb-maze-length-value">10</span></label>
        <div class="slider-row"><input type="range" id="emb-maze-length" min="2" max="10" value="10" /></div>

        <label for="emb-maze-height">Height: <span id="emb-maze-height-value">1</span></label>
        <div class="slider-row"><input type="range" id="emb-maze-height" min="1" max="10" value="1" /></div>

        <div id="emb-maze-size-summary"></div>
        <div id="emb-maze-size-error"></div>

        <label for="emb-score-target">Play to: <span id="emb-score-target-value">10</span> points</label>
        <div class="slider-row"><input type="range" id="emb-score-target" min="1" max="30" value="10" /></div>

        <label>
          <input type="checkbox" id="emb-unlimited-time-checkbox" checked /> Unlimited time
        </label>
        <div id="emb-time-limit-row" class="slider-row" style="display: none;">
          <label for="emb-time-limit">Time limit: <span id="emb-time-limit-value">15</span> minutes</label>
          <input type="range" id="emb-time-limit" min="2" max="60" value="15" />
        </div>

        <div class="button-row">
          <button id="emb-create-game-button">Create Game</button>
          <button id="emb-builder-cancel-button">Cancel</button>
        </div>
      </div>

      <div id="emb-lobby-screen" class="screen-with-rail" style="display: none;">
        <div class="chat-main">
          <div id="emb-lobby-chat-messages" class="chat-messages"></div>
          <div class="chat-input-row">
            <input type="text" id="emb-lobby-chat-input" placeholder="/ Say something" />
            <button id="emb-lobby-chat-send-button">Chat</button>
          </div>
        </div>
        <div id="emb-lobby-right-rail">
          <h3 id="emb-lobby-game-name"></h3>
          <div id="emb-lobby-size"></div>
          <button id="emb-edit-game-button" style="display: none;">Edit Game</button>
          <ul id="emb-lobby-roster"></ul>
          <div class="button-row">
            <button id="emb-start-game-button" style="display: none;">Start Game</button>
            <button id="emb-lobby-leave-button">Leave Game</button>
          </div>
          <div id="emb-lobby-waiting-message">Waiting for the host to start the game...</div>
        </div>
      </div>

      <div id="emb-game-view" class="screen-with-rail" style="display: none;">
        <div id="emb-game-view-inner">
          <canvas id="emb-maze-canvas"></canvas>
          <div class="chat-main" id="emb-game-chat-panel" style="height: 120px; margin-top: 8px; position: relative;">
            <div id="emb-game-chat-messages" class="chat-messages chat-messages-tight"></div>
            <div id="emb-game-chat-hint">press '/' to chat</div>
            <div class="chat-input-row" id="emb-game-chat-input-row" style="display: none;">
              <input type="text" id="emb-game-chat-input" placeholder="Say something..." />
              <button id="emb-game-chat-send-button">Chat</button>
            </div>
          </div>
        </div>
        <div id="emb-game-right-rail">
          <h3>Embuscade</h3>
          <div id="emb-in-game-summary"></div>
          <div><strong>Time Remaining:</strong><span id="emb-time-remaining" style="float:right"></span></div>
          <ol id="emb-scoreboard"></ol>
          <button id="emb-game-leave-button">Leave Game</button>
        </div>
      </div>
    </div>

    <div id="emb-who-modal-overlay" style="display: none;">
      <div id="emb-who-modal-box">
        <div id="emb-who-modal-header">
          <h3>Players</h3>
          <button id="emb-who-modal-close">✕</button>
        </div>
        <ul id="emb-who-modal-list"></ul>
      </div>
    </div>

    <div id="emb-game-end-overlay" style="display: none;">
      <div id="emb-game-end-box">
        <div id="emb-game-end-header">
          <canvas id="emb-game-end-sprite" width="32" height="32"></canvas>
          <h2 id="emb-game-end-title"></h2>
        </div>
        <div id="emb-game-end-body">
          <div class="chat-main" id="emb-game-end-chat-panel">
            <div id="emb-end-chat-messages" class="chat-messages"></div>
            <div class="chat-input-row">
              <button id="emb-end-who-button">Who</button>
              <input type="text" id="emb-end-chat-input" placeholder="/ Say something" />
              <button id="emb-end-chat-send-button">Chat</button>
            </div>
          </div>
          <div id="emb-game-end-right-rail">
            <h3>Final Scores</h3>
            <ol id="emb-end-scoreboard"></ol>
          </div>
        </div>
        <button id="emb-game-end-leave-button">Leave</button>
      </div>
    </div>

    <div id="emb-connection-status">
      <span id="emb-connection-dot"></span>
      <span id="emb-connection-text"></span>
      <span id="emb-voice-chat-icon" title="Voice chat (Right Ctrl to toggle)"></span>
    </div>


`;

function isLikelyMobile() {
    const hasCoarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const noKeyboardHint = window.matchMedia && window.matchMedia('(hover: none)').matches;
    const narrowViewport = window.innerWidth < 1024;

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

// container: the element to render the game into; mount() owns its
// contents until the returned unmount() is called.
// wsUrl: the game server's WebSocket URL -- ws://localhost:8082 standalone,
// the host's own /embuscade-ws route when embedded (see ./standalone.js).
// Returns unmount(): closes the socket (no reconnect), stops timers, removes
// the window/document listeners mount() added, and empties container.
export function mount(container, { wsUrl }) {
    let playerId = null;
    let maze = null;
    let mazeConfig = null;
    let tanks = [];
    let shots = [];
    let ws = null;
    let isHost = false;
    let playerProfile = null;
    let pingIntervalId = null;
    let reconnectTimeoutId = null;
    let chatMessages = [];
    let disposed = false;

    const identities = new Map();

    const talkingPlayers = new Set();
    let lastLobbyRoster = null;
    let lastWhoModalRoster = null;

    const voiceChat = createVoiceChat({
        onSignal: (targetPlayerId, signal) => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'voice-signal', targetPlayerId, signal }));
            }
        },
        onLog: (...args) => console.log('[voice]', ...args),
        onTalkingChange: (talkerPlayerId, isTalking) => {
            if (isTalking) talkingPlayers.add(talkerPlayerId);
            else talkingPlayers.delete(talkerPlayerId);

            if (screenStack[screenStack.length - 1] === Screen.Lobby) renderLobbyRosterOnly();
            if (whoModalOverlay.style.display !== 'none') renderWhoModalListOnly();
        }
    });

    function updateVoicePeers(roster) {
        voiceChat.setPeers(roster.filter((entry) => !entry.isAI).map((entry) => entry.playerId));
    }

    container.innerHTML = `<div class="embuscade">${MARKUP}</div>`;
    const root = container.firstElementChild;
    const $ = (id) => root.querySelector('#emb-' + id);
    let powerUps = [];

    // window/document listeners outlive the markup, so unmount() has to
    // remove them explicitly -- element listeners go away with innerHTML.
    const globalListeners = [];
    function listen(target, type, handler) {
        target.addEventListener(type, handler);
        globalListeners.push([target, type, handler]);
    }

    function enforceByteLimit(input, maxBytes) {
        listen(input, 'input', () => {
            const truncated = truncateToBytes(input.value, maxBytes);
            if (truncated !== input.value) input.value = truncated;
        });
    }

    function unmount() {
        if (disposed) return;
        disposed = true;
        clearInterval(pingIntervalId);
        clearTimeout(reconnectTimeoutId);
        voiceChat.teardownAll();
        if (ws) ws.close();
        for (const [target, type, handler] of globalListeners) {
            target.removeEventListener(type, handler);
        }
        container.innerHTML = '';
    }

    if (isLikelyMobile()) {
        $('mobile-block').style.display = 'flex';
        $('loading-status').style.display = 'none';
        return unmount;
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
        if (entry.awaitingLeave) {
            li.classList.add('roster-row-pending-leave');
            li.title = 'Still viewing the end-game results';
        }

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

        if (talkingPlayers.has(entry.playerId)) {
            const talkSpan = document.createElement('span');
            talkSpan.textContent = '🔊';
            talkSpan.title = 'Talking';
            li.appendChild(talkSpan);
        }

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

    function makeChatSpriteCanvas(identity) {
        const spriteCanvas = document.createElement('canvas');
        spriteCanvas.width = SPRITE_SIZE;
        spriteCanvas.height = SPRITE_SIZE;
        spriteCanvas.className = 'chat-sprite';
        spriteCanvas.title = identity.name;
        const pctx = spriteCanvas.getContext('2d');
        const rendered = renderSpriteToCanvas(identity.sprite, identity.primaryColor, identity.secondaryColor);
        pctx.drawImage(rendered, 0, 0);
        return spriteCanvas;
    }

    function renderChatInto(container) {
        container.innerHTML = '';
        for (const entry of chatMessages) {
            const row = document.createElement('div');
            row.className = 'chat-message-row';

            if (entry.kind === 'kill') {
                row.classList.add('chat-message-kill');
                row.appendChild(makeChatSpriteCanvas(entry.killer));

                const killerNameSpan = document.createElement('span');
                killerNameSpan.className = 'chat-name';
                killerNameSpan.textContent = entry.killer.name;
                row.appendChild(killerNameSpan);

                const slewSpan = document.createElement('span');
                slewSpan.className = 'chat-text';
                slewSpan.textContent = 'just slew';
                row.appendChild(slewSpan);

                row.appendChild(makeChatSpriteCanvas(entry.victim));

                const victimNameSpan = document.createElement('span');
                victimNameSpan.className = 'chat-name';
                victimNameSpan.textContent = entry.victim.name;
                row.appendChild(victimNameSpan);
            } else if (entry.kind === 'murder-suicide') {
                row.classList.add('chat-message-kill');
                row.appendChild(makeChatSpriteCanvas(entry.a));

                const aNameSpan = document.createElement('span');
                aNameSpan.className = 'chat-name';
                aNameSpan.textContent = entry.a.name;
                row.appendChild(aNameSpan);

                const andSpan = document.createElement('span');
                andSpan.className = 'chat-text';
                andSpan.textContent = 'and';
                row.appendChild(andSpan);

                row.appendChild(makeChatSpriteCanvas(entry.b));

                const bNameSpan = document.createElement('span');
                bNameSpan.className = 'chat-name';
                bNameSpan.textContent = entry.b.name;
                row.appendChild(bNameSpan);

                const suicideSpan = document.createElement('span');
                suicideSpan.className = 'chat-text';
                suicideSpan.textContent = 'just murder-suicided';
                row.appendChild(suicideSpan);
            } else if (entry.kind === 'game-start') {
                row.classList.add('chat-message-game-start');

                const bannerSpan = document.createElement('span');
                bannerSpan.textContent = '******** GAME ON ********';
                row.appendChild(bannerSpan);
            } else {
                row.appendChild(makeChatSpriteCanvas(entry));

                const nameSpan = document.createElement('span');
                nameSpan.className = 'chat-name';
                nameSpan.textContent = entry.name + ':';
                row.appendChild(nameSpan);

                const textSpan = document.createElement('span');
                textSpan.className = 'chat-text';
                textSpan.textContent = entry.text;
                row.appendChild(textSpan);
            }

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
        lastWhoModalRoster = players;
        renderWhoModalListOnly();
        whoModalOverlay.style.display = 'flex';
    }

    function renderWhoModalListOnly() {
        if (!lastWhoModalRoster) return;
        whoModalList.innerHTML = '';
        for (const entry of lastWhoModalRoster) {
            if (entry.isAI) continue;
            whoModalList.appendChild(makeRosterRow(entry));
        }
    }

    function closeWhoModal() {
        whoModalOverlay.style.display = 'none';
    }

    listen(document, 'keydown', (e) => {
        if (e.key === 'Escape') {
            if(whoModalOverlay.style.display !== 'none') {
                closeWhoModal();
            }
            else if (builder.isVisible()) {
                popScreen();
            }
        }
        else if (e.code === 'ControlRight') {
            if (isTextField(e.target)) return;
            toggleVoiceChat();
        }
        else if (e.key === '/') {
            if (isTextField(e.target)) return;
            const screen = screenStack[screenStack.length - 1];
            if (screen === Screen.Lobby) {
                e.preventDefault();
                lobbyChatInput.focus();
            } else if (screen === Screen.EndGame) {
                e.preventDefault();
                endChatInput.focus();
            } else if (screen === Screen.Browser) {
                e.preventDefault();
                browserChatInput.focus();
            }
        }
    });

    // --- Éléments des différents écrans ---

    const whoModalOverlay = $('who-modal-overlay');
    const whoModalClose = $('who-modal-close');
    const whoModalList = $('who-modal-list');

    const loadingEl = $('loading-status');
    const dialogEl = $('join-dialog');
    const browserScreenEl = $('browser-screen');
    const lobbyScreenEl = $('lobby-screen');
    const gameViewEl = $('game-view');

    const connectionDotEl = $('connection-dot');
    const connectionTextEl = $('connection-text');
    const voiceChatIconEl = $('voice-chat-icon');

    const nameInput = $('player-name');
    enforceByteLimit(nameInput, PLAYER_NAME_MAX_BYTES);
    const primaryColorInput = $('primary-color');
    const secondaryColorInput = $('secondary-color');
    const presetListEl = $('preset-list');
    const joinButton = $('join-button');
    const joinCancelButton = $('join-cancel-button');

    const gamesListEl = $('games-list');
    const browserEmptyMessageEl = $('browser-empty-message');
    const browserCreateButton = $('browser-create-button');
    const browserLeaveButton = $('browser-leave-button');
    const browserChatMessagesEl = $('browser-chat-messages');
    const browserChatInput = $('browser-chat-input');
    enforceByteLimit(browserChatInput, CHAT_MAX_BYTES);
    const browserChatSendButton = $('browser-chat-send-button');
    const browserWhoButton = $('browser-who-button');

    const lobbyGameNameEl = $('lobby-game-name');
    const lobbySizeEl = $('lobby-size');
    const lobbyRosterEl = $('lobby-roster');
    const editGameButton = $('edit-game-button');
    const startGameButton = $('start-game-button');
    const lobbyLeaveButton = $('lobby-leave-button');
    const lobbyWaitingMessageEl = $('lobby-waiting-message');
    const lobbyChatMessagesEl = $('lobby-chat-messages');
    const lobbyChatInput = $('lobby-chat-input');
    enforceByteLimit(lobbyChatInput, CHAT_MAX_BYTES);
    const lobbyChatSendButton = $('lobby-chat-send-button');

    const gameLeaveButton = $('game-leave-button');
    const gameChatMessagesEl = $('game-chat-messages');
    const gameChatInput = $('game-chat-input');
    enforceByteLimit(gameChatInput, CHAT_MAX_BYTES);
    const gameChatSendButton = $('game-chat-send-button');

    const gameChatPanelEl = $('game-chat-panel');
    const gameChatHintEl = $('game-chat-hint');
    const gameChatInputRow = $('game-chat-input-row');

    const gameEndOverlay = $('game-end-overlay');
    const gameEndSprite = $('game-end-sprite');
    const gameEndTitle = $('game-end-title');
    const endChatMessagesEl = $('end-chat-messages');
    const endChatInput = $('end-chat-input');
    enforceByteLimit(endChatInput, CHAT_MAX_BYTES);
    const endChatSendButton = $('end-chat-send-button');
    const endWhoButton = $('end-who-button');
    const gameEndLeaveButton = $('game-end-leave-button');
    const endScoreboardEl = $('end-scoreboard');

    const scoreboardEl = $('scoreboard');
    const inGameSummaryEl = $('in-game-summary')
    const timeRemainingEl = $('time-remaining')

    const Screen = Object.freeze({
        Splash: 0,
        Join: 1,
        Browser: 2,
        Builder: 3,
        Lobby: 4,
        Game: 5,
        EndGame: 6,
    });

    const screenStack = [];

    function showScreen(screen,...parameters) {
        if(screenStack.length && screenStack.includes(screen)) {
            let index = screenStack.indexOf(screen);
            while(screenStack.length - 1 > index) {
                screenStack.pop();
            }
        }
        else {
            screenStack.push(screen);
        }
        doScreenDisplay(screen,...parameters);
    }

    function popScreen(count) {
        if(count === undefined) count = 1;
        while (count && screenStack.length) {
            screenStack.pop();
            count--;
        }
        if(!screenStack.length) screenStack.push(Screen.Splash);
        doScreenDisplay(screenStack[screenStack.length - 1]);
    }

    function replaceScreen(screen,...parameters) {
        if(!screenStack.length) throw('screenStack unexpectedly empty in replaceScreen!');
        screenStack.pop();
        showScreen(screen,...parameters);
    }

    function doScreenDisplay(screen,...parameters) {
        hideAllScreens();
        switch(screen) {
        case Screen.Splash: showSplash(...parameters); break;
        case Screen.Join: showJoinDialog(...parameters); break;
        case Screen.Browser: showBrowserScreen(...parameters); break;
        case Screen.Builder: builderCreateMode = parameters[0]; builder.show(...parameters); break;
        case Screen.Lobby: showLobbyScreen(...parameters); break;
        case Screen.Game: showInGameScreen(...parameters); break;
        case Screen.EndGame: showGameEndOverlay(...parameters); break;
        }
        renderVoiceChatIcon();
    }

    let gameId = undefined;

    const builderEventSink = {
        createGame: function(createGame,parameters) {
            if(createGame) parameters.type = 'create-game';
            else {
                // Edit Game is only ever shown to (and clickable by) the
                // current player when they're the host, so "my own
                // playerId" IS the host id here -- lobby-state never
                // actually sends a top-level hostPlayerId to track instead.
                parameters.type = 'edit-game';
                parameters.hostPlayerId = playerId;
                parameters.gameId = gameId;
            }
            ws.send(JSON.stringify(parameters));
        },
        cancelGame: function() {
            popScreen();
        }
    }

    const builder = new Builder($,sessionToken,builderEventSink);

    whoModalClose.addEventListener('click', closeWhoModal);
    whoModalOverlay.addEventListener('click', (e) => {
        if (e.target === whoModalOverlay) closeWhoModal(); // clic sur le fond, pas la boîte
    });

    function hideAllScreens() {
        loadingEl.style.display = 'none';
        dialogEl.style.display = 'none';
        browserScreenEl.style.display = 'none';
        lobbyScreenEl.style.display = 'none';
        gameViewEl.style.display = 'none';
        gameEndOverlay.style.display = 'none';
        hideSplashScreen();
        builder.hide();
    }

    function showJoinDialog() {
        dialogEl.style.display = 'block';
    }

    function showSplash() {
        showSplashScreen(root, {
            onJoin: () => showScreen(Screen.Join),
            onHelp: () => showHelpModal(root)
        });
    }

    function showBrowserScreen() {
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

    function showLobbyScreen() {
        lobbyScreenEl.style.display = 'flex';
    }

    function showGameEndOverlay() {
        gameEndOverlay.style.display = 'flex';
    }

    function showInGameScreen() {
        gameViewEl.style.display = 'flex';
    }

    function setConnectionStatus(connected) {
        connectionDotEl.classList.toggle('disconnected', !connected);
        connectionTextEl.textContent = connected ? '' : 'client disconnected';
    }

    // --- Discussion vocale (bascule, persistance, et le mesh WebRTC lui-même) ---

    const VOICE_CHAT_SCREENS = new Set([Screen.Lobby, Screen.Game, Screen.EndGame]);
    let voiceChatEnabled = localStorage.getItem(VOICE_CHAT_STORAGE_KEY) !== 'false';
    let builderCreateMode = true;

    function isVoiceChatAvailable() {
        const screen = screenStack[screenStack.length - 1];
        if (screen === Screen.Builder) return !builderCreateMode;
        return VOICE_CHAT_SCREENS.has(screen);
    }

    function renderVoiceChatIcon() {
        const active = isVoiceChatAvailable() && voiceChatEnabled;
        voiceChatIconEl.style.display = 'inline';
        voiceChatIconEl.textContent = active ? '🔊' : '🔇';
        voiceChat.setLocalEnabled(active);
    }

    function setVoiceChatEnabled(enabled) {
        voiceChatEnabled = enabled;
        localStorage.setItem(VOICE_CHAT_STORAGE_KEY, String(enabled));
        renderVoiceChatIcon();
    }

    function toggleVoiceChat() {
        if (!isVoiceChatAvailable()) return;
        setVoiceChatEnabled(!voiceChatEnabled);
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
        resumeAudioContext();
        const name = nameInput.value.trim() || 'Player';
        const primaryColor = primaryColorInput.value;
        const secondaryColor = secondaryColorInput.value;
        const sprite = PRESET_SPRITES[selectedPreset];

        saveProfile({ name, primaryColor, secondaryColor, preset: selectedPreset });
        playerProfile = { name, primaryColor, secondaryColor, sprite };

        replaceScreen(Screen.Browser);
    });
    joinCancelButton.addEventListener('click', () => {
        popScreen();
    });

    function updateTimeRemaining(msg) {
        if(msg.timeRemaining !== undefined) {
            var ms = msg.timeRemaining;
            if(ms < 0) ms = 0;
            var s = Math.floor(ms / 1000);
            ms -= s * 1000;
            ms = Math.floor(ms);
            var m = Math.floor(s / 60);
            s -= m * 60;
            timeRemainingEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
        }
        else {
            timeRemainingEl.textContent = '♾️';
        }
    }

    function updateInGameSummary(msg) {
        const game = msg.game;
        const maze = msg.maze;
        inGameSummaryEl.replaceChildren();
        const isPrivate = game.isPrivate ? ' 🔒' : '';
        const titleElement = document.createElement('h3');
        titleElement.textContent = `${game.name}${isPrivate}`;
        inGameSummaryEl.append(titleElement);
        const sizeElement = document.createElement('span');
        sizeElement.textContent = `${maze.largeur} x ${maze.longeur} x ${maze.hauteur}`;
        inGameSummaryEl.append(sizeElement);
        updateTimeRemaining(game);
    }

    // --- Connexion WebSocket ---
    let endGamePlayersList = [];

    function connectSocket() {
        ws = new WebSocket(wsUrl);

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
            if (disposed) return;
            const msg = JSON.parse(event.data);
            console.log(`got a message ${msg.type}`);

            if (msg.type === 'resumed') {
                playerId = msg.playerId;
                voiceChat.setSelfId(playerId);
                updateVoicePeers(msg.roster);

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

                    showScreen(Screen.Game);
                    updateInGameSummary(msg);
                    setupInputHandling();
                    hideGameChatInput();
                    drawScene();
                } else {
                    showScreen(Screen.Lobby);
                    renderLobby(msg);
                }
            } else if (msg.type === 'resume-failed') {
                localStorage.removeItem(SESSION_TOKEN_KEY);
                playerId = null;
                voiceChat.setSelfId(null);
                voiceChat.teardownAll();
                tanks = [];
                shots = [];
                maze = null;
                identities.clear();
                clearChat();
                // a resume can land straight in Lobby/Game with no Splash below it, so patching via showScreen() isn't enough -- reset outright.
                screenStack.length = 0;
                showScreen(Screen.Splash);
            } else if (msg.type === 'games-list') {
                renderGamesList(msg.games);
            } else if (msg.type === 'browser-players') {
                browserPlayersList = msg.players;
            } else if (msg.type === 'chat-message') {
                appendChatMessage(msg);
            } else if (msg.type === 'join-rejected') {
                if (msg.reason === 'bad-password') {
                    alert('Incorrect password.');
                } else if (msg.reason === 'started') {
                    alert('Game is underway; you can only join games that are not under way.');
                } else {
                    alert('That game is full.');
                }
            } else if (msg.type === 'lobby-joined') {
                playerId = msg.playerId;
                voiceChat.setSelfId(playerId);
                // each game's playerIds start at 1 again, so a stale cached identity could otherwise leak onto whoever holds that id in this new game.
                identities.clear();
                registerIdentity({ playerId, ...playerProfile });
                clearChat();

                replaceScreen(Screen.Lobby);
            } else if (msg.type === 'lobby-state') {
                updateVoicePeers(msg.roster);
                renderLobby(msg);
            } else if (msg.type === 'roster-update') {
                updateVoicePeers(msg.roster);
            } else if (msg.type === 'voice-signal') {
                voiceChat.handleSignal(msg.fromPlayerId, msg.signal);
            } else if (msg.type === 'left-game') {
                playerId = null;
                voiceChat.setSelfId(null);
                voiceChat.teardownAll();
                tanks = [];
                shots = [];
                maze = null;
                identities.clear();
                clearChat();
                // Not popScreen(): from an active game that'd reveal a stale Lobby for a game now gone or continuing without us.
                showScreen(Screen.Browser);
            } else if (msg.type === 'reverted-to-lobby') {
                tanks = [];
                shots = [];
                maze = null;
                popScreen();
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
                updateVoicePeers(msg.roster);
                playSound('readyFight');

                showScreen(Screen.Game);
                updateInGameSummary(msg);
                setupInputHandling();
                renderAllChatPanels();
                hideGameChatInput();
                drawScene();
            } else if (msg.type === 'state') {
                tanks = msg.tanks;
                shots = msg.shots;
                powerUps = msg.powerUps;

                const myTank = findMyTank();
                if (myTank && msg.sfx) {
                    for (const event of msg.sfx) {
                        playPositional(event.type, event.x, event.y, event.z, myTank.x, myTank.y, myTank.z);
                    }
                }

                updateTimeRemaining(msg);
                drawScene();
            } else if (msg.type === 'game-ended') {
                endGamePlayersList = msg.scores;
                const winnerCanvas = renderSpriteToCanvas(msg.winner.sprite, msg.winner.primaryColor, msg.winner.secondaryColor);
                gameEndSprite.getContext('2d').drawImage(winnerCanvas, 0, 0);
                gameEndTitle.textContent = `${msg.winner.name} Wins!`;
                renderEndScoreboard();
                replaceScreen(Screen.EndGame);
                renderAllChatPanels();
            } else if (msg.type === 'left-game') {
                playerId = null;
                tanks = [];
                shots = [];
                maze = null;
                clearChat();
                popScreen(2);
            }

        });

        ws.addEventListener('close', () => {
            clearInterval(pingIntervalId);
            if (disposed) return;
            setConnectionStatus(false);
            console.log('Disconnected from Bolo server');
            reconnectTimeoutId = setTimeout(connectSocket, RECONNECT_RETRY_MS);
        });

        ws.addEventListener('error', () => {
            setConnectionStatus(false);
        });
    }

    initAudio();
    loadFonts();
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
                + ` -- ${game.preview}`
                + (game.started ? ' -- underway' : '');
            if (game.hasPassword) {
                const lockTag = document.createElement('span');
                lockTag.textContent = ' 🔒';
                info.appendChild(lockTag);
            }

            const joinBtn = document.createElement('button');
            joinBtn.textContent = 'Join';
            joinBtn.disabled = game.started || game.playerCount >= game.humanSlots;
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
        showScreen(Screen.Builder,true,playerProfile);
    });

    browserLeaveButton.addEventListener('click', () => {
        popScreen();
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
        ws.send(JSON.stringify({ type: 'revert-to-lobby' }));
    });

    // --- Écran: lobby (salle d'attente avant démarrage) ---

    function renderLobby(msg) {
        // TODO il faut avoir le concept "currentGame"
        gameId = msg.gameId;
        lobbyGameNameEl.textContent = msg.name;
        if (msg.hasPassword) {
            lobbyGameNameEl.textContent += ' 🔒';
        }
        lobbySizeEl.textContent = `${msg.width} x ${msg.length} x ${msg.height} -- ${msg.humanSlots} human, ${msg.aiSlots} AI -- ${msg.preview}`;

        lastLobbyRoster = msg.roster;
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

        const anyoneStillLeaving = msg.roster.some((entry) => entry.awaitingLeave);

        startGameButton.style.display = isHost ? 'inline-block' : 'none';
        startGameButton.disabled = anyoneStillLeaving;
        startGameButton.title = anyoneStillLeaving
            ? 'Waiting for all players to leave the end-game screen'
            : '';
        editGameButton.style.display = isHost ? 'inline-block' : 'none';
        lobbyWaitingMessageEl.style.display = isHost ? 'none' : 'block';

        renderAllChatPanels();
    }

    function renderLobbyRosterOnly() {
        if (!lastLobbyRoster) return;
        lobbyRosterEl.innerHTML = '';
        for (const entry of lastLobbyRoster) {
            lobbyRosterEl.appendChild(makeRosterRow(entry));
        }
    }

    startGameButton.addEventListener('click', () => {
        ws.send(JSON.stringify({ type: 'start-game' }));
    });

    editGameButton.addEventListener('click', () => {
        showScreen(Screen.Builder,false,playerProfile);
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
        const humanCount = tanks.filter((t) => !identities.get(t.playerId)?.isAI).length;
        const message = humanCount <= 1
            ? 'Are you sure you want to abandon the game?'
            : "You won't be able to rejoin until the current game is complete.";
        if (!confirm(message)) return;
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

        listen(window, 'keydown', (e) => {
            // ne pas piloter le char en tapant un message -- any text field,
            // not just ours, since a host page may have its own inputs too.
            if (isTextField(e.target)) return;
            // Only while the game is on screen: keys belong to the host page
            // (or our own other screens) the rest of the time.
            if (gameViewEl.style.display === 'none') return;

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
            if (!field) return;
            e.preventDefault(); // arrow keys would otherwise scroll a host page's scroll container
            if (input[field]) return;
            input[field] = true;
            sendInput();
        });

        listen(window, 'keyup', (e) => {
            const field = KEY_MAP[e.key];
            if (!field) return;
            input[field] = false;
            sendInput();
        });

        listen(document, 'visibilitychange', () => {
            if (!document.hidden) {
                resumeAudioContext();
            }

            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'visibility', hidden: document.hidden }));
            }
        });
    }

    // --- Rendu du jeu ---

    const canvas = $('maze-canvas');
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
                ctx.font = `20px "${STENCIL_FONT_FAMILY}", sans-serif`;
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
        const maxHealth = tank.maxHealth ?? 100;

        const barLeft = TANK_RADIUS + HEALTH_BAR_GAP;
        const barTop = -HEALTH_BAR_HEIGHT / 2;

        ctx.save();
        ctx.rotate(Math.PI / 2);

        // chaque colonne représente 100 points de vie -- le nombre de colonnes
        // dépend de maxHealth (1 colonne à 100, 2 colonnes à 200), pas d'un
        // seuil fixe
        const columnCount = Math.ceil(maxHealth / 100);
        for (let col = 0; col < columnCount; col++) {
            const columnMin = col * 100;
            const columnMax = Math.min(maxHealth, columnMin + 100);
            const columnCapacity = columnMax - columnMin;
            const healthInColumn = Math.max(0, Math.min(health, columnMax) - columnMin);
            const fraction = columnCapacity > 0 ? healthInColumn / columnCapacity : 0;

            const x = barLeft + col * (HEALTH_BAR_WIDTH + HEALTH_BAR_SPACING);
            drawHealthBarColumn(x, barTop, fraction);
        }

        ctx.restore();
    }

    const POWERUP_ICONS = {
        health: '⚕️',
        healthBoost: '💗'
    };

    // Drawn procedurally (not a sprite/emoji) so the same shape can show
    // remaining absorption capacity: fraction (0..1) scales both horn
    // length and opacity. Draws along local +X "forward" in whatever
    // transform the caller has already set up (translate/rotate first).
    function drawRamHornsIcon(scale, fraction) {
        ctx.save();
        ctx.lineCap = 'round';
        ctx.strokeStyle = `rgba(224, 202, 168, ${0.35 + 0.65 * fraction})`;
        ctx.lineWidth = Math.max(1.5, scale * 0.08);

        // Polar sweep, not a single quadratic bow: angle runs from
        // forward-and-out past the side and on toward the rear as the
        // radius grows, so the tip actually curls back over -- a ram's
        // curl, not a straight antelope-horn sweep.
        const steps = 16;
        const startAngle = -Math.PI * 0.1;
        const endAngle = Math.PI * 0.85;
        const baseOffsetX = scale * 0.1;
        const minRadius = scale * 0.08;
        const maxRadius = scale * 0.5;

        for (const side of [-1, 1]) {
            ctx.beginPath();
            for (let i = 0; i <= steps; i++) {
                const t = (i / steps) * fraction;
                const angle = startAngle + t * (endAngle - startAngle);
                const radius = minRadius + (maxRadius - minRadius) * t;
                const x = baseOffsetX + radius * Math.cos(angle);
                const y = side * radius * Math.sin(angle);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
        ctx.restore();
    }

    function drawPowerUps(camX, camY, localZ) {
        ctx.font = 'bold 24px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (const p of powerUps) {
            if (p.z !== localZ) continue;
            const centerX = p.cellX * mazeConfig.cellSize + mazeConfig.cellSize / 2;
            const centerY = p.cellY * mazeConfig.cellSize + mazeConfig.cellSize / 2;
            const screenX = centerX - camX + VIEWPORT_WIDTH / 2;
            const screenY = centerY - camY + VIEWPORT_HEIGHT / 2;

            if (p.type === 'ramHorns') {
                ctx.save();
                ctx.translate(screenX, screenY);
                ctx.rotate(-Math.PI / 2);
                drawRamHornsIcon(SPRITE_SIZE, 1);
                ctx.restore();
            } else {
                ctx.fillText(POWERUP_ICONS[p.type] ?? '?', screenX, screenY);
            }
        }
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

        if (tank.ramHorns > 0) {
            drawRamHornsIcon(SPRITE_SIZE, tank.ramHorns / RAM_HORNS_CAPACITY);
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
            if (talkingPlayers.has(tank.playerId)) {
                const talkSpan = document.createElement('span');
                talkSpan.textContent = '🔊';
                talkSpan.title = 'Talking';
                li.appendChild(talkSpan);
            }
            li.appendChild(scoreSpan);
            scoreboardEl.appendChild(li);
        }
    }

    function renderEndScoreboard() {
        const sorted = [...endGamePlayersList].sort((a, b) => b.score - a.score);
        endScoreboardEl.innerHTML = '';
        for (const entry of sorted) {
            const li = document.createElement('li');

            const spriteCanvas = document.createElement('canvas');
            spriteCanvas.width = SPRITE_SIZE;
            spriteCanvas.height = SPRITE_SIZE;
            spriteCanvas.className = 'roster-sprite';
            const rendered = renderSpriteToCanvas(entry.sprite, entry.primaryColor, entry.secondaryColor);
            spriteCanvas.getContext('2d').drawImage(rendered, 0, 0);

            const nameSpan = document.createElement('span');
            nameSpan.textContent = entry.name;

            const scoreSpan = document.createElement('span');
            scoreSpan.className = 'score-value';
            scoreSpan.textContent = entry.score;

            li.appendChild(spriteCanvas);
            li.appendChild(nameSpan);
            li.appendChild(scoreSpan);
            endScoreboardEl.appendChild(li);
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
        drawPowerUps(camX, camY, localZ);

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

    return unmount;
}

function isTextField(el) {
    return el instanceof HTMLElement
        && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}
