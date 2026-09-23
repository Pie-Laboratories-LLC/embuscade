// Position des icônes montée/descente dans une cellule -- utilisé à la fois
// côté serveur (point de déclenchement de la transition) et côté client
// (rendu des flèches), d'où son emplacement dans shared plutôt que dupliqué.
//
// Centré verticalement toujours. Si une seule direction est ouverte, l'icône
// est centrée horizontalement. Si les deux sont ouvertes, chacune est
// décalée de 32px du centre de la cellule (donnant un espacement de 32px
// entre les deux icônes de 32px de large).
export function getVerticalIcons(cellSize, cellX, cellY, cell, Direction) {
    const centerX = cellX * cellSize + cellSize / 2;
    const centerY = cellY * cellSize + cellSize / 2;
    const up = !!(cell & Direction.Up);
    const down = !!(cell & Direction.Down);
    const icons = [];

    if (up && down) {
        icons.push({ dir: 'up', x: centerX - 32, y: centerY });
        icons.push({ dir: 'down', x: centerX + 32, y: centerY });
    } else if (up) {
        icons.push({ dir: 'up', x: centerX, y: centerY });
    } else if (down) {
        icons.push({ dir: 'down', x: centerX, y: centerY });
    }

    return icons;
}
