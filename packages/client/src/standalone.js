// Standalone dev page (index.html): the game on its own, talking straight
// to a locally running server. A host page (e.g. widgetgrid) imports
// mount() from the built dist/embuscade.js instead and passes its own
// wsUrl -- see main.js.
import { mount } from './main.js';

mount(document.getElementById('app'), { wsUrl: 'ws://localhost:8082' });
