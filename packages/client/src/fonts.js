import stardosStencilUrl from './fonts/StardosStencil-Regular.ttf';

export const STENCIL_FONT_FAMILY = 'Stardos Stencil';

export function loadFonts() {
    const stencil = new FontFace(STENCIL_FONT_FAMILY, `url(${stardosStencilUrl})`);
    return stencil.load()
        .then((loaded) => {
            document.fonts.add(loaded);
            console.log(`[fonts] ${STENCIL_FONT_FAMILY} loaded`);
        })
        .catch((err) => {
            console.error(`[fonts] ${STENCIL_FONT_FAMILY} failed to load, falling back`, err);
        });
}
