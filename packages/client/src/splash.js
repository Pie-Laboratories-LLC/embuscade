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

function buildSplash() {
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
    document.body.appendChild(overlay);
    return overlay;
}

export function showSplashScreen({ onJoin, onHelp }) {
    handlers = { onJoin, onHelp };
    if (!splashEl) splashEl = buildSplash();
    splashEl.style.display = 'flex';
}

export function hideSplashScreen() {
    if (splashEl) splashEl.style.display = 'none';
}
