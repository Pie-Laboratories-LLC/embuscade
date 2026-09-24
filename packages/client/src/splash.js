import splashUrl from './images/Splash.png';
import './splash.css';

let splashEl = null;
let handlers = { onJoin: null, onHelp: null };

function makeButton(label, getHandler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'splash-button';
    button.textContent = label;
    button.addEventListener('click', () => {
        const handler = getHandler();
        if (handler) handler();
    });
    return button;
}

function buildSplash(container) {
    const overlay = document.createElement('div');
    overlay.className = 'splash-overlay';

    const frame = document.createElement('div');
    frame.className = 'splash-frame';

    const image = document.createElement('img');
    image.className = 'splash-image';
    image.src = splashUrl;
    image.alt = 'Embuscade';
    image.draggable = false;

    const buttons = document.createElement('div');
    buttons.className = 'splash-buttons';
    buttons.appendChild(makeButton('Join', () => handlers.onJoin));
    buttons.appendChild(makeButton('Help', () => handlers.onHelp));

    frame.appendChild(image);
    frame.appendChild(buttons);
    overlay.appendChild(frame);
    container.appendChild(overlay);
    return overlay;
}

// container: mount()'s own root (.embuscade) -- appended there, not
// document.body, so this stays position:absolute-contained within
// whatever area the host gave the game (see embuscade.css's header
// comment) instead of covering the whole viewport, host page included.
export function showSplashScreen(container, { onJoin, onHelp }) {
    handlers = { onJoin, onHelp };
    if (!splashEl) {
        splashEl = buildSplash(container);
    } else if (!container.contains(splashEl)) {
        // A previous mount's container (and this element along with it) was
        // torn down by unmount()'s container.innerHTML = '' -- splashEl is a
        // detached orphan at this point (the module itself persists across
        // mount/unmount cycles since the host re-imports the same cached ES
        // module rather than re-executing it), so it needs re-parenting into
        // the new container rather than just having its display toggled.
        container.appendChild(splashEl);
    }
    splashEl.style.display = 'flex';
}

export function hideSplashScreen() {
    if (splashEl) splashEl.style.display = 'none';
}
