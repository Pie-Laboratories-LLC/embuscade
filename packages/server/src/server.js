import { WebSocketServer } from 'ws';
import Wilson from '@bolo/shared/Wilson.js';
import { Direction } from '@bolo/shared/Direction.js';
import { getVerticalIcons } from '@bolo/shared/MazeGeometry.js';
import { createHash } from 'node:crypto';
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
const CHAT_MAX_BYTES = 256;
const CHAT_RATE_LIMIT_MS = 1000;
const RESPAWN_DELAY_MS = 3500;
const DEFAULT_SCORE_TARGET = 10;

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
        preview: formatGamePreview(game)
    };
}

function broadcastGamesList() {
    const list = Array.from(games.values())
        .filter(g => !g.started)
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
        afk: isAfk(t,game.started)
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
        powerUps: []
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

function isAfk(tank, requireIdleCheck = true) {
    if (tank.disconnected || tank.tabHidden) return true;
    if (!requireIdleCheck) return false;
    return Date.now() - tank.lastActivityTime > AFK_TIMEOUT_MS;
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
        tank.health = Math.max(0, tank.health - tank.speed * 0.3);
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
            const damage = closingSpeed * RAM_DAMAGE_SCALE;

            if (!isAfk(a,game.started)) {
                a.health = Math.max(0, a.health - damage);
                if (a.health === 0) a.killedByCandidate = b.playerId;
            }
            if (!isAfk(b,game.started)) {
                b.health = Math.max(0, b.health - damage);
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

    for (const recipient of tankList) {
        if (!recipient.ws || recipient.ws.readyState !== recipient.ws.OPEN) continue;

        const message = JSON.stringify({
            type: 'state',
            tanks: tankList
                .map(t => ({
                    playerId: t.playerId,
                    x: t.x,
                    y: t.y,
                    z: t.z,
                    health: t.health,
                    heading: t.heading,
                    speed: t.speed,
                    dead: t.dead,
                    score: t.score,
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
            shots: shotsPayload
        });

        recipient.ws.send(message);
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

function startGame(game) {
    game.started = true;
    game.startedAt = Date.now();

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
            x: 0, y: 0, z: 0, heading: 0, speed: 0, health: 100,
            score: 0, lastScoreTime: null,
            dead: false, deathTime: null,
            transitioning: false, transitionFromZ: null, transitionToZ: null,
            transitionStartTime: null, verticalCooldown: null,
            lastActivityTime: Date.now(), tabHidden: false, disconnected: false,
            disconnectTimeout: null, hostGraceTimeout: null, wasHostAtDisconnect: false,
            lastFireTime: null,
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
        if (!game.started) broadcastLobbyState(game);
    }
    broadcastGamesList();
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

    if (cell & Direction.North) neighbors.push([z, y - 1, x]);
    if (cell & Direction.South) neighbors.push([z, y + 1, x]);
    if (cell & Direction.East) neighbors.push([z, y, x + 1]);
    if (cell & Direction.West) neighbors.push([z, y, x - 1]);
    if (cell & Direction.Up) neighbors.push([z - 1, y, x]);
    if (cell & Direction.Down) neighbors.push([z + 1, y, x]);

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
        newlyDead.push(tank);
    }

    for (const tank of newlyDead) {
        const killerId = tank.killedBy ?? tank.killedByCandidate ?? null;
        tank.killedBy = null;
        tank.killedByCandidate = null;

        if (killerId === null) continue;

        const killer = game.tanks.get(killerId);
        if (killer && !killer.dead && killer.playerId !== tank.playerId) {
            killer.score += 1;
            killer.lastScoreTime = Date.now();
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
        tank.dead = false;
        tank.deathTime = null;
        tank.transitioning = false;
        tank.transitionFromZ = null;
        tank.transitionToZ = null;
        tank.transitionStartTime = null;
        tank.verticalCooldown = null;
        tank.lastActivityTime = now;
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
        checkGameEnd(game);
        broadcastGameState(game);
    }
}

function byteLength(str) {
    return new TextEncoder().encode(str).length;
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

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
    let currentGame = null;
    let assignedPlayerId = null;

    browserSockets.add(ws);
    ws.send(JSON.stringify({
        type: 'games-list',
        games: Array.from(games.values()).filter(g => !g.started).map(gameSummary)
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

        if (msg.type === 'browse') {
            browserIdentities.set(ws, {
                name: String(msg.playerName ?? 'Player').slice(0, 20),
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
                name: String(msg.name ?? 'Untitled Game').slice(0, 120),
                password: msg.password ? hashPassword(msg.password) : null,
                width, length, height,
                humanCount, aiCount,
                scoreTarget, timeLimitMs
            });

            currentGame = game;
            const playerId = game.nextLocalPlayerId++;
            assignedPlayerId = playerId;
            game.hostPlayerId = playerId;

            const tank = {
                playerId,
                ws,
                sessionToken: msg.sessionToken,
                name: String(msg.playerName ?? 'Player').slice(0, 20),
                primaryColor: msg.primaryColor,
                secondaryColor: msg.secondaryColor,
                sprite: msg.sprite,
                dead: false,
                deathTime: null,
                x: 0, y: 0, z: 0, heading: 0, speed: 0, health: 100,
                transitioning: false, transitionFromZ: null, transitionToZ: null,
                transitionStartTime: null, verticalCooldown: null,
                lastActivityTime: Date.now(), tabHidden: false, disconnected: false,
                disconnectTimeout: null, hostGraceTimeout: null, wasHostAtDisconnect: false,
                lastFireTime: null,
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
            if (!game || game.started) return;
            if (game.password && game.password !== hashPassword(msg.password || '')) {
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
                name: String(msg.playerName ?? 'Player').slice(0, 20),
                primaryColor: msg.primaryColor,
                secondaryColor: msg.secondaryColor,
                sprite: msg.sprite,
                dead: false,
                deathTime: null,
                x: 0, y: 0, z: 0, heading: 0, speed: 0, health: 100,
                transitioning: false, transitionFromZ: null, transitionToZ: null,
                transitionStartTime: null, verticalCooldown: null,
                lastActivityTime: Date.now(), tabHidden: false, disconnected: false,
                disconnectTimeout: null, hostGraceTimeout: null, wasHostAtDisconnect: false,
                lastFireTime: null,
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
                games: Array.from(games.values()).filter(g => !g.started).map(gameSummary)
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
