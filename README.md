# justinas.space

WebGL pieces by Justinas. A Vite multi-page site: every piece is its own page, and all of them share one small UI kit.

## Working on it

```sh
npm install        # once
npm run dev        # local dev server with hot reload, http://localhost:5173
npm run build      # the finished site goes to dist/
npm run preview    # serve dist/ locally to check the build before uploading
```

## Uploading

Upload the **contents** of `dist/` to the web root over FTP (including the hidden `.htaccess`).
Upload `assets/` first and the `.html` files last, so nobody gets a page that points at files that aren't there yet.
Old files in `assets/` can be deleted now and then; their names change with every build.

## Where things are

| Path | What it is |
| --- | --- |
| `index.html` | the root page: Born from white |
| `cursor-light/`, `hold-space/`, `aurora/`, `falling-in/`, `giant/` (each an `index.html`) | the other pieces |
| `src/pieces/*.js` | each piece's code (its CONFIG block is at the top) |
| `src/experiences.js` | the list of pieces: order, titles, descriptions, about text |
| `src/site.js` | your name and the X / GitHub links |
| `src/ui/ui.css`, `src/ui/ui.js` | the shared UI kit: tokens, signature, navigation, hint, message, controls, room index |
| `public/` | copied to `dist/` as is: `.htaccess`, favicon |
| `404.html` | page for missing URLs (Apache serves it via `.htaccess`) |
| `pages/` | the original concepts, untouched, for reference |

## Adding a piece

1. Make a folder named after the URL, e.g. `my-piece/index.html` (copy `hold-space/index.html` and change the title, description and script path).
2. Put the code in `src/pieces/my-piece.js` and start it with:
   ```js
   import { mountUI } from '../ui/ui.js';
   const ui = mountUI({ id: 'my-piece' });
   ```
3. Add an entry to `src/experiences.js`. The build and the navigation pick it up from there.

A piece in a different style gets its own `theme` in the registry and a token block `[data-theme='…']` in `src/ui/ui.css`.

## UI kit API

```js
ui.hint('hold space');                     // set the hint text
ui.showHint(true);                         // show / hide it
ui.message('4.2 light-years from home', { duration: 5.5 });  // transient line; message(null) hides it
ui.tone('light');                          // dark ink for bright art; 'dark' (default) for dark art
ui.controls([
  { type: 'toggle', label: 'sound', value: false, onChange: (on) => {} },
  { type: 'range', label: 'speed', min: 0, max: 1, value: 0.5, onChange: (v) => {} },
  { type: 'button', label: 'reset', onClick: () => {} },
]);
ui.reveal();                               // fade the UI in after mountUI({ hidden: true })
if (ui.isUiTarget(event)) return;          // in the piece's own pointer handlers
```

Keys: ← → move between rooms, Esc closes the room index. Space is left to the pieces.
The UI dims to 16% after 3 seconds without input.

Debug flags from the original concepts still work, e.g. `/?t=20`, `/hold-space/?dest=nebula`, `/falling-in/?r=3`, `?nowebgl`, `?reduced`, `?fps`.
