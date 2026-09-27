import { WebSocketServer } from 'ws';
import Wilson from '@bolo/shared/Wilson.js';
import { Direction } from '@bolo/shared/Direction.js';
import { getVerticalIcons } from '@bolo/shared/MazeGeometry.js';
import { CHAT_MAX_BYTES, GAME_NAME_MAX_BYTES, PASSWORD_MAX_BYTES, PLAYER_NAME_MAX_BYTES, byteLength, truncateToBytes } from '@bolo/shared/Limits.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assignAIIdentities, updateAITank } from './ai.js';

const TANK_RADIUS = 14;
const MAX_SPEED = 120;
const ACCELERATION = 200;
const BRAKE_DECEL = 300;
const TURN_RATE = Math.PI;
const TICK_HZ = 30;
const TICK_MS = 1000 / TICK_HZ;
const PORT = 8082;
const ICON_HIT_RADIUS = 20;
const VERTICAL_TRANSITION_MS = 750;
const VERTICAL_COOLDOWN_MS = 1500;
const SHOT_SIZE = 4;
const CELL_SIZE = 256;
const SHOT_SPEED = MAX_SPEED * 2;
const FIRE_COOLDOWN_MS = 500;
const AFK_TIMEOUT_MS = 15000;
const RAM_DAMAGE_SCALE = 100 / (2 * MAX_SPEED);
const MAX_TOTAL_PLAYERS = 16;
const RECONNECT_GRACE_MS = 60000;
const CHAT_RATE_LIMIT_MS = 1000;
const RESPAWN_DELAY_MS = 3500;
const DEFAULT_SCORE_TARGET = 10;
const POWERUP_MAX_COUNT_MATCHES_PLAYERS = true; // aussi de puissants qu'il y a de joueurs, comme spécifié
const POWERUP_SPAWN_INTERVAL_MS = 7500;
const POWERUP_RESPAWN_DELAY_MS = 5000;
const AI_TAUNT_CHANCE = 0.2;

function loadAiTaunts() {
    try {
        const path = fileURLToPath(new URL('../../../AI-taunts.json', import.meta.url));
        const taunts = JSON.parse(readFileSync(path, 'utf8'));
        return Array.isArray(taunts) ? taunts.filter((t) => typeof t === 'string') : [];
    } catch (err) {
        console.warn('could not load AI-taunts.json:', err.message);
        return [];
    }
}

const AI_TAUNTS = loadAiTaunts();

let nextPowerUpId = 1;

const FIRE_KEY_OFFSETS = {
    fireForward: 0,
    fireBack: Math.PI,
    fireLeft: -Math.PI / 2,
    fireRight: Math.PI / 2
};

const games = new Map();
const browserSockets = new Set();
const browserIdentities = new Map(); // ws -> {name, primaryColor, secondaryColor, sprite}
const browserLastChatTime = new Map(); // ws -> timestamp
const sessionTokens = new Map();
let nextGameId = 1;

function formatGamePreview(game) {
    const timePart = game.timeLimitMs
        ? `${Math.round(game.timeLimitMs / 60000)} minutes`
        : 'unlimited time';
    return `Play to: ${game.scoreTarget}, ${timePart}`;
}

function gameSummary(game) {
    return {
        id: game.id,
        name: game.name,
        width: game.width,
        length: game.length,
        height: game.height,
        humanSlots: game.humanSlots,
        aiSlots: game.aiSlots,
        playerCount: game.tanks.size,
        hasPassword: !!game.password,
        started: game.started,
        preview: formatGamePreview(game)
    };
}

function broadcastGamesList() {
    const list = Array.from(games.values())
        .map(gameSummary);
    const message = JSON.stringify({ type: 'games-list', games: list });

    for (const ws of browserSockets) {
        if (ws.readyState === ws.OPEN) ws.send(message);
    }
}

function broadcastBrowserPlayers() {
    const players = Array.from(browserIdentities.values());
    const message = JSON.stringify({ type: 'browser-players', players });

    for (const ws of browserSockets) {
        if (ws.readyState === ws.OPEN) ws.send(message);
    }
}

function buildRoster(game) {
    return Array.from(game.tanks.values()).map(t => ({
        playerId: t.playerId,
        name: t.name,
        primaryColor: t.primaryColor,
        secondaryColor: t.secondaryColor,
        sprite: t.sprite,
        isHost: t.playerId === game.hostPlayerId,
        isAI: !!t.isAI,
        afk: isAfk(t,game.started),
        awaitingLeave: !!t.awaitingLeave
    }));
}

function hashPassword(password) {
    return createHash('sha256').update(password).digest('hex');
}

function createGame(config) {
    const gameId = nextGameId++;
    const cellSize = CELL_SIZE;

    const wilson = new Wilson(config.width, config.length, config.height);

    const game = {
        id: gameId,
        name: config.name,
        password: config.password || null,
        width: config.width,
        length: config.length,
        height: config.height,
        cellSize,
        maze: wilson._maze,
        tanks: new Map(),
        shots: new Map(),
        started: false,
        hostPlayerId: null,
        humanSlots: config.humanCount,
        aiSlots: config.aiCount,
        nextLocalPlayerId: 1,
        nextLocalShotId: 1,
        shotMaxDistance: cellSize * 2,
        password: config.password ? hashPassword(config.password) : null,
        scoreTarget: config.scoreTarget,
        timeLimitMs: config.timeLimitMs,
        startedAt: null,
        ended: false,
        powerUps: [],
        lastPowerUpSpawnAttempt: 0,
        sfxEvents: []
    };

    games.set(gameId, game);
    return game;
}

function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const closestX = x1 + t * dx;
    const closestY = y1 + t * dy;
    const ddx = px - closestX;
    const ddy = py - closestY;
    return Math.sqrt(ddx * ddx + ddy * ddy);
}

function collidesWithWall(game, x, y, z) {
    const cellX = Math.max(0, Math.min(game.width - 1, Math.floor(x / game.cellSize)));
    const cellY = Math.max(0, Math.min(game.length - 1, Math.floor(y / game.cellSize)));
    const cell = game.maze[z][cellY][cellX];

    const left = cellX * game.cellSize;
    const top = cellY * game.cellSize;
    const right = left + game.cellSize;
    const bottom = top + game.cellSize;

    if (!(cell & Direction.North) && distToSegment(x, y, left, top, right, top) < TANK_RADIUS) return true;
    if (!(cell & Direction.South) && distToSegment(x, y, left, bottom, right, bottom) < TANK_RADIUS) return true;
    if (!(cell & Direction.West) && distToSegment(x, y, left, top, left, bottom) < TANK_RADIUS) return true;
    if (!(cell & Direction.East) && distToSegment(x, y, right, top, right, bottom) < TANK_RADIUS) return true;

    return false;
}

