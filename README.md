# Non Ai Dev Note
I've said this many times on the repo, but if y'all got any good changes, please submit them, my coding ambitions are higher than my skill so atleast right now my stuff is very vibecoded
# ALEKS A11y Bridge

A Tampermonkey userscript that makes [ALEKS](https://www.aleks.com) math problems
**parseable and interactive** for browser automation agents — by promoting
ALEKS's custom widgets to real ARIA roles, mirroring its hidden math state into
readable text, and bridging automated clicks/typing into ALEKS's own editor
pipeline.

It does not solve problems and it does not bypass ALEKS's grading. It gives an
agent (or a human) a clean, deterministic interface to a page that otherwise
only works via screenshots and fragile synthetic input.

---

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome or Firefox.
2. Tampermonkey → **Dashboard** → **+** → paste the entire
   `aleks-a11y-bridge.user.js` → **Ctrl+S**.
3. Open ALEKS and start a problem. The console prints
   `[ALEKS-A11Y] Bridge active in …`.

There is nothing else to configure. The script runs in every frame of every
`aleks.com` subdomain (including `www-awu.aleks.com`).

---

## What problem this solves

ALEKS renders math in a bespoke way and accepts input through a custom editor
state machine. Out of the box, a DOM/accessibility-reading agent sees:

- **empty `<canvas>`** where math should be,
- **generic `<div>`/`<span>`** palette buttons with no role or name,
- **answer boxes whose typed value is ignored** unless the input arrives as the
  low-level key sequence ALEKS's editor expects.

This userscript converts all of that into:

- named buttons (`role="button"` + `aria-label`),
- labeled answer inputs (`aria-label="…"`, live `aria-valuetext`),
- reconstructed math text for every canvas / AnsedObject tree,
- a `window.ALEKSA11Y` API that types answers **through ALEKS's own editor code**,
  so they always render and register.

---

## Architecture

The script is a single self-contained IIFE. It must run **in the page context**
(`@grant none` + `@inject-into page`) and **at `document-start`** so its
`CanvasRenderingContext2D` hooks exist before ALEKS draws anything. `@noframes`
is deliberately absent so it boots in every nested iframe.

### The five mechanisms

| # | Mechanism | Implementation |
|---|-----------|----------------|
| 1 | Continuous observation | `MutationObserver({ childList:true, subtree:true })` on `document.body`, debounced `scan()` per added subtree, plus a per-frame `postMessage` bridge (`ALEKSA11Y.dumpAsync()` in the top frame) |
| 2 | Semantic promotion | `scoreButton`/`promoteButton` → `role="button"` + `tabindex="0"` + `aria-label` (from `title`/`data-*`/sprite class/background-image filename). `promoteTextbox`/`promoteNativeInput` → `role="textbox"` / labeled `Answer Input N`. Native `<button>`s are named via `labelButton` (textContent or id-suffix) |
| 3 | Math interception | `installCanvasHook` monkey-patches `fillText`/`strokeText`/`clearRect`/`drawImage` (+ `OffscreenCanvasRenderingContext2D`) at document-start and reconstructs reading order from `(x,y)`. `extractAnsedText`/`scheduleAnsed` reconstruct **AnsedObject** span math from `left`/`top` styles. `extractModelMeta` mirrors `data-*`/JS props into `data-aleks-meta` |
| 4 | Event bridging | `onCapturedClick` intercepts untrusted clicks on custom widgets and replays the full `pointerdown→mousedown→pointerup→mouseup→click` sequence at rect-center (native controls pass through). `typeInto` feeds characters through ALEKS's own `actionOnKey`/`actionOnCharacter`/`actionOnSingleton` |
| 5 | State reflection | `reflectState` reads the ansed tree / `getRecall()` / input value, strips ALEKS markup (`\editbox;` `\neg;` `%infinity;` …), and writes `aria-valuetext` + `data-aleks-value`, firing `aleks-a11y:statechange` |

### What ALEKS actually looks like (reverse-engineered)

These facts drive the whole design and are useful if you extend the script:

- **Answer boxes** are native `<input class="ansed_input">` elements nested
  **inside** `div.ansed_root > div.ansed_tree`. Their `value` property is a
  static placeholder (`"( f + g ) ( x ) = empty input box"`) that ALEKS **never
  updates** — it is not a source of truth.
- **Math is DOM spans, not canvas.** ALEKS renders math as absolutely-positioned
  `<span class="AnsedObject">` nodes (`left`/`top` inline styles). Sorting them
  by `(top, left)` reconstructs reading order.
- **The editor API is public.** `window.ait.ansed` exposes the live editors:
  - `ait.ansed.ansedList` — array of editor instances; entry `_name` maps 1:1 to
    an input id (`ansed_input_<name>`).
  - `AnswerEditor` methods: `focus()`, `clear()`, `getRecall()`, `actionOnKey(event)`,
    `actionOnCharacter(char, class)`, `actionOnSpecialKey({eventKeyCode})`,
    `actionOnSingleton('infinity'|'neginfinity'|'union'|…)`.
  - `ait.ansed.object.Infinity` / `Union` etc. are the node classes.
- **`getRecall()` is the truth.** It returns ALEKS's internal representation
  (e.g. `\editbox;[\neg;[4][[x]^[2]]+5]` = −4x²+5). This is what the script
  verifies against, and what ALEKS grades.
- **Caret semantics.** After `^` (exponent) and after a fraction denominator,
  the caret stays *inside* until ArrowRight — exactly like a human typist.
- **Palette buttons** (`menubar_*_ansed_*`) are native buttons bound to a
  *specific editor*, so programmatic focus does not redirect them — which is why
  typing symbols is done through `actionOnSingleton` rather than clicking.

---

## Public API — `window.ALEKSA11Y`

Available in every frame (page context). `ALEKSA11Y.help()` prints a live cheat
sheet.

| Method | Purpose |
|---|---|
| `ALEKSA11Y.version` | Script version |
| `.textboxes()` | `[{ label, value, kind }]` for every detected answer box |
| `.buttons(filter?)` | Detected buttons `[{ label, visible, native }]` |
| `.type(text, { target, clear, latex? })` | Type into a box **through ALEKS's own editor** |
| `.verify()` | Result of the last `type()`: `{ method, verified, before, after }` |
| `.key('ArrowRight'|'Enter'|…, target?)` | Dispatch a special key through the editor |
| `.palette('fraction'|'sqrt'|'infinity'|…)` | Bridge-click a palette button by name |
| `.click('Check'|label|index|el)` | Bridge-click a button |
| `.clickAt(x, y)` | Full mouse sequence at page coordinates (graphs/number lines) |
| `.editorFor(target)` | Whether the direct-editor path resolved for a box |
| `.snapshot()` / `.dump()` | Compact / full diagnostics (dump includes raw HTML context) |
| `.save('name')` | Download a diagnostic JSON (for selector hardening) |
| `.highlight(true)` | Outline promoted elements (visual verification) |
| `.refresh()` / `.rescan()` | Re-read canvas/ansed state / re-scan the DOM |
| `.config` | Live config (mutable) |

### Typing syntax

`ALEKSA11Y.type('-4x^2{RIGHT}+5', { target: 'Formula for f + g:', clear: true })`

- `{RIGHT}` `{LEFT}` `{BACKSPACE}` `{ENTER}` `{TAB}` `{DELETE}` `{HOME}` `{END}` `{ESC}` `{SPACE}`
  dispatch the matching special key through ALEKS's editor.
- **Interval shorthand is auto-translated**: `inf`/`-inf` → ∞ / −∞, `∪` (or
  `\cup`) → union. So `type('(-inf,0)∪(0,inf)')` produces a correct domain answer.
- `clear:true` clears the box first; `latex:true` is an experimental LaTeX mode.

### The "absorb" bridge

Some agents (e.g. extensions with no key/JS tool) can only **set an input's
value** directly, which ALEKS ignores. The script polls `ansed_input` values and,
whenever a value changes but ALEKS's `getRecall()` did not, replays the text
through the editor (auto-exiting exponents and fractions, translating `inf`/`∪`).
This makes even a naive `set`-value agent produce real math.

---

## Config (`ALEKSA11Y.config`)

```js
{
  debounceMs: 90, canvasFlushMs: 250, canvasPollMs: 2000,
  canvasLineTolerance: 4, canvasGlyphGap: 8, ansedLineTolerance: 3,
  scanCap: 6000, buttonMinScore: 4, textboxMinScore: 3, maxButtonTextLength: 60,
  promote: { buttons:true, textboxes:true, svg:true, choices:true, nativeButtons:true, ansed:true },
  highlight: false, debug: false,
  extraButtonSelectors: [], extraTextboxSelectors: []
}
```

- `extraButtonSelectors` / `extraTextboxSelectors` pin exact CSS selectors after a
  DOM-dump refinement pass (ALEKS drifts between versions).
- `buttonMinScore` / `textboxMinScore` tune the promotion heuristics.

---

## Developer workflow

### Debugging

```js
ALEKSA11Y.dump()           // buttons/inputs/canvases/ansedTrees + raw HTML context
ALEKSA11Y.snapshot()       // compact agent view
ALEKSA11Y.highlight(true)  // outline everything promoted
ALEKSA11Y.save('name')     // download JSON (send to a maintainer to harden selectors)
```

Hotkeys (top frame): `Alt+Shift+A` panel · `Alt+Shift+H` highlight ·
`Alt+Shift+D` dump · `Alt+Shift+S` save.

A hidden status marker (`#aleks-a11y-status`, off-screen but in the DOM text) lets
a headless agent confirm the script is alive and shows the last bridge action:

```
ALEKS A11y Bridge active v0.4.0 | inputs: 4 | buttons: 207 | ansedSpans: 26 | lastBridge: absorb "…"
```

### Verifying state without the DOM

```js
// ALEKS's own internal state (authoritative):
ait.ansed.ansedList.find(x => x._name === '<editor name>').getRecall()
```

### Testing a change

1. Re-paste the script, reload ALEKS.
2. `ALEKSA11Y.verify()` after a `type()` gives `{ method, verified, before, after }`.
3. `verified: true` means the typed text landed in `getRecall()`.

See `TESTING.md` in the repo root for a full test plan (audit one-shot,
per-mechanism checks, agent session checklist).

---

## Injection contract (do not change casually)

- `@grant none` — the script runs in the **page context**. Any `@grant GM_*`
  moves it into Tampermonkey's sandbox realm, whose `CanvasRenderingContext2D`
  prototype is *different* from the page's, silently breaking the canvas hooks.
- `@inject-into page` — makes page-context injection explicit (Firefox).
- `@run-at document-start` — canvas hooks must exist before ALEKS draws.
- No `@noframes` — ALEKS may render problems in nested iframes.
- `@match *://*.aleks.com/*` (+ bare domain) — matches every subdomain.

---

## Limitations

- **Canvas text reconstruction** is best-effort; ALEKS mostly renders via
  AnsedObject spans, which is the reliable path. Tune
  `canvasLineTolerance`/`canvasGlyphGap`/`ansedLineTolerance` for odd cases.
- **AnsedObject reconstruction flattens** 2-D structures (fraction stacks,
  matrices) into a single line.
- **Palette buttons are per-editor** and not reliably clickable programmatically;
  the script inserts symbols through `actionOnSingleton` instead. Symbols not
  covered by the shorthand (√, π, ≤, ≥) still require the palette or the
  experimental LaTeX mode.
- ALEKS changes its DOM between versions; re-run `dump()` after major UI updates
  and pin selectors.
- For your own account and your institution's academic-integrity rules.

## License

MIT — see `LICENSE`.
