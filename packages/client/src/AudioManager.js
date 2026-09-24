const SOUND_FILES = {
    shot: '/sounds/528262__magnuswaker__silenced-shot.wav',
    hit: '/sounds/420673__sypherzent__basic-melee-hit.wav',
    wall: '/sounds/743259__qubodup__short-rusty-metal-scrape.wav',
    explosion: '/sounds/609587__unfa__grenade-explosion-sfx-medium-sized-meaty-realistic.wav',
    collision: '/sounds/812592__qubodup__clang.wav',
    // power-up sounds slotteront ici plus tard: missile, doubleBarrel,
    // ram, sprayOil, slipOil -- même mécanisme, juste de nouvelles clés
};

const PROXIMITY_RANGE_CELLS = 2;

let audioContext = null;
const buffers = new Map(); // clé de son -> AudioBuffer décodé
let cellSize = 128; // écrasé par setCellSize() une fois le labyrinthe connu

export async function initAudio(actualCellSize) {
    if (actualCellSize) cellSize = actualCellSize;
    if (audioContext) return;

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    window.__lobo_audioContext = audioContext; // debug temporaire

    await Promise.all(
        Object.entries(SOUND_FILES).map(async ([key, url]) => {
            try {
                const response = await fetch(url);
                const arrayBuffer = await response.arrayBuffer();
                const decoded = await audioContext.decodeAudioData(arrayBuffer);
                buffers.set(key, decoded);
            } catch (err) {
                console.warn(`Failed to load sound "${key}" from ${url}:`, err);
            }
        })
    );
}

// Les navigateurs bloquent l'audio tant qu'aucune interaction utilisateur
// n'a eu lieu -- à appeler depuis un gestionnaire de clic (ex: le bouton
// "Join" ou "Create Game"), pas automatiquement au chargement.
export function resumeAudioContext() {
    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume();
    }
}

function distance3D(x1, y1, z1, x2, y2, z2) {
    if (z1 !== z2) return Infinity; // étages différents -- jamais audible
    const dx = x2 - x1;
    const dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
}

export function playPositional(soundKey, worldX, worldY, worldZ, listenerX, listenerY, listenerZ) {
    if (!audioContext || audioContext.state !== 'running') return;

    const buffer = buffers.get(soundKey);
    if (!buffer) return;

    const dist = distance3D(worldX, worldY, worldZ, listenerX, listenerY, listenerZ);
    const maxDist = PROXIMITY_RANGE_CELLS * cellSize;
    if (dist >= maxDist) return; // hors de portée, ne joue rien du tout

    const volume = Math.max(0, 1 - dist / maxDist);

    const source = audioContext.createBufferSource();
    source.buffer = buffer;

    const gainNode = audioContext.createGain();
    gainNode.gain.value = volume;

    source.connect(gainNode);
    gainNode.connect(audioContext.destination);
    source.start(0);
}