export function isAfk(tank, requireIdleCheck = true) {
    // AFK is a human concept; an AI's lastActivityTime can go stale without meaning anything, and AFK tanks are immune to damage below.
    if (tank.isAI) return false;
    if (tank.disconnected || tank.tabHidden) return true;
    if (!requireIdleCheck) return false;
    return Date.now() - tank.lastActivityTime > AFK_TIMEOUT_MS;
}

function emitSfx(game, type, x, y, z) {
    game.sfxEvents.push({ type, x, y, z });
}

function totalPlayerCount(game) {
    return game.tanks.size;
}

function totalCellCount(game) {
    return (game.width * game.length * game.height);
}

function getTankOccupiedCells(game) {
    return Array.from(game.tanks.values())
        .filter(t => !t.dead)
        .map(t => [t.z, Math.floor(t.y / game.cellSize), Math.floor(t.x / game.cellSize)]);
}

function getPowerUpCellsOccupied(game) {
    return game.powerUps.map(p => [p.z, p.cellY, p.cellX]);
}

function trySpawnPowerUp(game) {
/*    const maxCount = totalPlayerCount(game); */
/*    const maxCount = (game.width * game.length * game.height) / 4; */
    const maxCount = Math.min(Math.floor(totalCellCount(game) / 4), totalPlayerCount(game) * 3)
    if (game.powerUps.length >= maxCount) return;

    const occupied = [...getTankOccupiedCells(game), ...getPowerUpCellsOccupied(game)];
    const cell = findFarthestCell(game, occupied);
    if (!cell) return; // carte trop pleine, on retentera au prochain cycle

    const [z, cellY, cellX] = cell;
    const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];

    game.powerUps.push({
        id: nextPowerUpId++,
        type,
        z, cellY, cellX
    });
}

// v1: health, healthBoost, ramHorns -- les autres types viendront s'ajouter
// à cette liste au fur et à mesure de leur implémentation
const POWERUP_TYPES = ['health', 'healthBoost', 'ramHorns'];
const RAM_HORNS_CAPACITY = 75;
const RAM_HORNS_DAMAGE_MULTIPLIER = 1.5;

function applyPowerUpEffect(tank, type) {
    if (type === 'health') {
        tank.health = Math.min(tank.maxHealth, tank.health + 50);
    } else if (type === 'healthBoost') {
        tank.maxHealth = Math.min(200, tank.maxHealth + 100);
        tank.health = Math.min(tank.maxHealth, tank.health + 100);
    } else if (type === 'ramHorns') {
        // Capacity tracked and rendered starting now; nothing consumes it
        // yet -- collision damage doesn't check it until that pass lands.
        tank.ramHorns = RAM_HORNS_CAPACITY;
    }
}

const POWERUP_HIT_RADIUS = TANK_RADIUS + 20;

function checkPowerUpPickups(game) {
    for (const tank of game.tanks.values()) {
        if (tank.dead) continue;

        const hitIndex = game.powerUps.findIndex(p => {
            if (p.z !== tank.z) return false;
            const centerX = p.cellX * game.cellSize + game.cellSize / 2;
            const centerY = p.cellY * game.cellSize + game.cellSize / 2;
            const dx = tank.x - centerX;
            const dy = tank.y - centerY;
            return Math.sqrt(dx * dx + dy * dy) < POWERUP_HIT_RADIUS;
        });
        if (hitIndex === -1) continue;

        const powerUp = game.powerUps[hitIndex];
        applyPowerUpEffect(tank, powerUp.type);
        emitSfx(game, 'gobblePowerUp', tank.x, tank.y, tank.z);
        game.powerUps.splice(hitIndex, 1);
    }
}

function checkVerticalTransition(game, tank) {
    if (tank.transitioning) return;

    const cellX = Math.floor(tank.x / game.cellSize);
    const cellY = Math.floor(tank.y / game.cellSize);
    if (cellX < 0 || cellX >= game.width || cellY < 0 || cellY >= game.length) return;

    const cell = game.maze[tank.z][cellY][cellX];
    const icons = getVerticalIcons(game.cellSize, cellX, cellY, cell, Direction);

    for (const icon of icons) {
        if (tank.verticalCooldown
            && tank.verticalCooldown.direction === icon.dir
            && tank.verticalCooldown.cellX === cellX
            && tank.verticalCooldown.cellY === cellY
            && Date.now() < tank.verticalCooldown.until) {
            continue;
        }

        const dx = tank.x - icon.x;
        const dy = tank.y - icon.y;
        if (Math.sqrt(dx * dx + dy * dy) < ICON_HIT_RADIUS) {
            tank.transitioning = true;
            tank.transitionFromZ = tank.z;
            tank.transitionToZ = icon.dir === 'up' ? tank.z - 1 : tank.z + 1;
            tank.transitionStartTime = Date.now();
            tank.transitionArrivalDir = icon.dir === 'up' ? 'down' : 'up';
            return;
        }
    }
}

// Collision-style damage (wall or tank ram) is absorbed by an equipped
// ram's horns capacity first; only the remainder, if any, touches health.
// Shot damage is unaffected -- horns are specifically a ramming shield.
function applyCollisionDamage(tank, amount) {
    if (tank.ramHorns > 0) {
        const absorbed = Math.min(tank.ramHorns, amount);
        tank.ramHorns -= absorbed;
        amount -= absorbed;
    }
    if (amount > 0) tank.health = Math.max(0, tank.health - amount);
}

