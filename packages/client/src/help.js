import { marked } from 'marked';
import howToPlayMarkdown from '../../../How-To-Play.md?raw';
import './help.css';

// How-To-Play.md lives at the repo root, so image paths in it are
// relative to the repo root (e.g. docs/Join-Game.png).
const REPO_ROOT_PREFIX = '../../../';

const docImages = import.meta.glob(
    '../../../docs/**/*.{png,jpg,jpeg,gif,webp,svg}',
    { eager: true, query: '?url', import: 'default' }
);

const imageUrlsByRepoPath = new Map(
    Object.entries(docImages).map(([path, url]) => [path.slice(REPO_ROOT_PREFIX.length), url])
);

let helpEl = null;

function onKeyDown(event) {
    if (event.key === 'Escape') hideHelpModal();
}

// Resolves an image src relative to How-To-Play.md at the repo root.
function resolveRepoPath(src) {
    return decodeURIComponent(new URL(src, 'http://repo/').pathname.slice(1));
}

function rewriteContent(fragment) {
    for (const img of fragment.querySelectorAll('img')) {
        const src = img.getAttribute('src');
        if (!src || /^(https?:|data:)/.test(src)) continue;
        const url = imageUrlsByRepoPath.get(resolveRepoPath(src));
        if (url) {
            img.setAttribute('src', url);
        } else {
            console.warn(`[help] image not found: ${src} (known: ${[...imageUrlsByRepoPath.keys()].join(', ')})`);
        }
    }
    for (const link of fragment.querySelectorAll('a[href^="http"]')) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
    }
}

function buildHelp() {
    const overlay = document.createElement('div');
    overlay.className = 'help-overlay';
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) hideHelpModal();
    });

    const panel = document.createElement('div');
    panel.className = 'help-panel';

    const header = document.createElement('div');
    header.className = 'help-header';

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'help-close';
    closeButton.textContent = 'Close';
    closeButton.addEventListener('click', hideHelpModal);
    header.appendChild(closeButton);

    const body = document.createElement('div');
    body.className = 'help-body';

    // Render into an inert template so the browser never fetches the
    // un-rewritten relative image paths.
    const template = document.createElement('template');
    template.innerHTML = marked.parse(howToPlayMarkdown);
    rewriteContent(template.content);
    body.appendChild(template.content);

    panel.appendChild(header);
    panel.appendChild(body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    return overlay;
}

export function showHelpModal() {
    if (!helpEl) helpEl = buildHelp();
    helpEl.style.display = 'flex';
    helpEl.querySelector('.help-body').scrollTop = 0;
    document.addEventListener('keydown', onKeyDown);
}

export function hideHelpModal() {
    if (helpEl) helpEl.style.display = 'none';
    document.removeEventListener('keydown', onKeyDown);
}
