import { Direction } from '@bolo/shared/Direction.js';
import { PRESET_SPRITES } from '@bolo/shared/PresetSprites.js';
import { isAfk, computeDistances } from './server.js';


const AI_NAMES = [
    'Fred', 'Wilma', 'Betty', 'Barney', 'Zoe', 'Samantha', 'Spencer',
    'Romulous', 'Remus', 'Rena', 'Jane', 'George', 'Jimmy', 'Terwilliger',
    'Claudie', 'Gork', 'BratPDQ', 'Rosie', '3po', 'Marvin', 'R2', 'Punky',
    'Liddy', 'Her'
];

// couleurs nommées CSS, moins black/white et les teintes quasi-blanches ou
// quasi-noires (trop peu lisibles contre le fond/les autres éléments d'UI)
const AI_COLORS = [
    'red', 'orange', 'gold', 'yellow', 'yellowgreen', 'green', 'lime',
    'springgreen', 'teal', 'cyan', 'skyblue', 'dodgerblue', 'blue',
    'royalblue', 'navy', 'indigo', 'purple', 'violet', 'magenta',
    'deeppink', 'crimson', 'firebrick', 'tomato', 'coral', 'salmon',
    'chocolate', 'sienna', 'peru', 'goldenrod', 'olive', 'darkgreen',
    'seagreen', 'steelblue', 'slateblue', 'mediumpurple', 'orchid',
    'hotpink', 'maroon', 'brown', 'darkorange', 'darkred', 'darkcyan',
    'darkmagenta', 'darkviolet', 'darkslateblue', 'cadetblue',
    'mediumseagreen', 'limegreen', 'forestgreen'
];

const PRESET_KEYS = Object.keys(PRESET_SPRITES);

const AI_TURN_RATE = Math.PI; // même vitesse de rotation que les joueurs humains
const AI_DETECTION_RADIUS = 256; // doit correspondre au FOG_RADIUS côté client
const WAYPOINT_QUEUE_SIZE = 5;
const WAYPOINT_ARRIVAL_RADIUS = 20;
const HEADING_TOLERANCE = 0.15; // radians -- en-dessous de ça, considéré aligné, arrête de tourner

function pickUnique(pool, count) {
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
}

function pickTwoDistinctColors() {
    const primary = AI_COLORS[Math.floor(Math.random() * AI_COLORS.length)];
    let secondary = AI_COLORS[Math.floor(Math.random() * AI_COLORS.length)];
    while (secondary === primary) {
        secondary = AI_COLORS[Math.floor(Math.random() * AI_COLORS.length)];
    }
    return { primary, secondary };
}

export function assignAIIdentities(count) {
    const names = pickUnique(AI_NAMES, Math.min(count, AI_NAMES.length));

    return Array.from({ length: count }, (_, i) => {
        const { primary, secondary } = pickTwoDistinctColors();
        const presetKey = PRESET_KEYS[Math.floor(Math.random() * PRESET_KEYS.length)];
        return {
            name: names[i] ?? `Bot ${i + 1}`, // repli si plus de bots que de noms disponibles
            primaryColor: primary,
            secondaryColor: secondary,
            sprite: PRESET_SPRITES[presetKey]
        };
    });
}

function cellOf(game, x, y) {
    return {
        cellX: Math.max(0, Math.min(game.width - 1, Math.floor(x / game.cellSize))),
        cellY: Math.max(0, Math.min(game.length - 1, Math.floor(y / game.cellSize)))
    };
}

function getOpenNeighbors(game, z, cellY, cellX) {
    const cell = game.maze[z][cellY][cellX];
    const neighbors = [];

    // Bounds-check every direction: a boundary cell's open-wall bits should
    // never point off the edge of the maze, but a crash here takes down the
    // whole server rather than just this one AI's pathfinding step, so this
    // doesn't trust that invariant.
    if (cell & Direction.North && cellY - 1 >= 0) neighbors.push({ z, cellY: cellY - 1, cellX });
    if (cell & Direction.South && cellY + 1 < game.length) neighbors.push({ z, cellY: cellY + 1, cellX });
    if (cell & Direction.East && cellX + 1 < game.width) neighbors.push({ z, cellY, cellX: cellX + 1 });
    if (cell & Direction.West && cellX - 1 >= 0) neighbors.push({ z, cellY, cellX: cellX - 1 });
    if (cell & Direction.Up && z - 1 >= 0) neighbors.push({ z: z - 1, cellY, cellX });
    if (cell & Direction.Down && z + 1 < game.height) neighbors.push({ z: z + 1, cellY, cellX });

    return neighbors;
}

function cellCenter(game, cellX, cellY) {
    return {
        x: cellX * game.cellSize + game.cellSize / 2,
        y: cellY * game.cellSize + game.cellSize / 2
    };
}

function refillWaypoints(game, tank) {
    if (!tank.aiWaypoints) tank.aiWaypoints = [];

    while (tank.aiWaypoints.length < WAYPOINT_QUEUE_SIZE) {
        const last = tank.aiWaypoints[tank.aiWaypoints.length - 1];
        const fromZ = last ? last.z : tank.z;
        const fromCell = last
            ? { cellY: last.cellY, cellX: last.cellX }
            : cellOf(game, tank.x, tank.y);

        const neighbors = getOpenNeighbors(game, fromZ, fromCell.cellY, fromCell.cellX);
        if (neighbors.length === 0) break; // ne devrait jamais arriver -- Wilson garantit au moins une sortie

        const next = neighbors[Math.floor(Math.random() * neighbors.length)];
        tank.aiWaypoints.push(next);
    }
}