function updateTank(game, tank, dt) {
    const { input } = tank;
    if (input.turnLeft || input.turnRight || input.throttleUp || input.throttleDown) {
        tank.lastActivityTime = Date.now();
    }

    if (tank.transitioning) {
        const elapsed = Date.now() - tank.transitionStartTime;
        if (elapsed >= VERTICAL_TRANSITION_MS) {
            tank.z = tank.transitionToZ;
            tank.transitioning = false;
            tank.verticalCooldown = {
                direction: tank.transitionArrivalDir,
                cellX: Math.floor(tank.x / game.cellSize),
                cellY: Math.floor(tank.y / game.cellSize),
                until: Date.now() + VERTICAL_COOLDOWN_MS
            };
            tank.transitionFromZ = null;
            tank.transitionToZ = null;
            tank.transitionStartTime = null;
            tank.transitionArrivalDir = null;
        }
        return;
    }

    if (input.turnLeft) tank.heading -= TURN_RATE * dt;
    if (input.turnRight) tank.heading += TURN_RATE * dt;
    tank.heading = ((tank.heading % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

    if (input.throttleUp) tank.speed = Math.min(MAX_SPEED, tank.speed + ACCELERATION * dt);
    if (input.throttleDown) tank.speed = Math.max(0, tank.speed - BRAKE_DECEL * dt);

    const proposedX = tank.x + Math.cos(tank.heading) * tank.speed * dt;
    const proposedY = tank.y + Math.sin(tank.heading) * tank.speed * dt;

    tank.prevX = tank.x;
    tank.prevY = tank.y;

    if (collidesWithWall(game, proposedX, proposedY, tank.z)) {
        applyCollisionDamage(tank, tank.speed * 0.3);
        emitSfx(game, 'wall', tank.x, tank.y, tank.z);
        tank.speed = 0;
    } else {
        tank.x = proposedX;
        tank.y = proposedY;
    }

    checkVerticalTransition(game, tank);
}

function activeZSet(tank) {
    return tank.transitioning ? [tank.transitionFromZ, tank.transitionToZ] : [tank.z];
}

function resolveTankCollisions(game) {
    const tankList = Array.from(game.tanks.values());

    for (let i = 0; i < tankList.length; i++) {
        for (let j = i + 1; j < tankList.length; j++) {
            const a = tankList[i];
            const b = tankList[j];

            if (a.dead || b.dead) continue;

            const aZs = activeZSet(a);
            const bZs = activeZSet(b);
            const shareLevel = aZs.some(z => bZs.includes(z));
            if (!shareLevel) continue;

            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const distSq = dx * dx + dy * dy;
            const minDist = TANK_RADIUS * 2;

            if (distSq >= minDist * minDist) continue;

            const dist = Math.sqrt(distSq);
            const normalX = dist > 1e-6 ? dx / dist : 1;
            const normalY = dist > 1e-6 ? dy / dist : 0;

            const vAx = Math.cos(a.heading) * a.speed;
            const vAy = Math.sin(a.heading) * a.speed;
            const vBx = Math.cos(b.heading) * b.speed;
            const vBy = Math.sin(b.heading) * b.speed;

            const relVx = vAx - vBx;
            const relVy = vAy - vBy;
            const closingSpeed = Math.max(0, relVx * normalX + relVy * normalY);
            const baseDamage = closingSpeed * RAM_DAMAGE_SCALE;
            // Horns amplify what THIS tank deals when ramming, not what it
            // takes -- that's what the absorption in applyCollisionDamage
            // is for. So b's horns amplify a's incoming damage, and vice versa.
            const damageToA = baseDamage * (b.ramHorns > 0 ? RAM_HORNS_DAMAGE_MULTIPLIER : 1);
            const damageToB = baseDamage * (a.ramHorns > 0 ? RAM_HORNS_DAMAGE_MULTIPLIER : 1);

            emitSfx(game, 'collision', a.x, a.y, a.z);

            if (!isAfk(a,game.started)) {
                applyCollisionDamage(a, damageToA);
                if (a.health === 0) a.killedByCandidate = b.playerId;
            }
            if (!isAfk(b,game.started)) {
                applyCollisionDamage(b, damageToB);
                if (b.health === 0) b.killedByCandidate = a.playerId;
            }
            a.x = a.prevX;
            a.y = a.prevY;
            a.speed = 0;
            b.x = b.prevX;
            b.y = b.prevY;
            b.speed = 0;
        }
    }
}

function trySpawnShot(game, tank, offsetKey) {
    const now = Date.now();
    if (tank.lastFireTime && now - tank.lastFireTime < FIRE_COOLDOWN_MS) return;

    tank.lastFireTime = now;
    const shotId = game.nextLocalShotId++;
    const heading = tank.heading + FIRE_KEY_OFFSETS[offsetKey];

    game.shots.set(shotId, {
        shotId,
        ownerId: tank.playerId,
        x: tank.x,
        y: tank.y,
        z: tank.z,
        heading,
        distanceTraveled: 0
    });
    emitSfx(game, 'shot', tank.x, tank.y, tank.z);
}

function updateShots(game, dt) {
    for (const shot of game.shots.values()) {
        const step = SHOT_SPEED * dt;
        const proposedX = shot.x + Math.cos(shot.heading) * step;
        const proposedY = shot.y + Math.sin(shot.heading) * step;

        if (collidesWithWall(game, proposedX, proposedY, shot.z)) {
            game.shots.delete(shot.shotId);
            continue;
        }

        shot.x = proposedX;
        shot.y = proposedY;
        shot.distanceTraveled += step;

        if (shot.distanceTraveled >= game.shotMaxDistance) {
            game.shots.delete(shot.shotId);
        }
    }
}

function resolveShotHits(game) {
    for (const shot of game.shots.values()) {
        for (const tank of game.tanks.values()) {
            if (tank.playerId === shot.ownerId) continue;
            if (tank.dead) continue;
            if (tank.z !== shot.z) continue;

            const dx = tank.x - shot.x;
            const dy = tank.y - shot.y;
            const distSq = dx * dx + dy * dy;
            const hitRadius = TANK_RADIUS + SHOT_SIZE / 2;

            if (distSq < hitRadius * hitRadius) {
                if (!isAfk(tank,game.started)) {
                    tank.health = Math.max(0, tank.health - 25);
                    if (tank.health === 0) tank.killedBy = shot.ownerId;
                }
                emitSfx(game, 'hit', tank.x, tank.y, tank.z);
                game.shots.delete(shot.shotId);
                break;
            }
        }
    }
}

function broadcastGameState(game) {
    const now = Date.now();
    const tankList = Array.from(game.tanks.values());

    const shotsPayload = Array.from(game.shots.values()).map(s => ({
        shotId: s.shotId,
        ownerId: s.ownerId,
        x: s.x,
        y: s.y,
        z: s.z
    }));

    const powerUpsPayload = game.powerUps.map(p => ({
        id: p.id, type: p.type, z: p.z, cellX: p.cellX, cellY: p.cellY
    }));

    for (const recipient of tankList) {
        if (!recipient.ws || recipient.ws.readyState !== recipient.ws.OPEN) continue;

        const now = Date.now();
        const message = JSON.stringify({
            type: 'state',
            tanks: tankList
                .map(t => ({
                    playerId: t.playerId,
                    x: t.x,
                    y: t.y,
                    z: t.z,
                    health: t.health,
                    maxHealth: t.maxHealth,
                    heading: t.heading,
                    speed: t.speed,
                    dead: t.dead,
                    score: t.score,
                    ramHorns: t.ramHorns,
                    afk: isAfk(t, game.started),
                    transitioning: t.transitioning,
                    transitionFromZ: t.transitionFromZ,
                    transitionToZ: t.transitionToZ,
                    transitionProgress: t.transitioning
                        ? Math.min(1, (now - t.transitionStartTime) / VERTICAL_TRANSITION_MS)
                        : null,
                    verticalCooldown: (t.playerId === recipient.playerId && t.verticalCooldown && now < t.verticalCooldown.until)
                        ? {
                            direction: t.verticalCooldown.direction,
                            cellX: t.verticalCooldown.cellX,
                            cellY: t.verticalCooldown.cellY,
                            remainingMs: t.verticalCooldown.until - now
                          }
                        : null
                })),
            shots: shotsPayload,
            sfx: game.sfxEvents,
            powerUps: powerUpsPayload,
            timeRemaining: game.timeLimitMs ? game.startedAt + game.timeLimitMs - now : undefined
        });

        recipient.ws.send(message);
        game.sfxEvents = [];
    }
}

function broadcastLobbyState(game) {
    const message = JSON.stringify({
        type: 'lobby-state',
        gameId: game.id,
        name: game.name,
        width: game.width,
        length: game.length,
        height: game.height,
        humanSlots: game.humanSlots,
        aiSlots: game.aiSlots,
        started: game.started,
        hasPassword: !!game.password,
        roster: buildRoster(game),
        preview: formatGamePreview(game),
    });

    for (const tank of game.tanks.values()) {
        if (!tank.ws || tank.ws.readyState !== tank.ws.OPEN) continue;
        tank.ws.send(message);
    }
}

// Mid-game membership changes (someone leaves/disconnects after the round
// started) don't get a lobby-state broadcast, but voice-chat peer discovery
// still needs to hear about them -- this is that minimal notification.
function broadcastRosterUpdate(game) {
    const message = JSON.stringify({ type: 'roster-update', roster: buildRoster(game) });

    for (const tank of game.tanks.values()) {
        if (!tank.ws || tank.ws.readyState !== tank.ws.OPEN) continue;
        tank.ws.send(message);
    }
}

function startGame(game) {
    game.started = true;
    game.startedAt = Date.now();
    broadcastGameStart(game);

    const aiIdentities = assignAIIdentities(game.aiSlots);
    for (const identity of aiIdentities) {
        const playerId = game.nextLocalPlayerId++;
        const tank = {
            playerId,
            ws: null,
            isAI: true,
            sessionToken: null,
            name: identity.name,
            primaryColor: identity.primaryColor,
            secondaryColor: identity.secondaryColor,
            sprite: identity.sprite,
            x: 0, y: 0, z: 0, heading: 0, speed: 0, health: 100, maxHealth: 100,
            score: 0, lastScoreTime: null,
            dead: false, deathTime: null,
            transitioning: false, transitionFromZ: null, transitionToZ: null,
            transitionStartTime: null, verticalCooldown: null,
            lastActivityTime: Date.now(), tabHidden: false, disconnected: false,
            disconnectTimeout: null, hostGraceTimeout: null, wasHostAtDisconnect: false,
            lastFireTime: null, ramHorns: 0,
            aiState: 'wander', aiWaypoints: [],
            input: { turnLeft: false, turnRight: false, throttleUp: false, throttleDown: false }
        };
        game.tanks.set(playerId, tank);
    }

    const playerIds = Array.from(game.tanks.keys());
    const positions = placeStartingPositions(game, playerIds.length);

    playerIds.forEach((playerId, i) => {
        const tank = game.tanks.get(playerId);
        const [z, cellY, cellX] = positions[i] ?? [0, 0, 0];
        tank.x = cellX * game.cellSize + game.cellSize / 2;
        tank.y = cellY * game.cellSize + game.cellSize / 2;
        tank.z = z;
        tank.heading = 0;
        tank.speed = 0;
        tank.health = 100;
        tank.maxHealth = 100;
        tank.transitioning = false;
        tank.transitionFromZ = null;
        tank.transitionToZ = null;
        tank.transitionStartTime = null;
        tank.verticalCooldown = null;
        tank.lastActivityTime = Date.now();
        tank.tabHidden = false;
        tank.lastFireTime = null;
        tank.input = { turnLeft: false, turnRight: false, throttleUp: false, throttleDown: false };
    });

    for (const tank of game.tanks.values()) {
        if (!tank.ws || tank.ws.readyState !== tank.ws.OPEN) continue;
        tank.ws.send(JSON.stringify({
            type: 'game-started',
            maze: { largeur: game.width, longeur: game.length, hauteur: game.height, cellSize: game.cellSize, cells: game.maze },
            game: {
                name: game.name,
                isPrivate: game.password ? true : false,
                humanCount: game.humanCount,
                aiCount: game.aiCount,
                scoreTarget: game.scoreTarget, 
                timeRemaining: game.timeLimitMs
            },
            roster: buildRoster(game)
        }));
    }

    broadcastGameState(game);
    broadcastGamesList();
}

function purgeTank(game, playerId) {
    const tank = game.tanks.get(playerId);
    if (!tank) return;

    if (tank.sessionToken) sessionTokens.delete(tank.sessionToken);
    if (tank.disconnectTimeout) clearTimeout(tank.disconnectTimeout);
    if (tank.hostGraceTimeout) clearTimeout(tank.hostGraceTimeout);
    game.tanks.delete(playerId);

    const remainingHumans = Array.from(game.tanks.values()).filter(t => !t.isAI);

    if (remainingHumans.length === 0) {
        for (const t of game.tanks.values()) {
            if (t.disconnectTimeout) clearTimeout(t.disconnectTimeout);
            if (t.hostGraceTimeout) clearTimeout(t.hostGraceTimeout);
        }
        games.delete(game.id);
    } else {
        if (playerId === game.hostPlayerId) {
            const nextHost = remainingHumans[0];
            game.hostPlayerId = nextHost.playerId;
        }

        const stillWaiting = remainingHumans.some((t) => t.awaitingLeave);
        if (game.started && !stillWaiting && game.ended) {
            resetGameForLobby(game);
            broadcastLobbyState(game);
        } else if (!game.started) {
            broadcastLobbyState(game);
        } else {
            broadcastRosterUpdate(game);
        }
    }
    broadcastGamesList();
}

function resetGameForLobby(game) {
    for (const tank of Array.from(game.tanks.values())) {
        if (tank.isAI) game.tanks.delete(tank.playerId);
    }

    game.started = false;
    game.ended = false;
    game.startedAt = null;
    game.shots.clear();
    game.powerUps = [];
    game.sfxEvents = [];

    for (const tank of game.tanks.values()) {
        tank.dead = false;
        tank.deathTime = null;
        tank.score = 0;
        tank.lastScoreTime = null;
        tank.health = 100;
        tank.maxHealth = 100;
        tank.x = 0; tank.y = 0; tank.z = 0; tank.heading = 0; tank.speed = 0;
        tank.transitioning = false;
        tank.transitionFromZ = null;
        tank.transitionToZ = null;
        tank.transitionStartTime = null;
        tank.verticalCooldown = null;
        tank.lastFireTime = null;
        tank.awaitingLeave = false;
        tank.ramHorns = 0;
        tank.input = { turnLeft: false, turnRight: false, throttleUp: false, throttleDown: false };
    }
}

function promoteNextHost(game, departingHostId) {
    if (game.hostPlayerId !== departingHostId) return;
    if (!game.tanks.has(departingHostId)) return;

    const nextHost = Array.from(game.tanks.values()).find(t => t.playerId !== departingHostId && !t.isAI);
    if (!nextHost) return;

    game.hostPlayerId = nextHost.playerId;
    broadcastLobbyState(game);
}

function cellKey(z, y, x) {
    return `${z},${y},${x}`;
}

function getNeighbors(game, z, y, x) {
    const cell = game.maze[z][y][x];
    const neighbors = [];

    // Bounds-check every direction: a boundary cell's open-wall bits should
    // never point off the edge of the maze, but a crash here takes down the
    // whole server (every game, every player) rather than just this one BFS
    // step, so this doesn't trust that invariant.
    if (cell & Direction.North && y - 1 >= 0) neighbors.push([z, y - 1, x]);
    if (cell & Direction.South && y + 1 < game.length) neighbors.push([z, y + 1, x]);
    if (cell & Direction.East && x + 1 < game.width) neighbors.push([z, y, x + 1]);
    if (cell & Direction.West && x - 1 >= 0) neighbors.push([z, y, x - 1]);
    if (cell & Direction.Up && z - 1 >= 0) neighbors.push([z - 1, y, x]);
    if (cell & Direction.Down && z + 1 < game.height) neighbors.push([z + 1, y, x]);

    return neighbors;
}

// BFS multi-source: retourne, pour chaque cellule atteignable, la distance
// (en sauts) jusqu'à la cellule occupée la plus proche. Les transitions
// verticales comptent comme un saut, au même titre qu'un déplacement
// horizontal.
export function computeDistances(game, occupiedCells) {
    const distances = new Map();
    const queue = [];

    for (const [z, y, x] of occupiedCells) {
        const key = cellKey(z, y, x);
        if (distances.has(key)) continue;
        distances.set(key, 0);
        queue.push([z, y, x, 0]);
    }

    let head = 0;
    while (head < queue.length) {
        const [z, y, x, dist] = queue[head++];
        for (const [nz, ny, nx] of getNeighbors(game, z, y, x)) {
            const key = cellKey(nz, ny, nx);
            if (distances.has(key)) continue;
            distances.set(key, dist + 1);
            queue.push([nz, ny, nx, dist + 1]);
        }
    }

    return distances;
}

// Trouve la cellule non-occupée la plus éloignée de l'ensemble occupé
// (distance de graphe). Retourne null si toutes les cellules sont occupées
// (carte pleine).
function findFarthestCell(game, occupiedCells) {
    const distances = computeDistances(game, occupiedCells);
    const occupiedKeys = new Set(occupiedCells.map(([z, y, x]) => cellKey(z, y, x)));

    let best = null;
    let bestDist = -1;

    for (let z = 0; z < game.height; z++) {
        for (let y = 0; y < game.length; y++) {
            for (let x = 0; x < game.width; x++) {
                const key = cellKey(z, y, x);
                if (occupiedKeys.has(key)) continue;
                const dist = distances.get(key) ?? -1; // -1 si inatteignable (ne devrait
                                                          // jamais arriver, Wilson garantit
                                                          // la connexité totale)
                if (dist > bestDist) {
                    bestDist = dist;
                    best = [z, y, x];
                }
            }
        }
    }

    return best;
}

function getPowerUpOccupiedCells(game) {
    return game.powerUps.map(p => [p.z, p.cellY, p.cellX]);
}

// Place N positions de départ aussi équidistantes que possible les unes des
// autres ET des power-ups déjà sur la carte, en piochant itérativement la
// cellule la plus éloignée de tout ce qui est déjà occupé.
function placeStartingPositions(game, playerCount) {
    const occupied = getPowerUpOccupiedCells(game);
    const positions = [];

    if (playerCount === 0) return positions;

    // Premier joueur: rien n'est encore occupé, donc "le plus éloigné" n'a
    // pas de sens -- place-le à une position fixe et arbitraire (centre du
    // rez-de-chaussée) plutôt que de dépendre de findFarthestCell, qui a
    // besoin d'au moins une cellule occupée pour fonctionner.
    const firstCell = [0, Math.floor(game.length / 2), Math.floor(game.width / 2)];
    positions.push(firstCell);
    occupied.push(firstCell);

    for (let i = 1; i < playerCount; i++) {
        const cell = findFarthestCell(game, occupied);
        if (!cell) break;
        positions.push(cell);
        occupied.push(cell);
    }

    return positions;
}

// Choisit une position de réapparition pour un char donné, loin de tous les
// autres chars vivants et des power-ups.
function pickRespawnCell(game, excludePlayerId) {
    const occupied = getPowerUpOccupiedCells(game);
    for (const tank of game.tanks.values()) {
        if (tank.playerId === excludePlayerId) continue;
        occupied.push([tank.z, Math.floor(tank.y / game.cellSize), Math.floor(tank.x / game.cellSize)]);
    }

    return findFarthestCell(game, occupied);
}

function checkDeaths(game) {
    const newlyDead = [];

    for (const tank of game.tanks.values()) {
        if (tank.dead) continue;
        if (tank.health > 0) continue;

        tank.dead = true;
        tank.deathTime = Date.now();
        tank.speed = 0;
        emitSfx(game, 'explosion', tank.x, tank.y, tank.z);
        newlyDead.push(tank);
    }

    // Snapshot who each newly-dead tank was killed by before the fields get
    // cleared below -- a mutual kill needs both sides' attribution intact
    // regardless of which one this loop reaches first.
    const killerOf = new Map(newlyDead.map((t) => [t.playerId, t.killedBy ?? t.killedByCandidate ?? null]));
    const handled = new Set();

    for (const tank of newlyDead) {
        tank.killedBy = null;
        tank.killedByCandidate = null;

        if (handled.has(tank.playerId)) continue;

        const killerId = killerOf.get(tank.playerId);
        if (killerId === null) continue;

        if (killerOf.get(killerId) === tank.playerId) {
            const other = newlyDead.find((t) => t.playerId === killerId);
            if (other) {
                handled.add(tank.playerId);
                handled.add(other.playerId);
                broadcastMurderSuicide(game, tank, other);
                continue;
            }
        }

        const killer = game.tanks.get(killerId);
        if (killer && !killer.dead && killer.playerId !== tank.playerId) {
            killer.score += 1;
            killer.lastScoreTime = Date.now();

            broadcastKillAnnouncement(game, killer, tank);

            if (killer.isAI && AI_TAUNTS.length > 0 && Math.random() < AI_TAUNT_CHANCE) {
                const taunt = AI_TAUNTS[Math.floor(Math.random() * AI_TAUNTS.length)];
                broadcastGameChat(game, killer, taunt);
            }
        }
    }
}

function respawnDeadTanks(game) {
    const now = Date.now();
    for (const tank of game.tanks.values()) {
        if (!tank.dead) continue;
        if (now - tank.deathTime < RESPAWN_DELAY_MS) continue;

        const cell = pickRespawnCell(game, tank.playerId);
        const [z, cellY, cellX] = cell ?? [tank.z, Math.floor(tank.y / game.cellSize), Math.floor(tank.x / game.cellSize)];

        tank.x = cellX * game.cellSize + game.cellSize / 2;
        tank.y = cellY * game.cellSize + game.cellSize / 2;
        tank.z = z;
        tank.heading = 0;
        tank.speed = 0;
        tank.health = 100;
        tank.maxHealth = 100;
        tank.dead = false;
        tank.deathTime = null;
        tank.transitioning = false;
        tank.transitionFromZ = null;
        tank.transitionToZ = null;
        tank.transitionStartTime = null;
        tank.verticalCooldown = null;
        tank.lastActivityTime = now;
        tank.ramHorns = 0;
        if (tank.isAI) {
            tank.aiState = 'wander';
            tank.aiWaypoints = [];
        }
    }
}

function checkGameEnd(game) {
    if (game.ended) return;

    const now = Date.now();
    const timeExpired = game.timeLimitMs && (now - game.startedAt >= game.timeLimitMs);
    const someoneWon = Array.from(game.tanks.values()).some(t => t.score >= game.scoreTarget);

    if (!timeExpired && !someoneWon) return;

    const tankList = Array.from(game.tanks.values());
    let winner = tankList[0];
    for (const tank of tankList) {
        if (tank.score > winner.score) {
            winner = tank;
        } else if (tank.score === winner.score) {
            const tankTime = tank.lastScoreTime ?? Infinity;
            const winnerTime = winner.lastScoreTime ?? Infinity;
            if (tankTime < winnerTime) winner = tank; // le premier à avoir atteint ce score l'emporte
        }
    }

    game.ended = true;
    for (const tank of tankList) {
        if (!tank.isAI) tank.awaitingLeave = true;
    }

    const message = JSON.stringify({
        type: 'game-ended',
        winner: {
            playerId: winner.playerId,
            name: winner.name,
            primaryColor: winner.primaryColor,
            secondaryColor: winner.secondaryColor,
            sprite: winner.sprite
        },
        scores: tankList.map(t => ({
            playerId: t.playerId,
            name: t.name,
            isAI: t.isAI,
            primaryColor: t.primaryColor,
            secondaryColor: t.secondaryColor,
            sprite: t.sprite,
            score: t.score
        }))
    });

    for (const tank of game.tanks.values()) {
        if (tank.ws && tank.ws.readyState === tank.ws.OPEN) tank.ws.send(message);
    }
}

let lastTick = Date.now();
function tick() {
    const now = Date.now();
    const dt = (now - lastTick) / 1000;
    lastTick = now;

    for (const game of games.values()) {
        if (!game.started || game.ended) continue;

        if (now - game.lastPowerUpSpawnAttempt >= POWERUP_SPAWN_INTERVAL_MS) {
            game.lastPowerUpSpawnAttempt = now;
            trySpawnPowerUp(game);
        }

        for (const tank of game.tanks.values()) {
            if (tank.dead) continue;
            if (tank.isAI) updateAITank(game, tank, dt, trySpawnShot, computeDistances);
            updateTank(game, tank, dt);
        }

        resolveTankCollisions(game);
        updateShots(game, dt);
        resolveShotHits(game);
        checkDeaths(game);
        respawnDeadTanks(game);
        checkPowerUpPickups(game);
        checkGameEnd(game);
        broadcastGameState(game);
    }
}

function broadcastBrowseChat(identity, text) {
    const message = JSON.stringify({
        type: 'chat-message',
        name: identity.name,
        primaryColor: identity.primaryColor,
        secondaryColor: identity.secondaryColor,
        sprite: identity.sprite,
        text,
        timestamp: Date.now()
    });

    for (const socket of browserSockets) {
        if (socket.readyState === socket.OPEN) socket.send(message);
    }
}

function broadcastGameChat(game, tank, text) {
    const message = JSON.stringify({
        type: 'chat-message',
        name: tank.name,
        primaryColor: tank.primaryColor,
        secondaryColor: tank.secondaryColor,
        sprite: tank.sprite,
        text,
        timestamp: Date.now()
    });

    for (const t of game.tanks.values()) {
        if (t.ws && t.ws.readyState === t.ws.OPEN) t.ws.send(message);
    }
}

function tankIdentity(tank) {
    return { name: tank.name, primaryColor: tank.primaryColor, secondaryColor: tank.secondaryColor, sprite: tank.sprite };
}

function broadcastKillAnnouncement(game, killer, victim) {
    const message = JSON.stringify({
        type: 'chat-message',
        kind: 'kill',
        killer: tankIdentity(killer),
        victim: tankIdentity(victim),
        timestamp: Date.now()
    });

    for (const t of game.tanks.values()) {
        if (t.ws && t.ws.readyState === t.ws.OPEN) t.ws.send(message);
    }
}

function broadcastMurderSuicide(game, a, b) {
    const message = JSON.stringify({
        type: 'chat-message',
        kind: 'murder-suicide',
        a: tankIdentity(a),
        b: tankIdentity(b),
        timestamp: Date.now()
    });

    for (const t of game.tanks.values()) {
        if (t.ws && t.ws.readyState === t.ws.OPEN) t.ws.send(message);
    }
}

function broadcastGameStart(game) {
    const message = JSON.stringify({
        type: 'chat-message',
        kind: 'game-start',
        timestamp: Date.now()
    });

    for (const t of game.tanks.values()) {
        if (t.ws && t.ws.readyState === t.ws.OPEN) t.ws.send(message);
    }
}

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
    let currentGame = null;
    let assignedPlayerId = null;

    browserSockets.add(ws);
    ws.send(JSON.stringify({
        type: 'games-list',
        games: Array.from(games.values()).map(gameSummary)
    }));
    ws.send(JSON.stringify({
        type: 'browser-players',
        players: Array.from(browserIdentities.values())
    }));

    ws.on('message', (data) => {
        let msg;
        try {
            msg = JSON.parse(data);
        } catch {
            return;
        }
        console.log(`got a message ${msg.type}`);

        if (msg.type === 'browse') {
            browserIdentities.set(ws, {
                name: truncateToBytes(String(msg.playerName ?? 'Player'), PLAYER_NAME_MAX_BYTES),
                primaryColor: msg.primaryColor,
                secondaryColor: msg.secondaryColor,
                sprite: msg.sprite
            });
            broadcastBrowserPlayers();
            return;
        }

        if (msg.type === 'resume') {
            const entry = sessionTokens.get(msg.sessionToken);
            const game = entry ? games.get(entry.gameId) : null;
            const tank = game ? game.tanks.get(entry.playerId) : null;

            if (!game || !tank) {
                ws.send(JSON.stringify({ type: 'resume-failed' }));
                return;
            }

            if (tank.disconnectTimeout) {
                clearTimeout(tank.disconnectTimeout);
                tank.disconnectTimeout = null;
            }

            const wasPromotedAway = tank.wasHostAtDisconnect && !game.started && game.hostPlayerId !== tank.playerId;
            tank.wasHostAtDisconnect = false;

            if (tank.hostGraceTimeout) {
                clearTimeout(tank.hostGraceTimeout);
                tank.hostGraceTimeout = null;
            }

            tank.ws = ws;
            tank.disconnected = false;
            tank.lastActivityTime = Date.now();

            if (wasPromotedAway) {
                game.tanks.delete(tank.playerId);
                game.tanks.set(tank.playerId, tank);
            }

            currentGame = game;
            assignedPlayerId = tank.playerId;
            browserSockets.delete(ws);
            browserIdentities.delete(ws);

            ws.send(JSON.stringify({
                type: 'resumed',
                playerId: tank.playerId,
                gameId: game.id,
                started: game.started,
                name: game.name,
                private: game.password ? true : false,
                width: game.width,
                length: game.length,
                height: game.height,
                humanSlots: game.humanSlots,
                aiSlots: game.aiSlots,
                roster: buildRoster(game),
                maze: game.started
                    ? { largeur: game.width, longeur: game.length, hauteur: game.height, cellSize: game.cellSize, cells: game.maze }
                    : null
            }));

            if (!game.started) broadcastLobbyState(game);
            return;
        }

        if (msg.type === 'create-game') {
            if (currentGame) return;

            const width = Math.max(2, Math.min(10, parseInt(msg.width, 10) || 10));
            const length = Math.max(2, Math.min(10, parseInt(msg.length, 10) || 10));
            const height = Math.max(1, Math.min(10, parseInt(msg.height, 10) || 1));
            const humanCount = Math.max(1, Math.min(MAX_TOTAL_PLAYERS, parseInt(msg.humanCount, 10) || 1));
            const aiCount = Math.max(0, Math.min(MAX_TOTAL_PLAYERS - humanCount, parseInt(msg.aiCount, 10) || 0));
            const scoreTarget = Math.max(1, Math.min(100, parseInt(msg.scoreTarget, 10) || DEFAULT_SCORE_TARGET));
            const timeLimitMs = msg.timeLimitMs ? Math.max(2, Math.min(60, parseInt(msg.timeLimitMs, 10))) * 60000 : null;

            const game = createGame({
                name: truncateToBytes(String(msg.name ?? 'Untitled Game'), GAME_NAME_MAX_BYTES),
                password: msg.password ? hashPassword(truncateToBytes(msg.password, PASSWORD_MAX_BYTES)) : null,
                width, length, height,
                humanCount, aiCount,
                scoreTarget, timeLimitMs
            });

            currentGame = game;
            const playerId = (assignedPlayerId != undefined) ? assignedPlayerId : game.nextLocalPlayerId++;
            assignedPlayerId = playerId;
            game.hostPlayerId = playerId;

            const tank = {
                playerId,
                ws,
                sessionToken: msg.sessionToken,
                name: truncateToBytes(String(msg.playerName ?? 'Player'), PLAYER_NAME_MAX_BYTES),
                primaryColor: msg.primaryColor,
                secondaryColor: msg.secondaryColor,
                sprite: msg.sprite,
                dead: false,
                deathTime: null,
                x: 0, y: 0, z: 0, heading: 0, speed: 0, health: 100, maxHealth: 100,
                transitioning: false, transitionFromZ: null, transitionToZ: null,
                transitionStartTime: null, verticalCooldown: null,
                lastActivityTime: Date.now(), tabHidden: false, disconnected: false,
                disconnectTimeout: null, hostGraceTimeout: null, wasHostAtDisconnect: false,
                lastFireTime: null, ramHorns: 0,
                score: 0,
                lastScoreTime: null,
                input: { turnLeft: false, turnRight: false, throttleUp: false, throttleDown: false }
            };

            game.tanks.set(playerId, tank);
            if (msg.sessionToken) sessionTokens.set(msg.sessionToken, { gameId: game.id, playerId });
            browserSockets.delete(ws);
            browserIdentities.delete(ws);
            broadcastBrowserPlayers();

            ws.send(JSON.stringify({ type: 'lobby-joined', gameId: game.id, playerId }));
            broadcastLobbyState(game);
            broadcastGamesList();
            return;
        }

        if (msg.type === 'edit-game') {
            console.log(`got an edit-game ${currentGame !== undefined}`);
            if (!currentGame) return;

            const width = Math.max(2, Math.min(10, parseInt(msg.width, 10) || 10));
            const length = Math.max(2, Math.min(10, parseInt(msg.length, 10) || 10));
            const height = Math.max(1, Math.min(10, parseInt(msg.height, 10) || 1));
            const humanCount = Math.max(1, Math.min(MAX_TOTAL_PLAYERS, parseInt(msg.humanCount, 10) || 1));
            const aiCount = Math.max(0, Math.min(MAX_TOTAL_PLAYERS - humanCount, parseInt(msg.aiCount, 10) || 0));
            const scoreTarget = Math.max(1, Math.min(100, parseInt(msg.scoreTarget, 10) || DEFAULT_SCORE_TARGET));
            const timeLimitMs = msg.timeLimitMs ? Math.max(2, Math.min(60, parseInt(msg.timeLimitMs, 10))) * 60000 : null;

            if(msg.gameId === undefined) throw 'msg.gameId is undefined!';
            if(msg.hostPlayerId === undefined) throw 'msg.hostPlayerId is undefined!';

            // delete / recreate the game
            games.delete(msg.gameId);
            const game = createGame({
                name: truncateToBytes(String(msg.name ?? 'Untitled Game'), GAME_NAME_MAX_BYTES),
                password: msg.password ? hashPassword(truncateToBytes(msg.password, PASSWORD_MAX_BYTES)) : null,
                width, length, height,
                humanCount, aiCount,
                scoreTarget, timeLimitMs
            });

            currentGame = game;
            const playerId = msg.hostPlayerId;
            assignedPlayerId = playerId;
            game.hostPlayerId = playerId;

            const tank = {
                playerId,
                ws,
                sessionToken: msg.sessionToken,
                name: truncateToBytes(String(msg.playerName ?? 'Player'), PLAYER_NAME_MAX_BYTES),
                primaryColor: msg.primaryColor,
                secondaryColor: msg.secondaryColor,
                sprite: msg.sprite,
                dead: false,
                deathTime: null,
                x: 0, y: 0, z: 0, heading: 0, speed: 0, health: 100, maxHealth: 100,
                transitioning: false, transitionFromZ: null, transitionToZ: null,
                transitionStartTime: null, verticalCooldown: null,
                lastActivityTime: Date.now(), tabHidden: false, disconnected: false,
                disconnectTimeout: null, hostGraceTimeout: null, wasHostAtDisconnect: false,
                lastFireTime: null, ramHorns: 0,
                score: 0,
                lastScoreTime: null,
                input: { turnLeft: false, turnRight: false, throttleUp: false, throttleDown: false }
            };

            game.tanks.set(playerId, tank);
            if (msg.sessionToken) sessionTokens.set(msg.sessionToken, { gameId: game.id, playerId });
            browserSockets.delete(ws);
            browserIdentities.delete(ws);
            broadcastBrowserPlayers();

            ws.send(JSON.stringify({ type: 'lobby-joined', gameId: game.id, playerId }));
            broadcastLobbyState(game);
            broadcastGamesList();
            return;
        }

        if (msg.type === 'join-game') {
            if (currentGame) return;

            const game = games.get(msg.gameId);
            if (!game) return;
            if (game.started) {
                ws.send(JSON.stringify({ type: 'join-rejected', reason: 'started' }));
                return;
            }
            if (game.password && game.password !== hashPassword(truncateToBytes(msg.password || '', PASSWORD_MAX_BYTES))) {
                ws.send(JSON.stringify({ type: 'join-rejected', reason: 'bad-password' }));
                return;
            }
            if (game.tanks.size >= game.humanSlots) {
                ws.send(JSON.stringify({ type: 'join-rejected', reason: 'full' }));
                return;
            }

            currentGame = game;
            const playerId = game.nextLocalPlayerId++;
            assignedPlayerId = playerId;

            const tank = {
                playerId,
                ws,
                sessionToken: msg.sessionToken,
                name: truncateToBytes(String(msg.playerName ?? 'Player'), PLAYER_NAME_MAX_BYTES),
                primaryColor: msg.primaryColor,
                secondaryColor: msg.secondaryColor,
                sprite: msg.sprite,
                dead: false,
                deathTime: null,
                x: 0, y: 0, z: 0, heading: 0, speed: 0, health: 100, maxHealth: 100,
                transitioning: false, transitionFromZ: null, transitionToZ: null,
                transitionStartTime: null, verticalCooldown: null,
                lastActivityTime: Date.now(), tabHidden: false, disconnected: false,
                disconnectTimeout: null, hostGraceTimeout: null, wasHostAtDisconnect: false,
                lastFireTime: null, ramHorns: 0,
                score: 0,
                lastScoreTime: null,
                input: { turnLeft: false, turnRight: false, throttleUp: false, throttleDown: false }
            };

            game.tanks.set(playerId, tank);
            if (msg.sessionToken) sessionTokens.set(msg.sessionToken, { gameId: game.id, playerId });
            browserSockets.delete(ws);
            browserIdentities.delete(ws);
            broadcastBrowserPlayers();

            ws.send(JSON.stringify({ type: 'lobby-joined', gameId: game.id, playerId }));
            broadcastLobbyState(game);
            broadcastGamesList();
            return;
        }

        if (msg.type === 'start-game') {
            console.log(`currentGame = ${currentGame !== undefined} ${assignedPlayerId} ${currentGame ? currentGame.hostPlayerId : 'unknown'}`);
            if (!currentGame || assignedPlayerId !== currentGame.hostPlayerId) return;
            if (currentGame.started) return;

            startGame(currentGame);
            return;
        }

        if (msg.type === 'leave-game') {
            if (!currentGame || assignedPlayerId === null) return;

            const game = currentGame;
            const playerId = assignedPlayerId;

            purgeTank(game, playerId);

            currentGame = null;
            assignedPlayerId = null;
            browserSockets.add(ws);

            ws.send(JSON.stringify({ type: 'left-game' }));
            ws.send(JSON.stringify({
                type: 'games-list',
                games: Array.from(games.values()).map(gameSummary)
            }));
            return;
        }

        if (msg.type === 'revert-to-lobby') {
            if (!currentGame || assignedPlayerId === null) return;

            const game = currentGame;
            const tank = game.tanks.get(assignedPlayerId);
            if (tank) tank.awaitingLeave = false;

            const stillWaiting = Array.from(game.tanks.values()).some((t) => !t.isAI && t.awaitingLeave);
            if (game.started && game.ended && !stillWaiting) {
                resetGameForLobby(game);
                broadcastGamesList();
            }

            ws.send(JSON.stringify({ type: 'reverted-to-lobby' }));
            broadcastLobbyState(game);
            return;
        }

        if (msg.type === 'voice-signal') {
            if (!currentGame || assignedPlayerId === null) return;

            const targetTank = currentGame.tanks.get(msg.targetPlayerId);
            if (!targetTank || !targetTank.ws || targetTank.ws.readyState !== targetTank.ws.OPEN) return;

            targetTank.ws.send(JSON.stringify({
                type: 'voice-signal',
                fromPlayerId: assignedPlayerId,
                signal: msg.signal
            }));
            return;
        }

        if (msg.type === 'chat') {
            const text = typeof msg.text === 'string' ? msg.text.trim() : '';
            if (text.length === 0) return;
            if (byteLength(text) > CHAT_MAX_BYTES) return;

            const now = Date.now();

            if (currentGame && assignedPlayerId !== null) {
                const tank = currentGame.tanks.get(assignedPlayerId);
                if (!tank) return;
                if (tank.lastChatTime && now - tank.lastChatTime < CHAT_RATE_LIMIT_MS) return;
                tank.lastChatTime = now;
                broadcastGameChat(currentGame, tank, text);
            } else {
                const last = browserLastChatTime.get(ws) || 0;
                if (now - last < CHAT_RATE_LIMIT_MS) return;
                browserLastChatTime.set(ws, now);
                const identity = browserIdentities.get(ws);
                if (!identity) return;
                broadcastBrowseChat(identity, text);
            }
            return;
        }

        if (!currentGame || assignedPlayerId === null) return;
        const tank = currentGame.tanks.get(assignedPlayerId);
        if (!tank) return;

        if (msg.type === 'input') {
            tank.input.turnLeft = !!msg.turnLeft;
            tank.input.turnRight = !!msg.turnRight;
            tank.input.throttleUp = !!msg.throttleUp;
            tank.input.throttleDown = !!msg.throttleDown;
        } else if (msg.type === 'fire') {
            if (FIRE_KEY_OFFSETS[msg.direction] !== undefined) {
                tank.lastActivityTime = Date.now();
                trySpawnShot(currentGame, tank, msg.direction);
            }
        } else if (msg.type === 'visibility') {
            tank.tabHidden = !!msg.hidden;
        }
    });

    ws.on('close', () => {
        browserSockets.delete(ws);
        browserIdentities.delete(ws);
        browserLastChatTime.delete(ws);

        if (!currentGame || assignedPlayerId === null) return;
        const game = currentGame;
        const playerId = assignedPlayerId;
        const tank = game.tanks.get(playerId);
        if (!tank) return;
        // A newer connection may have already resumed this tank (e.g. a
        // quick unmount/remount of an embedded client) -- if so, its ws
        // reference is no longer this socket, and tearing it down here
        // would clobber the live connection instead of the dead one.
        if (tank.ws !== ws) return;

        tank.disconnected = true;
        tank.ws = null;
        tank.disconnectTimeout = setTimeout(() => {
            purgeTank(game, playerId);
        }, RECONNECT_GRACE_MS);

        if (!game.started && playerId === game.hostPlayerId) {
            tank.wasHostAtDisconnect = true;
            tank.hostGraceTimeout = setTimeout(() => {
                promoteNextHost(game, playerId);
            }, RECONNECT_GRACE_MS);
        }

        if (!game.started) broadcastLobbyState(game);
    });
});

setInterval(tick, TICK_MS);
setInterval(() => {
    for (const game of games.values()) {
        if (!game.started) broadcastLobbyState(game);
    }
}, 5000);

console.log(`Bolo WebSocket server listening on ws://localhost:${PORT}`);
