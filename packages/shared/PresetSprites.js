// packages/shared/PresetSprites.js
//
// Chaque sprite est une grille 32x32 de valeurs 0-3 :
//   0 = thème clair (le "blanc" de remplacement)
//   1 = thème foncé (le "gris foncé" de remplacement)
//   2 = couleur primaire du joueur
//   3 = couleur secondaire du joueur
// Le nez pointe vers +X (droite), cohérent avec le sens de heading=0 du char.

const SIZE = 32;
const TRANSPARENT = 4;
export { TRANSPARENT };

function emptyGrid() {
    return new Array(SIZE * SIZE).fill(TRANSPARENT);
}

function setPixel(grid, x, y, value) {
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
    grid[y * SIZE + x] = value;
}

function fillRect(grid, x0, y0, x1, y1, value) {
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            setPixel(grid, x, y, value);
        }
    }
}

function fillCircle(grid, cx, cy, r, value) {
    for (let y = -r; y <= r; y++) {
        for (let x = -r; x <= r; x++) {
            if (x * x + y * y <= r * r) {
                setPixel(grid, cx + x, cy + y, value);
            }
        }
    }
}

// --- Char (tank) ---
// Chenilles (thème foncé) en haut/bas, coque (primaire) au centre,
// tourelle + canon (secondaire) pointant vers +X.
function buildTank() {
    const g = emptyGrid();
    fillRect(g, 2, 2, 29, 6, 1);    // chenille haute
    fillRect(g, 2, 25, 29, 29, 1);  // chenille basse
    fillRect(g, 4, 9, 27, 22, 2);   // coque
    fillCircle(g, 16, 16, 7, 3);    // tourelle
    fillRect(g, 16, 14, 29, 17, 3); // canon
    return g;
}

// --- Voiture de course ---
// Carrosserie effilée (primaire), aileron arrière + cockpit (secondaire),
// contour thème foncé pour la lisibilité.
function buildRaceCar() {
    const g = emptyGrid();
    fillRect(g, 3, 10, 28, 21, 1);   // contour
    fillRect(g, 4, 11, 27, 20, 2);   // carrosserie
    fillRect(g, 22, 12, 27, 19, 3);  // nez effilé (avant, +X)
    fillRect(g, 5, 13, 11, 18, 3);   // cockpit + aileron arrière
    fillRect(g, 2, 8, 6, 11, 1);     // roue avant-gauche
    fillRect(g, 2, 20, 6, 23, 1);    // roue arrière-gauche
    fillRect(g, 25, 8, 29, 11, 1);   // roue avant-droite
    fillRect(g, 25, 20, 29, 23, 1);  // roue arrière-droite
    return g;
}

// --- Vaisseau spatial rigolo ---
// Fuselage bulbeux (primaire), ailerons triangulaires (secondaire),
// hublot (thème clair) au centre.
function buildSpaceship() {
    const g = emptyGrid();
    fillCircle(g, 16, 16, 11, 2);     // fuselage
    fillRect(g, 24, 10, 29, 14, 3);   // aileron avant-haut
    fillRect(g, 24, 18, 29, 22, 3);   // aileron avant-bas
    fillRect(g, 2, 13, 8, 19, 3);     // aileron arrière (queue)
    fillCircle(g, 19, 16, 4, 0);      // hublot
    fillCircle(g, 19, 16, 4, 1);      // contour du hublot (juste l'anneau)
    fillCircle(g, 19, 16, 3, 0);      // reperce le centre en clair
    return g;
}

export const PRESET_SPRITES = {
    tank: buildTank(),
    racecar: buildRaceCar(),
    spaceship: buildSpaceship()
};