function findVisiblePowerUp(game, tank) {
    for (const p of game.powerUps) {
        if (p.z !== tank.z) continue;
        const center = cellCenter(game, p.cellX, p.cellY);
        const dx = center.x - tank.x;
        const dy = center.y - tank.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= AI_DETECTION_RADIUS) return p;
    }
    return null;
}

function steerToward(tank, targetX, targetY, dt) {
    const dx = targetX - tank.x;
    const dy = targetY - tank.y;
    const desiredHeading = Math.atan2(dy, dx);

    let diff = desiredHeading - tank.heading;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;

    tank.input.turnLeft = false;
    tank.input.turnRight = false;
    tank.input.throttleUp = true;
    tank.input.throttleDown = false;

    if (Math.abs(diff) > HEADING_TOLERANCE) {
        if (diff > 0) tank.input.turnRight = true;
        else tank.input.turnLeft = true;
    }
}

function stopMoving(tank) {
    tank.input.turnLeft = false;
    tank.input.turnRight = false;
    tank.input.throttleUp = false;
    tank.input.throttleDown = false;
}

function findVisibleTarget(game, tank) {
    for (const other of game.tanks.values()) {
        if (other.isAI) continue;
        if (other.dead) continue;
        if (isAfk(other, game.started)) continue;
        if (other.z !== tank.z) continue;

        const dx = other.x - tank.x;
        const dy = other.y - tank.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= AI_DETECTION_RADIUS) return other;
    }
    return null;
}

function fireIfAligned(game, tank, targetX, targetY, trySpawnShot) {
    const dx = targetX - tank.x;
    const dy = targetY - tank.y;
    const angleToTarget = Math.atan2(dy, dx);

    let relative = angleToTarget - tank.heading;
    while (relative > Math.PI) relative -= 2 * Math.PI;
    while (relative < -Math.PI) relative += 2 * Math.PI;

    const quarterPi = Math.PI / 4;
    let direction = null;
    if (Math.abs(relative) <= quarterPi) direction = 'fireForward';
    else if (Math.abs(relative) >= Math.PI - quarterPi) direction = 'fireBack';
    else if (relative > 0) direction = 'fireRight';
    else direction = 'fireLeft';

    trySpawnShot(game, tank, direction);
}

export function updateAITank(game, tank, dt, trySpawnShot, computeDistances) {
    if (tank.dead || tank.transitioning) return;

    const target = findVisibleTarget(game, tank);

    if (target) {
        tank.aiState = 'hunt';
        tank.aiWaypoints = [];

        const targetCell = cellOf(game, target.x, target.y);
        const distances = computeDistances(game, [[target.z, targetCell.cellY, targetCell.cellX]]);
        const myCell = cellOf(game, tank.x, tank.y);
        const neighbors = getOpenNeighbors(game, tank.z, myCell.cellY, myCell.cellX);

        let bestNeighbor = null;
        let bestDist = Infinity;
        for (const n of neighbors) {
            const key = `${n.z},${n.cellY},${n.cellX}`;
            const d = distances.get(key);
            if (d !== undefined && d < bestDist) {
                bestDist = d;
                bestNeighbor = n;
            }
        }

        if (bestNeighbor) {
            const center = cellCenter(game, bestNeighbor.cellX, bestNeighbor.cellY);
            steerToward(tank, center.x, center.y, dt);
        } else {
            // No pathfinding step found this tick -- steering straight at the
            // target's raw position would ignore walls entirely and could
            // ram one repeatedly (self-inflicted, uncredited death). Hold
            // still; distances get recomputed fresh next tick.
            stopMoving(tank);
        }

        fireIfAligned(game, tank, target.x, target.y, trySpawnShot);
        return;
    }

    const powerUp = findVisiblePowerUp(game, tank);
    if (powerUp) {
        tank.aiState = 'seekPowerUp';
        tank.aiWaypoints = [];

        const distances = computeDistances(game, [[powerUp.z, powerUp.cellY, powerUp.cellX]]);
        const myCell = cellOf(game, tank.x, tank.y);
        const neighbors = getOpenNeighbors(game, tank.z, myCell.cellY, myCell.cellX);

        let bestNeighbor = null;
        let bestDist = Infinity;
        for (const n of neighbors) {
            const key = `${n.z},${n.cellY},${n.cellX}`;
            const d = distances.get(key);
            if (d !== undefined && d < bestDist) {
                bestDist = d;
                bestNeighbor = n;
            }
        }

        if (bestNeighbor) {
            const center = cellCenter(game, bestNeighbor.cellX, bestNeighbor.cellY);
            steerToward(tank, center.x, center.y, dt);
        } else {
            stopMoving(tank);
        }
        return;
    }

    tank.aiState = 'wander';
    refillWaypoints(game, tank);

    if (tank.aiWaypoints.length === 0) return;

    const waypoint = tank.aiWaypoints[0];
    const center = cellCenter(game, waypoint.cellX, waypoint.cellY);

    const dx = center.x - tank.x;
    const dy = center.y - tank.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < WAYPOINT_ARRIVAL_RADIUS && waypoint.z === tank.z) {
        tank.aiWaypoints.shift();
        return;
    }

    steerToward(tank, center.x, center.y, dt);
}
