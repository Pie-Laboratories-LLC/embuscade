// Sounds live in public/, served at the site root in dev (vite serves
// public/ from '/') but at wherever the built embuscade.js itself ends up
// (site root standalone, /widgets/embuscade-vendor/ when vendored into
// widgetgrid -- see EmbuscadeWidget.vue's VENDOR_BASE) once bundled, since
// dist/ mirrors public/ 1:1 next to embuscade.js. import.meta.env.DEV is
// baked in at build time, so the vendored bundle (always built, never
// served via `vite dev`) correctly resolves against its own location.
const SOUND_BASE = import.meta.env.DEV ? '/' : new URL('.', import.meta.url).href;

const SOUND_FILES = {
    shot: `${SOUND_BASE}sounds/528262__magnuswaker__silenced-shot.wav`,
    hit: `${SOUND_BASE}sounds/420673__sypherzent__basic-melee-hit.wav`,
    wall: `${SOUND_BASE}sounds/743259__qubodup__short-rusty-metal-scrape.wav`,
    explosion: `${SOUND_BASE}sounds/609587__unfa__grenade-explosion-sfx-medium-sized-meaty-realistic.wav`,
    collision: `${SOUND_BASE}sounds/812592__qubodup__clang.wav`,
    readyFight: `${SOUND_BASE}sounds/406622__xemptful__ready-trimmed.wav`,
    gobblePowerUp: `${SOUND_BASE}sounds/258020__kodack__arcade-bleep-sound.wav`
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

// Non-positional: full volume for everyone regardless of tank position --
// for cues like a round starting, not events happening at a world location.
export function playSound(soundKey) {
    if (!audioContext || audioContext.state !== 'running') return;

    const buffer = buffers.get(soundKey);
    if (!buffer) return;

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.start(0);
}
