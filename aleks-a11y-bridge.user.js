// ==UserScript==
// @name         ALEKS A11y Bridge — Parseable & Interactive DOM for Browser Agents
// @namespace    aleks-a11y-bridge
// @version      0.4.3
// @description  Makes ALEKS parseable and interactive: promotes div/span palette buttons and math inputs to real ARIA roles, mirrors canvas-drawn math into text, and bridges automated clicks/typing into ALEKS's low-level pointer/mouse/key event pipeline. Runs in every frame.
// @match        https://*.aleks.com/*
// @match        http://*.aleks.com/*
// @match        https://aleks.com/*
// @match        http://aleks.com/*
// @grant        none
// @inject-into  page
// @run-at       document-start
// @license      MIT
// ==/UserScript==

/* ============================================================================
   INJECTION CONTRACT (do not change without reading this)

   1. @grant none        -> script runs in the PAGE context. This is REQUIRED:
                            the CanvasRenderingContext2D monkey-patch must live in
                            ALEKS's own JS realm, or ALEKS's canvases won't be
                            observable. (@grant GM_* would put us in a sandbox
                            realm with a *different* prototype chain.)
   2. @run-at document-start -> patch canvas APIs before ALEKS draws anything.
   3. @noframes is DELIBERATELY ABSENT -> the script boots inside every nested
                            iframe so it reaches the problem-rendering frame(s).
   4. The spec's "@match *://*://*" is malformed; the patterns above are the
      corrected equivalents (ALEKS only, all subdomains, every frame).

   The five spec mechanisms map to sections below:
     M1 Continuous observation ............ whenReady / boot / MutationObserver
     M2 Semantic promotion ............... scoreButton / promoteButton /
                                          promoteTextbox / promoteNativeInput
     M3 Canvas interception .............. installCanvasHook / flushCanvas /
                                          extractSvg / extractModelMeta
     M4 Event bridging ................... onCapturedClick / bridgeClick /
                                          typeInto / fallbackKeyType / clickAt
     M5 Live answer-state reflection ..... reflectState / applyCanvasMath

   Console API (every frame): window.ALEKSA11Y  ->  .help() for the full list.
   ========================================================================== */

(function () {
  'use strict';

  if (window.__aleksA11yBooted) return;
  window.__aleksA11yBooted = true;

  /* ------------------------------------------------------------------ */
  /* CONFIG — tune live via ALEKSA11Y.config                            */
  /* ------------------------------------------------------------------ */
  const SCRIPT_VERSION = '0.4.3';
  const cfg = {
    debounceMs: 90,            // MutationObserver batch delay
    canvasFlushMs: 250,        // debounce between last canvas draw and text extraction
    canvasPollMs: 2000,        // safety re-flush interval
    canvasLineTolerance: 4,    // px: y-difference that still counts as "same line"
    canvasGlyphGap: 8,         // px: x-gap above which we insert a space between runs
    scanCap: 6000,             // max elements examined per scan phase
    buttonMinScore: 4,         // heuristic threshold for role="button" promotion
    textboxMinScore: 3,        // heuristic threshold for role="textbox" promotion
    maxButtonTextLength: 60,
    promote: { buttons: true, textboxes: true, svg: true, choices: true, nativeButtons: true, ansed: true },
    ansedLineTolerance: 3,     // px: line clustering for AnsedObject span math
    highlight: false,
    debug: false,
    // After the DOM-dump refinement step, pin ALEKS's real class names here:
    extraButtonSelectors: [],   // e.g. ['.aleks-palette-img', '#btnCheck']
    extraTextboxSelectors: []   // e.g. ['.answerBox']
  };

  /* ------------------------------------------------------------------ */
  /* Small utils                                                        */
  /* ------------------------------------------------------------------ */
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function cleanText(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  function clsOf(el) {
    try { return el.getAttribute ? (el.getAttribute('class') || '') : ''; }
    catch (e) { return ''; }
  }

  function cleanTextOf(el) {
    // textContent minus our own injected sr-only mirrors
    try {
      const clone = el.cloneNode(true);
      const own = clone.querySelectorAll ? clone.querySelectorAll('[data-aleks-a11y-own]') : [];
      for (const n of own) n.remove();
      return cleanText(clone.textContent);
    } catch (e) { return cleanText(el.textContent); }
  }

  function depthOf(el) {
    let d = 0, n = el;
    while (n && n.parentElement && d < 200) { d++; n = n.parentElement; }
    return d;
  }

  function humanize(s) {
    return String(s)
      .replace(/\.(png|gif|jpg|jpeg|svg|webp)$/i, '')
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
      .toLowerCase().trim();
  }

  const TOKEN_NAMES = {
    frac: 'fraction', sqrt: 'square root', root: 'radical', rad: 'radical',
    radical: 'radical', exp: 'exponent', exponent: 'exponent', sup: 'superscript',
    superscript: 'superscript', sub: 'subscript', subscript: 'subscript',
    pi: 'π', theta: 'θ', mu: 'μ', lambda: 'λ', deg: 'degree', degree: 'degree',
    enter: 'Enter', undo: 'Undo', redo: 'Redo', bksp: 'Backspace',
    backspace: 'Backspace', left: 'Left arrow', right: 'Right arrow',
    up: 'Up arrow', down: 'Down arrow', plus: '+', minus: '−', times: '×',
    div: '÷', cdot: '·', ne: '≠', neq: '≠', le: '≤', leq: '≤', ge: '≥', geq: '≥'
  };

  function whenReady(fn) {
    if (document.body) { fn(); return; }
    if (document.documentElement) {
      const mo = new MutationObserver(() => {
        if (document.body) { mo.disconnect(); fn(); }
      });
      mo.observe(document.documentElement, { childList: true });
      return;
    }
    const t = setInterval(() => {
      if (document.documentElement) { clearInterval(t); whenReady(fn); }
    }, 10);
  }

  function injectStyles() {
    try {
      const st = document.createElement('style');
      st.setAttribute('data-aleks-a11y-own', '1');
      st.textContent =
        '.aleks-a11y-math{position:absolute!important;width:1px!important;height:1px!important;' +
        'margin:-1px!important;padding:0!important;border:0!important;clip:rect(0 0 0 0)!important;' +
        'clip-path:inset(50%)!important;overflow:hidden!important;white-space:nowrap!important}' +
        '[data-aleks-a11y="button"].aleks-a11y-hl{outline:2px dashed #00b3ff!important;outline-offset:1px!important}' +
        '[data-aleks-a11y="textbox"].aleks-a11y-hl,[data-aleks-a11y="input"].aleks-a11y-hl{outline:2px solid #ff4fd8!important;outline-offset:1px!important}' +
        '[aria-checked="true"].aleks-a11y-hl{outline-color:#3dff7a!important}';
      (document.head || document.documentElement).appendChild(st);
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* M3 (part 1): Canvas hook — must run synchronously at document-start */
  /* ------------------------------------------------------------------ */
  function installCanvasHook() {
    try {
      const proto = CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
      if (!proto || proto.__aleksA11yHooked) return;
      proto.__aleksA11yHooked = true;

      const origFill = proto.fillText;
      const origStroke = proto.strokeText;
      const origClear = proto.clearRect;

      proto.fillText = function (text, x, y) {
        try { recordDraw(this, text, x, y, 'fill'); } catch (e) {}
        return origFill.call(this, text, x, y, arguments[3]);
      };
      proto.strokeText = function (text, x, y) {
        try { recordDraw(this, text, x, y, 'stroke'); } catch (e) {}
        return origStroke.call(this, text, x, y, arguments[3]);
      };
      // A full-canvas clear usually means "new problem render" -> drop stale text
      proto.clearRect = function (x, y, w, h) {
        try {
          const c = this.canvas;
          if (c && c.__aleksA11yItems && (w >= c.width * 0.9 || h >= c.height * 0.9)) {
            c.__aleksA11yItems.clear();
          }
        } catch (e) {}
        return origClear.call(this, x, y, w, h);
      };
      // ALEKS often renders math text onto an offscreen canvas, then blits it
      // with drawImage. Chain the captured text metadata onto the destination.
      const origDraw = proto.drawImage;
      proto.drawImage = function (src) {
        try {
          const dst = this.canvas;
          if (dst && src && src.__aleksA11yItems && src.__aleksA11yItems.size) {
            if (!dst.__aleksA11yItems) dst.__aleksA11yItems = new Map();
            for (const entry of src.__aleksA11yItems) dst.__aleksA11yItems.set(entry[0], entry[1]);
            noteCanvasDraw(dst);
          }
        } catch (e) {}
        return origDraw.apply(this, arguments);
      };
    } catch (e) {}

    // Same hooks for OffscreenCanvas (worker-rendered math)
    try {
      const op = (typeof OffscreenCanvasRenderingContext2D !== 'undefined') && OffscreenCanvasRenderingContext2D.prototype;
      if (op && !op.__aleksA11yHooked) {
        op.__aleksA11yHooked = true;
        const oFill = op.fillText, oStroke = op.strokeText, oDraw = op.drawImage;
        op.fillText = function (text, x, y) {
          try { recordOffscreen(this, text, x, y); } catch (e) {}
          return oFill.call(this, text, x, y, arguments[3]);
        };
        op.strokeText = function (text, x, y) {
          try { recordOffscreen(this, text, x, y); } catch (e) {}
          return oStroke.call(this, text, x, y, arguments[3]);
        };
        op.drawImage = function (src) {
          try {
            const dst = this.canvas;
            if (dst && src && src.__aleksA11yItems && src.__aleksA11yItems.size) {
              if (!dst.__aleksA11yItems) dst.__aleksA11yItems = new Map();
              for (const entry of src.__aleksA11yItems) dst.__aleksA11yItems.set(entry[0], entry[1]);
            }
          } catch (e) {}
          return oDraw.apply(this, arguments);
        };
      }
    } catch (e) {}
  }

  function recordDraw(ctx, text, x, y, kind) {
    if (text === undefined || text === null || text === '') return;
    const c = ctx.canvas;
    if (!c) return;
    let m = c.__aleksA11yItems;
    if (!m) { m = c.__aleksA11yItems = new Map(); }
    if (m.size > 8000) return; // sanity cap
    m.set((x | 0) + ',' + (y | 0) + ':' + text, { t: String(text), x: +x, y: +y, k: kind });
    noteCanvasDraw(c);
  }

  function recordOffscreen(ctx, text, x, y) {
    if (text === undefined || text === null || text === '') return;
    const c = ctx.canvas;
    if (!c) return;
    let m = c.__aleksA11yItems;
    if (!m) m = c.__aleksA11yItems = new Map();
    if (m.size > 8000) return;
    m.set((x | 0) + ',' + (y | 0) + ':' + text, { t: String(text), x: +x, y: +y, k: 'offscreen' });
  }
  installCanvasHook();

  /* ------------------------------------------------------------------ */
  /* M3 (part 2): canvas flush + reconstruction                          */
  /* ------------------------------------------------------------------ */
  const canvasQueue = new Set();
  let flushTimer = null;

  function noteCanvasDraw(c) { canvasQueue.add(c); scheduleFlush(); }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flushAll(); }, cfg.canvasFlushMs);
  }

  function flushAll() {
    for (const c of canvasQueue) { try { flushCanvas(c); } catch (e) {} }
    canvasQueue.clear();
  }

  function clusterLines(items, tol) {
    const sorted = items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const it of sorted) {
      let line = lines[lines.length - 1];
      if (!line || Math.abs(it.y - line.y) > tol) { line = { y: it.y, items: [] }; lines.push(line); }
      line.items.push(it);
    }
    for (const line of lines) line.items.sort((a, b) => a.x - b.x);
    return lines;
  }

  function joinLine(items) {
    let out = '', prevX = -Infinity;
    for (const it of items) {
      if (prevX > -Infinity && it.x - prevX > cfg.canvasGlyphGap) out += ' ';
      out += it.t;
      prevX = it.x;
    }
    return out;
  }

  function srSpanFor(el) {
    let s = el.__aleksA11ySpan;
    if (!s || !s.isConnected) {
      s = document.createElement('span');
      s.className = 'aleks-a11y-math';
      s.setAttribute('data-aleks-a11y-own', '1');
      try { el.insertAdjacentElement('afterend', s); } catch (e) { return null; }
      el.__aleksA11ySpan = s;
    }
    return s;
  }

  function flushCanvas(c) {
    const m = c.__aleksA11yItems;
    if (!m || !m.size) return;
    const items = [...m.values()];
    const lines = clusterLines(items, cfg.canvasLineTolerance);
    const text = lines.map(l => joinLine(l.items)).join('\n');
    if (!text) return;
    applyCanvasMath(c, text);
  }

  function applyCanvasMath(c, text) {
    try {
      if (!c.isConnected) return;
      c.setAttribute('role', 'img');
      c.setAttribute('aria-label', text.slice(0, 1000));
      c.setAttribute('data-parsed-math', text.slice(0, 1000));
      c.__aleksA11yLastText = text;
      const span = srSpanFor(c);
      if (span && span.textContent !== text) span.textContent = text;
      if (!c.__aleksA11yMetaDone) { c.__aleksA11yMetaDone = true; extractModelMeta(c); }
      const tb = c.closest('[data-aleks-a11y="textbox"], [data-aleks-a11y="input"]');
      if (tb) reflectState(tb);
      try { c.dispatchEvent(new CustomEvent('aleks-a11y:mathupdate', { bubbles: true, detail: { text } })); } catch (e) {}
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* M3 (part 4): AnsedObject math — ALEKS's real renderer              */
  /* Modern ALEKS renders math as absolutely-positioned <span
     class="AnsedObject"> nodes inside div.ansed_root > div.ansed_tree.
     Sort by (top, left) to rebuild reading order.                        */
  /* ------------------------------------------------------------------ */
  function extractAnsedText(container) {
    try {
      const spans = container.querySelectorAll('.AnsedObject');
      if (!spans.length) return '';
      const items = [];
      for (const s of spans) {
        const txt = cleanText(s.textContent);
        if (!txt) continue;
        const st = s.style || {};
        let left = parseFloat(st.left), top = parseFloat(st.top);
        if (isNaN(left)) left = 0;
        if (isNaN(top)) top = 0;
        items.push({ t: txt, x: left, y: top });
      }
      if (!items.length) return '';
      const lines = clusterLines(items, cfg.ansedLineTolerance);
      return lines.map(l => joinLine(l.items)).join(' ').replace(/\s+/g, ' ').trim();
    } catch (e) { return ''; }
  }

  function scheduleAnsed(container) {
    if (!cfg.promote.ansed) return;
    try {
      clearTimeout(container.__aleksA11yAnsedT);
      container.__aleksA11yAnsedT = setTimeout(() => {
        const text = extractAnsedText(container);
        container.__aleksA11yAnsedText = text;
        if (text) {
          container.setAttribute('data-parsed-math', text.slice(0, 1000));
          container.setAttribute('aria-label', text.slice(0, 1000));
          const span = srSpanFor(container);
          if (span && span.textContent !== text) span.textContent = text;
        }
        const input = (container.__aleksA11yInput && container.__aleksA11yInput.isConnected)
          ? container.__aleksA11yInput
          : (container.querySelector ? container.querySelector('input.ansed_input') : null);
        if (input) {
          input.__aleksA11yTreeText = text;
          input.__aleksA11yRoot = container;
          scheduleReflect(input);
        } else {
          const tb = container.closest('[data-aleks-a11y="textbox"], [data-aleks-a11y="input"]');
          if (tb) scheduleReflect(tb);
        }
      }, 100);
    } catch (e) {}
  }

  function extractSvg(svg) {
    if (!cfg.promote.svg) return;
    try {
      const texts = [...svg.querySelectorAll('text')].map(t => {
        let x = parseFloat(t.getAttribute('x')), y = parseFloat(t.getAttribute('y'));
        if (isNaN(x)) x = 0; if (isNaN(y)) y = 0;
        return { t: cleanText(t.textContent), x, y };
      }).filter(i => i.t);
      if (!texts.length) return;
      const joined = clusterLines(texts, cfg.canvasLineTolerance)
        .map(l => joinLine(l.items)).join('\n');
      if (!joined) return;
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', joined.slice(0, 1000));
      svg.setAttribute('data-parsed-math', joined.slice(0, 1000));
      svg.setAttribute('data-aleks-a11y', 'svg-math');
      const span = srSpanFor(svg);
      if (span && span.textContent !== joined) span.textContent = joined;
      const tb = svg.closest('[data-aleks-a11y="textbox"], [data-aleks-a11y="input"]');
      if (tb) reflectState(tb);
    } catch (e) {}
  }

  /* M3 (part 3): mirror in-memory math state (AnsedObject/widget models) */
  function describeValue(v) {
    if (v === null || v === undefined) return '';
    const t = typeof v;
    if (t === 'string') return JSON.stringify(v.slice(0, 200));
    if (t === 'number' || t === 'boolean') return String(v);
    if (t === 'object') {
      try {
        if (v.latex !== undefined) return 'latex=' + String(v.latex).slice(0, 200);
        if (v.mathml !== undefined) return 'mathml=' + String(v.mathml).slice(0, 200);
        if (v.text !== undefined) return 'text=' + String(v.text).slice(0, 200);
        const j = JSON.stringify(v);
        if (j && j !== '{}') return j.slice(0, 200);
      } catch (e) {}
    }
    return '';
  }

  function metaFrom(node, found) {
    try {
      for (const k in node.dataset) {
        if (/(math|latex|tex|expr|value|answer|model|state|text)/i.test(k)) {
          found.push(k + '=' + String(node.dataset[k]).slice(0, 120));
        }
      }
      for (const k of Object.getOwnPropertyNames(node)) {
        if (k.length > 2 && /^(_{0,2})(math|latex|tex|expr|answer|model|state|value)/i.test(k)) {
          const s = describeValue(node[k]);
          if (s) found.push(k + '=' + s);
        }
      }
    } catch (e) {}
  }

  function extractModelMeta(el) {
    try {
      const found = [];
      let n = el, hops = 0;
      while (n && n.nodeType === 1 && hops <= 3) {
        metaFrom(n, found);
        n = n.parentElement;
        hops++;
      }
      const seen = new Set();
      const uniq = found.filter(s => !seen.has(s) && seen.add(s));
      if (uniq.length) el.setAttribute('data-aleks-meta', uniq.join(' | ').slice(0, 500));
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* Registry + M5: answer-state reflection                              */
  /* ------------------------------------------------------------------ */
  const registry = { buttons: new Set(), textboxes: new Set() };
  let tbCounter = 0;
  const lastVerify = {}; // result of the most recent type() verification

  function registerButton(el) {
    if (!el.__aleksA11yRegistered) { el.__aleksA11yRegistered = true; registry.buttons.add(el); }
  }
  function registerTextbox(el) {
    if (!el.__aleksA11yRegistered) { el.__aleksA11yRegistered = true; registry.textboxes.add(el); }
  }

  function stripPlaceholder(s) {
    return String(s == null ? '' : s).replace(/\s*empty input box\s*/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000);
  }

  function reflectState(tb) {
    try {
      if (!tb || !tb.isConnected) return;
      // 1) ansed tree text — ALEKS's own math rendering (most reliable).
      // Re-extract live: spans change as the answer is typed / palette-clicked.
      let val = '';
      let root = tb.__aleksA11yRoot;
      if (!root || !root.isConnected) {
        root = tb.closest ? tb.closest('[id^="ansed_root"], [class~="ansed_root"], [class*=" ansed_root"]') : null;
        if (root) { tb.__aleksA11yRoot = root; root.__aleksA11yInput = tb; }
      }
      if (root && root.isConnected) {
        const t = extractAnsedText(root);
        if (t !== root.__aleksA11yAnsedText) {
          root.__aleksA11yAnsedText = t;
          if (t) {
            root.setAttribute('data-parsed-math', t.slice(0, 1000));
            root.setAttribute('aria-label', t.slice(0, 1000));
            const span = srSpanFor(root);
            if (span && span.textContent !== t) span.textContent = t;
          }
        }
        if (t) val = t;
      }
      // 2) canvas reconstructions inside/overlaying the input
      if (!val) {
        let cs = [...tb.querySelectorAll('canvas')];
        if (!cs.length && tb.parentElement) cs = [...tb.parentElement.querySelectorAll('canvas')].slice(0, 4);
        const parts = [];
        for (const c of cs) { if (c.__aleksA11yLastText) parts.push(c.__aleksA11yLastText); }
        if (parts.length) val = parts.join(' ');
      }
      // 3) plain contenteditable / native value
      if (!val && tb.isContentEditable) val = cleanTextOf(tb);
      if (!val && tb.value !== undefined && tb.value !== null && tb.value !== '') val = String(tb.value);
      // 4) last-resort manual tracking (our own type())
      if (!val && tb.__aleksA11yManual && !tb.__aleksA11yManualConsumed) val = tb.__aleksA11yManual;
      val = stripPlaceholder(val);
      if (val !== tb.getAttribute('aria-valuetext')) tb.setAttribute('aria-valuetext', val);
      tb.setAttribute('data-aleks-value', val);
      // mirror into overlay canvases (canvas-drawn math stacked over the input)
      const overlays = tb.__aleksA11yOverlays;
      if (overlays) {
        for (const c of overlays) {
          try {
            if (c.isConnected && c.getAttribute('aria-label') !== val) c.setAttribute('aria-label', val);
          } catch (e) {}
        }
      }
      try { tb.dispatchEvent(new CustomEvent('aleks-a11y:statechange', { bubbles: true, detail: { value: val } })); } catch (e) {}
    } catch (e) {}
  }

  function scheduleReflect(tb) {
    try {
      clearTimeout(tb.__aleksA11yReflectT);
      tb.__aleksA11yReflectT = setTimeout(() => reflectState(tb), 120);
    } catch (e) {}
  }

  function bindReflect(tb) {
    if (tb.__aleksA11yBound) return;
    tb.__aleksA11yBound = true;
    const onReal = (e) => {
      tb.__aleksA11yManualConsumed = true;
      if (e && (e.type === 'input' || e.type === 'change')) onExternalInput(tb);
      scheduleReflect(tb);
    };
    ['input', 'change', 'beforeinput', 'keydown', 'keyup', 'compositionend', 'focus', 'blur']
      .forEach(t => tb.addEventListener(t, onReal, true));
  }

  // When an automation tool (BrowserFly etc.) fills the input directly, ALEKS's
  // editor ignores the change (no key events). Detect the value change that did
  // NOT move ALEKS's recall, and route the text through the editor pipeline.
  function onExternalInput(tb) {
    try {
      clearTimeout(tb.__aleksA11yAbsorbT);
      tb.__aleksA11yAbsorbT = setTimeout(() => {
        try {
          const ie = findAleksEditorFor(tb);
          if (!ie || typeof ie.getRecall !== 'function') return;
          const r = String(ie.getRecall());
          const v = String(tb.value || '').trim();
          if (r === tb.__aleksA11yLastRecall && v && !/empty input box/i.test(v)) {
            absorbExternalFill(tb, ie, v);
          }
          tb.__aleksA11yLastRecall = String(ie.getRecall());
        } catch (e) {}
      }, 180);
    } catch (e) {}
  }

  function absorbExternalFill(tb, ie, v) {
    try {
      const cleaned = v.replace(/\s*empty input box\s*/gi, '').trim();
      if (!cleaned) return;
      const now = Date.now();
      if (cleaned === tb.__aleksA11yLastAbsorbed && now - (tb.__aleksA11yLastAbsorbedAt || 0) < 3000) return;
      tb.__aleksA11yLastAbsorbed = cleaned;
      tb.__aleksA11yLastAbsorbedAt = now;
      // plain fills need auto caret-exit: exponents ("x^2+5" -> "x^2{RIGHT}+5")
      // AND fractions ("5/3," -> "5/3{RIGHT},") — the caret stays inside
      // denominator/exponent until arrowed out
      const tokenized = translateMathTokens(cleaned
        .replace(/(\^[0-9a-zA-Z.]+)/g, '$1{RIGHT}')
        .replace(/(\/[0-9a-zA-Z.]+)/g, '$1{RIGHT}')
        .replace(/(\/\([^)]*\))/g, '$1{RIGHT}'));
      try { ie.clear(); } catch (e) {}
      try { if (typeof ie.focus === 'function') ie.focus(); } catch (e) {}
      feedText(ie, tokenized);
      lastVerify.method = 'absorb';
      lastVerify.text = cleaned;
      lastVerify.verified = true;
      lastVerify.at = Date.now();
      scheduleReflect(tb);
      try { tb.dispatchEvent(new CustomEvent('aleks-a11y:typeverify', { bubbles: true, detail: Object.assign({}, lastVerify) })); } catch (e) {}
    } catch (e) {}
  }

  // Some automation tools (e.g. BrowserFly's text-input tool) set the input's
  // value without firing any events. Poll the ansed inputs; whenever the value
  // changed but ALEKS's recall did NOT (i.e. ALEKS ignored the change), replay
  // the text through the editor pipeline. Real typing always moves the recall
  // alongside the value, so it is never double-fed.
  function pollExternalFills() {
    for (const tb of registry.textboxes) {
      try {
        if (!tb.isConnected || tb.tagName !== 'INPUT') continue;
        if (!/ansed/i.test((tb.className || '') + ' ' + (tb.id || ''))) continue;
        const v = String(tb.value || '');
        if (v === tb.__aleksA11ySeenValue) continue;
        tb.__aleksA11ySeenValue = v;
        const ie = findAleksEditorFor(tb);
        if (!ie || typeof ie.getRecall !== 'function') continue;
        const r = String(ie.getRecall());
        if (r === tb.__aleksA11ySeenRecall && v.trim() && !/empty input box/i.test(v)) {
          absorbExternalFill(tb, ie, v);
        }
        tb.__aleksA11ySeenRecall = String(ie.getRecall());
      } catch (e) {}
    }
  }

  /* ------------------------------------------------------------------ */
  /* M2: semantic promotion                                              */
  /* ------------------------------------------------------------------ */
  function scoreButton(el) {
    if (el.__aleksA11yScored) return 0;
    el.__aleksA11yScored = true;
    if (!cfg.promote.buttons) return 0;
    if (!el.isConnected) return 0;
    if (el.closest('[data-aleks-a11y-own]')) return 0;
    if (el.closest('[aria-hidden="true"]')) return 0;
    const tag = el.tagName;
    if (['SCRIPT', 'STYLE', 'META', 'LINK', 'HEAD', 'HTML', 'BODY', 'BR'].includes(tag)) return 0;
    const role = el.getAttribute && el.getAttribute('role');
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A' || role) return 0;
    if (el.isContentEditable || (el.getAttribute && el.getAttribute('contenteditable'))) return 0; // textbox path
    const cls = clsOf(el) + ' ' + (el.id || '');
    let score = 0;
    if (el.hasAttribute('onclick')) score += 4;
    if (/aleks\s?[-_]?(btn|button)|(?:btn|button)[-_]?aleks/i.test(cls)) score += 3;
    if (/\b(btn|button|tool|widget)\b/i.test(cls)) score += 2;
    if (/\b(palette|template|symbol|frac|sqrt|radical|exponent|subscript|superscript)\b/i.test(cls)) score += 1;
    if (el.hasAttribute('title') || el.hasAttribute('data-tooltip') ||
        el.hasAttribute('data-label') || el.hasAttribute('data-name') || el.hasAttribute('data-title')) score += 2;
    if (tag === 'IMG' || tag === 'CANVAS') score += 1;
    if (score >= 2) {
      try {
        const cs = getComputedStyle(el);
        if (cs.cursor === 'pointer') score += 2;
        if (cs.backgroundImage && cs.backgroundImage !== 'none' && /url\(/.test(cs.backgroundImage)) score += 1;
      } catch (e) {}
    }
    return score;
  }

  function bgFilename(el) {
    try {
      const cs = getComputedStyle(el);
      const m = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(cs.backgroundImage || '');
      if (!m || m[1].startsWith('data:')) return null;
      const base = m[1].split('/').pop().split('?')[0].split('#')[0];
      return humanize(base) || null;
    } catch (e) { return null; }
  }

  function labelFor(el) {
    const a = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') ||
      el.getAttribute('data-tooltip') || el.getAttribute('data-label') ||
      el.getAttribute('data-name') || el.getAttribute('data-title');
    if (a && cleanText(a)) return cleanText(a).slice(0, cfg.maxButtonTextLength);
    const bg = bgFilename(el);
    if (bg) return bg;
    const cls = clsOf(el);
    const m = cls.match(/(?:^|[\s_-])(frac|sqrt|root|rad|radical|exp|exponent|sup|superscript|sub|subscript|pi|theta|mu|lambda|deg|degree|enter|undo|redo|backspace|bksp|left|right|up|down|plus|minus|times|div|cdot|ne|neq|le|leq|ge|geq)(?:[\s_-]|$)/i);
    if (m) return TOKEN_NAMES[m[1].toLowerCase()] || humanize(m[1]);
    const txt = cleanTextOf(el);
    if (txt && txt.length <= cfg.maxButtonTextLength) return txt.slice(0, cfg.maxButtonTextLength);
    return null;
  }

  function promoteButton(el) {
    if (el.getAttribute('data-aleks-a11y')) return false;
    const label = labelFor(el);
    if (!el.getAttribute('role')) el.setAttribute('role', 'button');
    if (label) el.setAttribute('aria-label', label);
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    el.setAttribute('data-aleks-a11y', 'button');
    if (cfg.highlight) el.classList.add('aleks-a11y-hl');
    registerButton(el);
    return true;
  }

  // Native <button>/[role=button]: already semantic + focusable. Just give it an
  // accessible name if ALEKS didn't, and register it for the agent's button list.
  function labelButton(el) {
    const a = el.getAttribute('aria-label') || el.getAttribute('title') ||
      el.getAttribute('data-tooltip') || el.getAttribute('data-label');
    if (a && cleanText(a)) return null; // keep ALEKS's own name
    const txt = cleanTextOf(el);
    if (txt && txt.length <= cfg.maxButtonTextLength) return txt;
    const id = el.id || '';
    const m = id.match(/(?:^|_)([A-Za-z][A-Za-z0-9]+)$/);
    if (m && !/^(input|button)$/i.test(m[1])) return humanize(m[1]);
    return null;
  }

  function promoteNativeButton(el) {
    if (el.getAttribute('data-aleks-a11y')) return false;
    const label = labelButton(el);
    if (label && label !== el.getAttribute('aria-label')) el.setAttribute('aria-label', label);
    el.setAttribute('data-aleks-a11y', 'button');
    el.setAttribute('data-aleks-a11y-native', '1');
    try { if (!el.getClientRects().length) el.setAttribute('data-aleks-a11y-hidden', '1'); } catch (e) {}
    registerButton(el);
    return true;
  }

  function scoreTextbox(el) {
    if (el.getAttribute && el.getAttribute('role') === 'textbox') return 4;
    const cls = clsOf(el);
    const id = el.id || '';
    if (/button|_btn/i.test(id)) return 0; // ALEKS chrome: *_button_input_* ids are buttons, not inputs
    if (/(input|entry|answer|expression|equation|mathbox|math-box|textbox|text-box|freeform|free-form|workspace)/i.test(cls)) {
      if (/box|field|entry|input|editor|workspace|area/i.test(cls)) return 3;
      return 2;
    }
    if (/(input|answer|expression|equation|math)[_-]?(box|field|entry|editor|area)|workspace|freeform|mathbox|textbox/i.test(id)) return 3;
    return 0;
  }

  function promoteTextbox(el) {
    if (el.getAttribute('data-aleks-a11y')) return;
    const n = ++tbCounter;
    el.setAttribute('role', 'textbox');
    el.setAttribute('aria-multiline', 'false');
    if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', 'Answer Input ' + n);
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    el.setAttribute('data-aleks-a11y', 'textbox');
    el.setAttribute('data-aleks-a11y-idx', String(n));
    if (cfg.highlight) el.classList.add('aleks-a11y-hl');
    bindReflect(el);
    registerTextbox(el);
    extractModelMeta(el);
    reflectState(el);
  }

  function promoteNativeInput(el) {
    if (el.getAttribute('data-aleks-a11y')) return;
    const n = ++tbCounter;
    let label = el.getAttribute('aria-label');
    if (!label) {
      // multi-part formulas: reuse the nearest preceding labeled ansed input.
      // Walk previous siblings, then climb containers (ALEKS may put each part
      // in its own wrapper) until a labeled ansed input is found.
      let prev = el.previousElementSibling, hops = 0;
      while (prev && hops < 4 && !label) {
        if (prev.tagName === 'INPUT' && /ansed/i.test((prev.className || '') + ' ' + (prev.id || '')) && prev.getAttribute('aria-label')) {
          label = prev.getAttribute('aria-label') + ' (continued)';
        }
        prev = prev.previousElementSibling;
        hops++;
      }
      let scope = el.parentElement, climb = 0;
      while (!label && scope && climb < 4) {
        const inputs = scope.querySelectorAll('input[aria-label]');
        for (const i of inputs) {
          if (i === el) break;
          if (/ansed/i.test((i.className || '') + ' ' + (i.id || ''))) {
            label = i.getAttribute('aria-label') + ' (continued)';
          }
        }
        scope = scope.parentElement;
        climb++;
      }
    }
    if (!label) label = 'Answer Input ' + n;
    if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', label);
    el.setAttribute('data-aleks-a11y', 'input');
    el.setAttribute('data-aleks-a11y-idx', String(n));
    if (cfg.highlight) el.classList.add('aleks-a11y-hl');
    bindReflect(el);
    registerTextbox(el);
    // Link the ansed math tree. In the current ALEKS layout the input lives
    // INSIDE div.ansed_root (older layouts kept it as a sibling).
    let root = el.closest('[id^="ansed_root"], [class~="ansed_root"], [class*=" ansed_root"]');
    if (!root) {
      const sib = el.nextElementSibling;
      if (sib && /ansed/i.test(clsOf(sib) + ' ' + (sib.id || ''))) root = sib;
    }
    if (root) { el.__aleksA11yRoot = root; root.__aleksA11yInput = el; }
    try {
      const r = el.getBoundingClientRect();
      const overlays = [];
      if (r.width && r.height) {
        document.querySelectorAll('canvas').forEach(c => {
          const cr = c.getBoundingClientRect();
          if (Math.abs(cr.left - r.left) < 3 && Math.abs(cr.top - r.top) < 3 && Math.abs(cr.width - r.width) < 4) overlays.push(c);
        });
      }
      el.__aleksA11yOverlays = overlays;
    } catch (e) { el.__aleksA11yOverlays = []; }
    reflectState(el);
  }

  /* Choice groups: custom multiple-choice rendered as div buttons */
  function findChoiceContainer(el) {
    let n = el, hops = 0;
    while (n && hops < 4) {
      n = n.parentElement;
      if (!n) return null;
      if (/(multiple.?choice|choices?|options?|answer.?choices?|radio.?group)/i.test(clsOf(n) + ' ' + (n.id || ''))) return n;
      hops++;
    }
    return null;
  }

  function maybeChoiceGroup(container) {
    if (!cfg.promote.choices) return;
    if (container.getAttribute('data-aleks-a11y') === 'choicegroup') return;
    const btns = [...container.querySelectorAll('[data-aleks-a11y="button"]')];
    if (btns.length < 2) return;
    container.setAttribute('data-aleks-a11y', 'choicegroup');
    btns.forEach((b, i) => {
      b.setAttribute('role', 'radio');
      b.setAttribute('data-aleks-a11y-choice', String(i));
      if (!b.hasAttribute('aria-checked')) b.setAttribute('aria-checked', 'false');
    });
    updateChoiceGroup(container);
    container.addEventListener('click', () => setTimeout(() => updateChoiceGroup(container), 60), true);
  }

  function updateChoiceGroup(container) {
    try {
      const btns = [...container.querySelectorAll('[data-aleks-a11y="button"]')];
      btns.forEach(b => {
        const marked = /(selected|active|checked|highlight|chosen)/i.test(clsOf(b)) ||
          b.getAttribute('aria-checked') === 'true' ||
          !!b.querySelector('[class*="select" i], [class*="active" i], [class*="check" i], [class*="chosen" i], [class*="highlight" i]');
        b.setAttribute('aria-checked', marked ? 'true' : 'false');
      });
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* M1: scan pipeline driven by MutationObserver                        */
  /* ------------------------------------------------------------------ */
  let scanRoots = new Set();
  let scanTimer = null;

  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.getAttribute && root.getAttribute('data-aleks-a11y-own')) return;
    const all = [root];
    try { all.push(...root.querySelectorAll('*')); } catch (e) {}

    // --- buttons (deepest first: innermost control wins) ---
    let cap = cfg.scanCap;
    const candidates = [];
    const promoted = [];
    for (const el of all) {
      if (cap-- <= 0) break;
      if (el.__aleksA11yScored) continue;
      el.__aleksA11yScored = true;
      const s = scoreButton(el);
      if (s >= cfg.buttonMinScore) candidates.push({ el: el, d: depthOf(el) });
    }
    candidates.sort((a, b) => b.d - a.d);
    for (const c of candidates) {
      const el = c.el;
      if (el.getAttribute('data-aleks-a11y')) continue;
      if (el.querySelector('[data-aleks-a11y="button"], [data-aleks-a11y="textbox"], [data-aleks-a11y="input"]')) continue;
      if (promoteButton(el)) promoted.push(el);
    }

    // --- textboxes (outermost wins: one "Answer Input N" per visual box) ---
    cap = cfg.scanCap;
    for (const el of all) {
      if (cap-- <= 0) break;
      if (el.__aleksA11yTbScored) continue;
      el.__aleksA11yTbScored = true;
      const tag = el.tagName;
      if (['BUTTON', 'A', 'SELECT', 'LABEL', 'OPTION', 'NAV', 'HEADER'].includes(tag)) continue;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (['text', 'number', 'search', 'tel', 'url', 'password'].includes(type)) {
          if (!el.closest('[data-aleks-a11y="textbox"], [data-aleks-a11y="input"]')) promoteNativeInput(el);
        }
        continue;
      }
      if (el.closest('[data-aleks-a11y="textbox"], [data-aleks-a11y="input"]')) continue;
      if (el.isContentEditable) { promoteTextbox(el); continue; }
      if (cfg.promote.textboxes && scoreTextbox(el) >= cfg.textboxMinScore) promoteTextbox(el);
    }

    // --- native buttons: ALEKS's new UI is real <button> without names ---
    // Label all of them; hidden ones get a flag so agents can filter.
    cap = cfg.scanCap;
    for (const el of all) {
      if (cap-- <= 0) break;
      if (el.__aleksA11yBtnScored) continue;
      el.__aleksA11yBtnScored = true;
      if (el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') continue;
      if (el.closest('[data-aleks-a11y-own]')) continue;
      if (!cfg.promote.nativeButtons) continue;
      if (el.getAttribute('data-aleks-a11y')) continue;
      promoteNativeButton(el);
    }

    // --- ansed math trees: ALEKS renders math as positioned spans ---
    cap = cfg.scanCap;
    for (const el of all) {
      if (cap-- <= 0) break;
      if (!/ansed/i.test(clsOf(el))) continue;
      if (!el.querySelector('.AnsedObject')) continue;
      if (el.parentElement && /ansed/i.test(clsOf(el.parentElement))) continue;
      scheduleAnsed(el);
      const inp = el.querySelector ? el.querySelector('input.ansed_input') : null;
      if (inp) scheduleReflect(inp);
    }

    // --- choice groups ---
    for (const el of promoted) {
      const c = findChoiceContainer(el);
      if (c) maybeChoiceGroup(c);
    }

    // --- svg math ---
    const svgSeen = new Set();
    cap = cfg.scanCap;
    for (const el of all) {
      if (cap-- <= 0) break;
      const svg = el.tagName === 'svg' ? el : (el.closest ? el.closest('svg') : null);
      if (svg && !svgSeen.has(svg)) { svgSeen.add(svg); extractSvg(svg); }
    }

    // --- reflect textboxes that gained children ---
    cap = cfg.scanCap;
    for (const el of all) {
      if (cap-- <= 0) break;
      const tb = el.closest ? el.closest('[data-aleks-a11y="textbox"], [data-aleks-a11y="input"]') : null;
      if (tb && tb !== el) scheduleReflect(tb);
    }

    // --- user-pinned selectors from the DOM-dump refinement step ---
    for (const sel of cfg.extraButtonSelectors) {
      try { root.querySelectorAll(sel).forEach(e => promoteButton(e)); } catch (e) {}
    }
    for (const sel of cfg.extraTextboxSelectors) {
      try { root.querySelectorAll(sel).forEach(e => promoteTextbox(e)); } catch (e) {}
    }
  }

  function scanNow(roots) {
    for (const root of roots) { try { scan(root); } catch (e) {} }
  }

  function onMutations(muts) {
    for (const m of muts) {
      if (m.type !== 'childList') continue;
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) scanRoots.add(n);
      }
    }
    if (!scanTimer) {
      scanTimer = setTimeout(() => {
        scanTimer = null;
        const roots = scanRoots;
        scanRoots = new Set();
        scanNow(roots);
      }, cfg.debounceMs);
    }
  }

  /* ------------------------------------------------------------------ */
  /* M4: event bridging — synthetic event dispatch helpers               */
  /* ------------------------------------------------------------------ */
  function dispatch(el, Ctor, type, init, extras) {
    let ev = null;
    try { ev = new Ctor(type, init); }
    catch (err) {
      try { ev = document.createEvent('Event'); ev.initEvent(type, !!init.bubbles, !!init.cancelable); }
      catch (err2) { return null; }
    }
    if (!ev) return null;
    try { Object.defineProperty(ev, '__aleksA11y', { value: true }); } catch (e) {}
    if (extras) {
      for (const k in extras) {
        try { Object.defineProperty(ev, k, { value: extras[k] }); } catch (e) {}
      }
    }
    try { el.dispatchEvent(ev); } catch (e) {}
    return ev;
  }

  function bridgeClick(el, opts) {
    opts = opts || {};
    const now = Date.now();
    if (!opts.force && el.__aleksA11yLastBridge && now - el.__aleksA11yLastBridge < 250) return false;
    el.__aleksA11yLastBridge = now;
    try { el.focus({ preventScroll: true }); } catch (e) {}
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const pbase = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, pointerId: 1, isPrimary: true, pointerType: 'mouse', width: 1, height: 1, pressure: 0.5, button: 0, buttons: 1 };
    const mbase = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, detail: 1, button: 0, buttons: 1 };
    dispatch(el, PointerEvent, 'pointerover', { ...pbase });
    dispatch(el, PointerEvent, 'pointerenter', { ...pbase, bubbles: false });
    dispatch(el, PointerEvent, 'pointermove', { ...pbase });
    dispatch(el, PointerEvent, 'pointerdown', { ...pbase });
    dispatch(el, MouseEvent, 'mousedown', { ...mbase }, { which: 1, pageX: x, pageY: y });
    dispatch(el, PointerEvent, 'pointerup', { ...pbase, buttons: 0 });
    dispatch(el, MouseEvent, 'mouseup', { ...mbase, buttons: 0 }, { which: 1, pageX: x, pageY: y });
    dispatch(el, MouseEvent, 'click', { ...mbase, buttons: 0 }, { which: 1, pageX: x, pageY: y });
    return true;
  }

  function clickAt(x, y, opts) {
    opts = opts || {};
    let el = null;
    try { el = document.elementFromPoint(x, y); } catch (e) {}
    if (!el) return { ok: false, error: 'no element at point' };
    const target = opts.raw ? el :
      (el.closest('[data-aleks-a11y="button"], [data-aleks-a11y="textbox"], [data-aleks-a11y="input"]') || el);
    const now = Date.now();
    if (!opts.force && target.__aleksA11yLastBridge && now - target.__aleksA11yLastBridge < 250) {
      return { ok: false, error: 'debounced (same element bridged <250ms ago)' };
    }
    target.__aleksA11yLastBridge = now;
    const pbase = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, pointerId: 1, isPrimary: true, pointerType: 'mouse', width: 1, height: 1, pressure: 0.5, button: 0, buttons: 1 };
    const mbase = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, detail: 1, button: 0, buttons: 1 };
    dispatch(target, PointerEvent, 'pointerdown', { ...pbase });
    dispatch(target, MouseEvent, 'mousedown', { ...mbase }, { which: 1 });
    dispatch(target, PointerEvent, 'pointerup', { ...pbase, buttons: 0 });
    dispatch(target, MouseEvent, 'mouseup', { ...mbase, buttons: 0 }, { which: 1 });
    dispatch(target, MouseEvent, 'click', { ...mbase, buttons: 0 }, { which: 1 });
    return { ok: true, x, y };
  }

  // Records when another automation layer (BrowserFly, etc.) has already
  // dispatched an untrusted pointerdown/mousedown for a promoted element —
  // so we don't re-bridge a click that is part of an existing full sequence.
  function onCapturedDown(e) {
    if (e.isTrusted || e.__aleksA11y) return;
    const t = (e.target && e.target.nodeType === 1) ? e.target : null;
    if (!t) return;
    const el = t.closest('[data-aleks-a11y="button"], [data-aleks-a11y="textbox"], [data-aleks-a11y="input"]');
    if (el) el.__aleksA11ySyntheticDown = Date.now();
  }

  // Capturing listener: translate untrusted (automated) clicks on promoted
  // CUSTOM widgets into the full pointerdown->mousedown->pointerup->mouseup->
  // click sequence ALEKS's state manager expects. Trusted clicks (real user,
  // CDP input via BrowserFly/Playwright/Puppeteer) pass through untouched.
  function onCapturedClick(e) {
    if (e.__aleksA11y) return;
    const t = (e.target && e.target.nodeType === 1) ? e.target : null;
    if (!t) return;
    if (t.closest('[data-aleks-a11y-own]')) { onAnyClick(e); return; }
    const el = t.closest('[data-aleks-a11y="button"], [data-aleks-a11y="textbox"], [data-aleks-a11y="input"]');
    if (!el) { onAnyClick(e); return; }
    if (e.isTrusted) { onAnyClick(e); return; }
    // Native controls (button/input/a): the browser + ALEKS's React onClick
    // already handle a bare click. Re-bridging would double-fire. Pass through.
    if (el.getAttribute('data-aleks-a11y-native') === '1' ||
        ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT', 'LABEL'].includes(el.tagName)) {
      onAnyClick(e);
      return;
    }
    // Another automation layer already played down/up for this click
    // (full synthetic sequence) — pass through instead of double-firing.
    if (el.__aleksA11ySyntheticDown && Date.now() - el.__aleksA11ySyntheticDown < 400) {
      onAnyClick(e);
      return;
    }
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
    bridgeClick(el);
  }

  function onAnyClick(e) {
    const t = (e.target && e.target.nodeType === 1) ? e.target : null;
    if (!t) return;
    const cg = t.closest('[data-aleks-a11y="choicegroup"]');
    if (cg) setTimeout(() => updateChoiceGroup(cg), 60);
  }

  /* ------------------------------------------------------------------ */
  /* M4: keyboard / typing bridge                                        */
  /* ------------------------------------------------------------------ */
  function synthKey(el, key) {
    const special = { Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab', ' ': 'Space', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown' };
    const code = special[key] || (key.length === 1 ? 'Key' + key.toUpperCase() : key);
    const init = { key, code, bubbles: true, cancelable: true, composed: true, view: window };
    const which = key === ' ' ? 32 : (key.charCodeAt(0) || 0);
    dispatch(el, KeyboardEvent, 'keydown', init, { which });
    if (key.length === 1 || key === 'Enter' || key === ' ') dispatch(el, KeyboardEvent, 'keypress', init, { which });
    dispatch(el, KeyboardEvent, 'keyup', init, { which });
  }

  function fallbackKeyType(el, text) {
    for (const ch of text) {
      synthKey(el, ch);
      dispatch(el, InputEvent, 'input', { bubbles: true, cancelable: false, composed: true, data: ch, inputType: 'insertText' });
    }
  }

  function execInsert(el, text) {
    try {
      const sel = window.getSelection();
      sel.removeAllRanges();
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      sel.addRange(r);
      return document.execCommand('insertText', false, text);
    } catch (e) { return false; }
  }

  // Strategy 0: drive ALEKS's own editor pipeline — the same methods its
  // keyboard handler calls internally. Renders math natively, no events needed.
  function rawEl(x) {
    if (!x) return null;
    if (x.nodeType === 1) return x;
    for (const k of ['el', 'element', 'dom', 'domElement', 'node']) {
      try { const v = x[k]; if (v && v.nodeType === 1) return v; } catch (e) {}
    }
    try { if (typeof x.get === 'function') { const v = x.get(0); if (v && v.nodeType === 1) return v; } } catch (e) {}
    return null;
  }

  function findAleksEditorFor(tb) {
    try {
      const list = (window.ait && window.ait.ansed && window.ait.ansed.ansedList) || [];
      // Exact mapping: input id "ansed_input_<name>" <-> editor entry _name
      const key = String(tb.id || '').replace(/^ansed_input_/, '');
      if (key) {
        for (const form of list) {
          if (form && form._name === key) return form;
        }
      }
      for (const form of list) {
        if (!form) continue;
        // 0) this entry itself IS the editor for the input (ALEKS may wrap
        //    DOM nodes in aleks.core.ui.Element wrappers — compare unwrapped)
        try {
          if (typeof form.getEditboxParent === 'function') {
            const p = form.getEditboxParent();
            const r = rawEl(p);
            if (r === tb) return form;
            if (r && r.contains && r.contains(tb) && typeof form.actionOnCharacter === 'function') return form;
          }
        } catch (e) {}
        try {
          if (typeof form.getFocusContainer === 'function') {
            const p = form.getFocusContainer();
            const r = rawEl(p);
            if (r === tb || (r && r.contains && r.contains(tb))) return form;
          }
        } catch (e) {}
        if (!form.innerEditors) continue;
        // 1) exact match: inner editor whose editbox element is our input
        for (const ie of form.innerEditors) {
          try {
            const p = ie.getEditboxParent && ie.getEditboxParent();
            if (rawEl(p) === tb) return ie;
          } catch (e) {}
        }
        // 2) container match: FormEditor root contains the input
        try {
          const root = form.getContainer && form.getContainer(true);
          if (root && root.contains && root.contains(tb)) {
            const m = /innerEditor_(\d+)/.exec(tb.id || '');
            if (m) {
              const ie = form.getInnerEditor(m[1]) ||
                (form.innerEditors.find(x => String(x.recallId) === String(m[1])));
              if (ie) return ie;
            }
            if (form.innerEditors.length) return form.innerEditors[0];
          }
        } catch (e) {}
      }
      return null;
    } catch (e) { return null; }
  }

  // Focus the input, then ask ALEKS which editor it considers focused.
  // Only accept the editor if its _name matches the input (never a display editor).
  function focusedAleksEditor(tb) {
    try {
      tb.focus({ preventScroll: true });
      const id = (window.ait && window.ait.ansed && window.ait.ansed.currentAnsedId);
      if (id !== undefined && id !== null) {
        const e = (window.ait.ansed.ansedList || [])[id];
        if (e) {
          const key = String(tb.id || '').replace(/^ansed_input_/, '');
          if (key && e._name !== key) return null;
          return e;
        }
      }
    } catch (e) {}
    return null;
  }

  const SPECIAL_KEY_CODES = { BACKSPACE: 8, BS: 8, TAB: 9, ENTER: 13, RETURN: 13, ESC: 27, ESCAPE: 27, SPACE: 32, PAGEUP: 33, PAGEDOWN: 34, END: 35, HOME: 36, LEFT: 37, LEFTARROW: 37, UP: 38, UPARROW: 38, RIGHT: 39, RIGHTARROW: 39, DOWN: 40, DOWNARROW: 40, DELETE: 46, DEL: 46 };

  // ALEKS recall strings carry markup (\readonly; \editbox; \neg; [[ ]] ^ …);
  // translate the common tokens to their literal forms, strip the rest.
  function cleanRecall(r) {
    return String(r == null ? '' : r)
      .replace(/\\neg;/g, '-')
      .replace(/%minus;/g, '-')
      .replace(/%plus;/g, '+')
      .replace(/%infinity;/g, '∞')
      .replace(/%neginfinity;/g, '-∞')
      .replace(/%union;/g, '∪')
      .replace(/\\sp;/g, ' ')
      .replace(/\\dot;|\\smalldot;|\\times;/g, '*')
      .replace(/\\sqrt;/g, 'sqrt(')
      .replace(/\\setunion;/g, '∪')
      .replace(/\\abs;/g, '|')
      .replace(/\\lessequal;/g, '≤')
      .replace(/\\greaterequal;/g, '≥')
      .replace(/\\nroot;/g, 'nroot(')
      .replace(/\\editbox;|\\readonly;/g, '')
      .replace(/\\[a-zA-Z]+;/g, '')
      .replace(/\(\d/g, '(')
      .replace(/\d\)/g, ')')
      .replace(/[\[\]]/g, '');
  }

  function cleanTypedText(t) {
    return String(t == null ? '' : t).replace(/\{[A-Za-z ]+\}/g, '').replace(/\s+/g, '');
  }

  function feedChar(ie, ch) {
    const beforeRecall = String(typeof ie.getRecall === 'function' ? ie.getRecall() : '');
    let handled = false;
    try {
      if (typeof ie.actionOnKey === 'function') {
        ie.actionOnKey({
          eventCharacter: ch,
          ASCIICode: true,
          eventKeyCode: ch.charCodeAt(0),
          eventShiftKey: false, eventAltKey: false, eventCtrlKey: false,
          sourceEvent: null,
          key: ch,
          preventDefault() {}, stopPropagation() {}
        });
        handled = true;
      }
    } catch (e) {}
    if (!handled) {
      try {
        if (/[0-9]/.test(ch) && typeof ie.actionOnNumber === 'function') ie.actionOnNumber(ch.charCodeAt(0));
        else if (/[a-zA-Z]/.test(ch)) ie.actionOnCharacter(ch, 'string');
        else ie.actionOnCharacter(ch, 'math');
      } catch (e) {}
    } else if (!/[a-zA-Z0-9]/.test(ch)) {
      // operator char: if actionOnKey didn't change the editor state,
      // try a direct character insert (recall stores %plus; etc. tokens)
      try {
        const afterRecall = String(typeof ie.getRecall === 'function' ? ie.getRecall() : '');
        if (afterRecall === beforeRecall) ie.actionOnCharacter(ch, 'math');
      } catch (e) {}
    }
  }

  // Translate plain-text math shorthands ALEKS has no typed key for into
  // {INF}/{NEGINF}/{UNION} tokens (fed via actionOnSingleton in feedText).
  function translateMathTokens(text) {
    let s = String(text == null ? '' : text);
    s = s.replace(/(-)\s*\binf(inity)?\b/gi, '{NEGINF}');
    s = s.replace(/\binf(inity)?\b/gi, '{INF}');
    s = s.replace(/∪/g, '{UNION}');
    s = s.replace(/\\cup\b/gi, '{UNION}');
    s = s.replace(/\\infty\b/gi, '{INF}');
    s = s.replace(/(?<![A-Za-z])pi(?![A-Za-z])|π/gi, '{PI}');
    s = s.replace(/(?<![A-Za-z])theta(?![A-Za-z])|θ/gi, '{THETA}');
    s = s.replace(/degree(?![A-Za-z])|°/gi, '{DEGREE}');
    s = s.replace(/≤/g, '{LE}');
    s = s.replace(/≥/g, '{GE}');
    s = s.replace(/\bleq\b|\ble\b/gi, '{LE}');
    s = s.replace(/\bgeq\b|\bge\b/gi, '{GE}');
    return s;
  }

  // Feed text with special-key tokens, e.g. "-4x^2{RIGHT}+5" (RIGHT exits the
  // exponent, exactly like real typing; {ENTER} {BACKSPACE} {TAB} … also work).
  function feedText(ie, text) {
    const re = /\{([A-Za-z ]+)\}/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      for (const ch of text.slice(last, m.index)) feedChar(ie, ch);
      const name = m[1].trim().toUpperCase();
      if (name === 'INF') { try { ie.actionOnSingleton('infinity'); } catch (e) {} }
      else if (name === 'NEGINF') { feedChar(ie, '-'); try { ie.actionOnSingleton('infinity'); } catch (e) {} }
      else if (name === 'UNION') { try { ie.actionOnBinary('setunion'); } catch (e) { try { ie.actionOnSingleton('union'); } catch (e2) {} } }
      else if (name === 'PI') { try { ie.actionOnSingleton('pi'); } catch (e) {} }
      else if (name === 'THETA') { try { ie.actionOnSingleton('theta'); } catch (e) {} }
      else if (name === 'DEGREE') { try { ie.actionOnSingleton('degree'); } catch (e) {} }
      else if (name === 'LE') { try { ie.actionOnBinary('lessequal'); } catch (e) {} }
      else if (name === 'GE') { try { ie.actionOnBinary('greaterequal'); } catch (e) {} }
      else if (name === 'SQRT') { try { ie.actionOnUnary('sqrt'); } catch (e) {} }
      else if (name === 'ABS') { try { ie.actionOnUnary('abs'); } catch (e) {} }
      else if (name === 'FRAC') { try { ie.actionOnFrac(); } catch (e) {} }
      else if (name === 'NROOT') { try { ie.actionOnOperator('nroot'); } catch (e) {} }
      else if (SPECIAL_KEY_CODES[name] !== undefined) {
        try { ie.actionOnSpecialKey({ eventKeyCode: SPECIAL_KEY_CODES[name], eventShiftKey: false, eventCharacter: '' }); } catch (e) {}
      }
      last = re.lastIndex;
    }
    for (const ch of text.slice(last)) feedChar(ie, ch);
  }

  function aleksApiType(tb, text, opts) {
    let ie = findAleksEditorFor(tb);
    if (!ie) ie = focusedAleksEditor(tb);
    if (!ie) return false;
    opts = opts || {};
    try {
      if (opts.clear) {
        let cleared = false;
        try { if (typeof ie.clear === 'function') { ie.clear(); cleared = true; } } catch (e) {}
        if (!cleared) {
          try {
            if (typeof ie.selectAnsed === 'function') ie.selectAnsed();
            if (typeof ie.actionOnSpecialKey === 'function') ie.actionOnSpecialKey({ eventKeyCode: 8, eventShiftKey: false });
          } catch (e) {}
        }
      }
      try { if (typeof ie.focus === 'function') ie.focus(); else if (typeof ie.focusNoScroll === 'function') ie.focusNoScroll(); } catch (e) {}
      feedText(ie, translateMathTokens(text));
      return true;
    } catch (e) { return false; }
  }

  // Current text of the ansed math tree associated with an input (ground truth)
  function ansedTextOf(tb) {
    try {
      const root = (tb.__aleksA11yRoot && tb.__aleksA11yRoot.isConnected)
        ? tb.__aleksA11yRoot
        : tb.closest('[id^="ansed_root"], [class~="ansed_root"], [class*=" ansed_root"]');
      return root ? extractAnsedText(root) : '';
    } catch (e) { return ''; }
  }

  // Strategy B: call React's own handler chain directly (no event-trust issues)
  function callReactHandlers(el, text) {
    try {
      const key = Object.getOwnPropertyNames(el).find(k => k.indexOf('__reactProps') === 0);
      if (!key) return false;
      const props = el[key] || {};
      const base = typeof props.value === 'string' ? props.value : (el.value || '');
      let newVal;
      if (/empty input box/i.test(base)) newVal = base.replace(/\s*empty input box\s*/i, text);
      else newVal = base + text;
      const fake = {
        target: { value: newVal, name: el.name || '' },
        currentTarget: el,
        preventDefault() {}, stopPropagation() {}, persist() {}, nativeEvent: {}
      };
      if (typeof props.onChange === 'function') { props.onChange(fake); return true; }
      if (typeof props.onInput === 'function') { props.onInput(fake); return true; }
    } catch (e) {}
    return false;
  }

  // Strategy C: per-character keydown/keypress/input/keyup with value kept in sync
  function keyTypeInto(el, text) {
    try {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      let cur = String(el.value || '');
      if (/empty input box/i.test(cur)) cur = cur.replace(/\s*empty input box\s*/i, '');
      for (const ch of text) {
        cur += ch;
        setter.call(el, cur);
        synthKey(el, ch);
        dispatch(el, InputEvent, 'input', { bubbles: true, cancelable: false, composed: true, data: ch, inputType: 'insertText' });
      }
      dispatch(el, Event, 'change', { bubbles: true });
      return true;
    } catch (e) { return false; }
  }

  function typeInto(tb, text, opts) {
    opts = opts || {};
    const isNative = tb.tagName === 'INPUT' || tb.tagName === 'TEXTAREA';
    if (opts.clear) {
      if (tb.isContentEditable) tb.textContent = '';
      else if (tb.value !== undefined && tb.value !== null) {
        try {
          const proto = tb.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(tb, '');
        } catch (e) { tb.value = ''; }
      }
      tb.__aleksA11yManual = text;
      tb.__aleksA11yManualConsumed = false;
    } else {
      tb.__aleksA11yManual = (tb.__aleksA11yManual || '') + text;
      tb.__aleksA11yManualConsumed = false;
    }
    // Native inputs handle focus/click themselves (React onClick); only
    // bridge a full pointer sequence for custom non-native editors.
    if (isNative) { try { tb.focus({ preventScroll: true }); } catch (e) {} }
    else bridgeClick(tb, { force: true });
    let method = 'none';
    if (tb.isContentEditable) {
      method = execInsert(tb, text) ? 'execCommand' : 'fallback';
      if (method === 'fallback') fallbackKeyType(tb, text);
    } else if (tb.tagName === 'INPUT' || tb.tagName === 'TEXTAREA') {
      const before = ansedTextOf(tb);
      const iePre = findAleksEditorFor(tb);
      const beforeRecall = iePre && typeof iePre.getRecall === 'function' ? cleanRecall(iePre.getRecall()) : '';
      if (aleksApiType(tb, text, opts)) {
        // A) direct call into ALEKS's own editor pipeline (always renders)
        method = 'aleksApi';
      } else {
        // B) real insertion pipeline — trusted events (Chromium; Firefox unsupported)
        let inserted = false;
        try {
          tb.select();
          inserted = document.execCommand('insertText', false, text);
        } catch (e) {}
        if (inserted) {
          method = 'execCommand';
        } else if (callReactHandlers(tb, text)) {
          // C) direct call into React's onChange/onInput
          method = 'reactHandlers';
        } else {
          // D) per-char synthetic key sequence with value kept in sync
          keyTypeInto(tb, text);
          method = 'keySequence';
        }
      }
      // Verify against ALEKS's own state (recall) once it re-renders
      setTimeout(() => {
        try {
          let after, beforeCmp, typedNorm;
          const ie2 = findAleksEditorFor(tb);
          if (ie2 && typeof ie2.getRecall === 'function') {
            after = cleanRecall(String(ie2.getRecall()));
            beforeCmp = beforeRecall;
            typedNorm = cleanTypedText(text);
          } else {
            after = ansedTextOf(tb);
            beforeCmp = before;
            typedNorm = text;
          }
          const norm = s => String(s || '').replace(/\s+/g, '').replace(/[−–—]/g, '-').replace(/[·⋅]/g, '*').replace(/;/g, ',').replace(/∞/g, 'inf').replace(/∪/g, 'U').replace(/≤/g, '<=').replace(/≥/g, '>=');
          const tn = norm(typedNorm);
          const verified = !!tn && norm(after) !== norm(beforeCmp) && norm(after).indexOf(tn) !== -1;
          lastVerify.method = method;
          lastVerify.verified = verified;
          lastVerify.before = before;
          lastVerify.after = after;
          lastVerify.text = text;
          lastVerify.at = Date.now();
          try { tb.dispatchEvent(new CustomEvent('aleks-a11y:typeverify', { bubbles: true, detail: Object.assign({}, lastVerify) })); } catch (e) {}
        } catch (e) {}
      }, 450);
    } else {
      const innerEditable = tb.querySelector('[contenteditable]:not([contenteditable="false"])');
      if (innerEditable) {
        try { innerEditable.focus({ preventScroll: true }); } catch (e) {}
        method = execInsert(innerEditable, text) ? 'execCommand:inner' : 'fallback';
        if (method === 'fallback') fallbackKeyType(tb, text);
      } else {
        const hidden = tb.querySelector('input[type="text"], input:not([type]), input[type="search"], input[type="tel"], input[type="number"]');
        if (hidden) {
          try {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(hidden, (hidden.value || '') + text);
            dispatch(hidden, Event, 'input', { bubbles: true });
            dispatch(hidden, Event, 'change', { bubbles: true });
            method = 'hiddenInput';
          } catch (e) {}
        } else {
          fallbackKeyType(tb, text);
          method = 'fallback';
        }
      }
    }
    scheduleReflect(tb);
    return method;
  }

  /* ------------------------------------------------------------------ */
  /* Target resolution + public API                                      */
  /* ------------------------------------------------------------------ */
  function resolveTextbox(target) {
    if (target && target.nodeType === 1) {
      return target.closest('[data-aleks-a11y="textbox"], [data-aleks-a11y="input"]') ||
        (['INPUT', 'TEXTAREA'].includes(target.tagName) ? target : null);
    }
    const list = [...registry.textboxes].filter(e => e.isConnected);
    if (!list.length) return null;
    if (typeof target === 'number') return list[target] || null;
    if (typeof target === 'string') {
      const s = target.toLowerCase();
      return list.find(e => (
        ((e.getAttribute('aria-label') || '').toLowerCase().includes(s)) ||
        ((e.id || '').toLowerCase().includes(s)) ||
        (clsOf(e).toLowerCase().includes(s))
      )) || null;
    }
    return list[0];
  }

  function resolveButton(target) {
    if (target && target.nodeType === 1) return target.closest('[data-aleks-a11y="button"]') || null;
    const list = [...registry.buttons].filter(e => e.isConnected);
    if (!list.length) return null;
    if (typeof target === 'number') return list[target] || null;
    if (typeof target === 'string') {
      const s = target.toLowerCase();
      return list.find(e => (
        ((e.getAttribute('aria-label') || '').toLowerCase().includes(s)) ||
        ((e.getAttribute('title') || '').toLowerCase().includes(s)) ||
        (cleanTextOf(e).toLowerCase().includes(s))
      )) || null;
    }
    return null;
  }

  function findButtonByLabel(name) {
    const n = String(name).toLowerCase();
    return [...registry.buttons].find(e => e.isConnected && (
      (e.getAttribute('aria-label') || '').toLowerCase().includes(n) ||
      (e.getAttribute('title') || '').toLowerCase().includes(n)
    )) || null;
  }

  function apiClick(target, opts) {
    const btn = resolveButton(target);
    if (!btn) return { ok: false, error: 'button not found (use ALEKSA11Y.buttons() to list)' };
    bridgeClick(btn, opts || {});
    return { ok: true, label: btn.getAttribute('aria-label') || '' };
  }

  const PALETTE_ALIASES = {
    fraction: ['fraction', 'frac'],
    sqrt: ['square root', 'sqrt', 'radical'],
    exponent: ['exponent', 'sup', 'superscript'],
    subscript: ['subscript', 'sub'],
    pi: ['pi', 'π'], theta: ['theta', 'θ'],
    multiply: ['multiplication', '×', 'cdot', '·'],
    divide: ['division', '÷'],
    le: ['≤', 'le', 'leq'], ge: ['≥', 'ge', 'geq'],
    degree: ['degree', '°'],
    undo: ['undo'], redo: ['redo'], enter: ['enter'], backspace: ['backspace', 'bksp']
  };

  function apiPalette(name) {
    const names = PALETTE_ALIASES[String(name).toLowerCase()] || [String(name)];
    for (const n of names) {
      const b = findButtonByLabel(n);
      if (b) { bridgeClick(b); return { ok: true, label: b.getAttribute('aria-label') || n }; }
    }
    return { ok: false, error: 'no palette button matching "' + name + '" (use ALEKSA11Y.buttons() to list)' };
  }

  function apiType(text, opts) {
    opts = opts || {};
    const tb = resolveTextbox(opts.target);
    if (!tb) return { ok: false, error: 'no answer input found' };
    if (opts.latex) return apiLatex(String(text), tb);
    const method = typeInto(tb, String(text), opts);
    return { ok: true, method, target: tb.getAttribute('aria-label') || '' };
  }

  // Experimental: translate LaTeX-ish shortcuts into palette button clicks
  function apiLatex(text, tb) {
    const TOKENS = [
      ['\\dfrac', 'fraction'], ['\\frac', 'fraction'], ['\\sqrt', 'square root'],
      ['\\pi', 'pi'], ['\\theta', 'theta'], ['\\cdot', 'multiply'], ['\\times', 'multiply'],
      ['\\le', 'le'], ['\\leq', 'le'], ['\\ge', 'ge'], ['\\geq', 'ge'],
      ['\\ne', 'ne'], ['\\neq', 'ne'], ['\\degree', 'degree'], ['\\pm', 'plus-minus'],
      ['\\div', 'divide'], ['^', 'exponent'], ['_', 'subscript']
    ];
    let rest = text, log = [];
    while (rest) {
      let matched = false;
      for (const pair of TOKENS) {
        if (rest.startsWith(pair[0])) {
          const hit = findButtonByLabel(pair[1]);
          if (hit) { bridgeClick(hit); log.push('click:' + pair[1]); }
          else { typeInto(tb, pair[0], {}); log.push('type:' + pair[0]); }
          rest = rest.slice(pair[0].length);
          matched = true;
          break;
        }
      }
      if (matched) continue;
      const ch = rest[0];
      rest = rest.slice(1);
      typeInto(tb, ch, {});
      log.push('type:' + ch);
    }
    return { ok: true, method: 'latex', log };
  }

  /* ------------------------------------------------------------------ */
  /* Diagnostics: dump / snapshot / save (workflow step 3)               */
  /* ------------------------------------------------------------------ */
  function rectOf(el) {
    try {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    } catch (e) { return null; }
  }

  function htmlContext(el) {
    const out = [];
    let n = el;
    for (let i = 0; i < 3 && n; i++) {
      try {
        let h = n.outerHTML;
        if (h.length > 4000) h = h.slice(0, 4000) + ' …[TRUNCATED]';
        out.push(h);
      } catch (e) {}
      n = n.parentElement;
    }
    return out;
  }

  function snapshot() {
    const btns = [...registry.buttons].filter(e => e.isConnected);
    const tbs = [...registry.textboxes].filter(e => e.isConnected);
    return {
      frame: location.href,
      isTop: window === window.top,
      time: Date.now(),
      answerInputs: tbs.map(el => ({
        label: el.getAttribute('aria-label') || '',
        value: el.getAttribute('aria-valuetext') || '',
        kind: el.getAttribute('data-aleks-a11y'),
        rect: rectOf(el)
      })),
      buttons: btns.map(el => ({
        label: el.getAttribute('aria-label') || cleanTextOf(el).slice(0, 60),
        rect: rectOf(el)
      })),
      math: [...document.querySelectorAll('canvas[data-parsed-math], svg[data-parsed-math]')]
        .map(el => ({ math: el.getAttribute('data-parsed-math'), rect: rectOf(el) }))
    };
  }

  function dump() {
    const btns = [...registry.buttons].filter(e => e.isConnected);
    const tbs = [...registry.textboxes].filter(e => e.isConnected);
    return {
      frame: location.href,
      scriptVersion: SCRIPT_VERSION,
      isTop: window === window.top,
      time: new Date().toISOString(),
      summary: {
        buttons: btns.length,
        inputs: tbs.length,
        canvases: document.querySelectorAll('canvas').length,
        svgs: document.querySelectorAll('svg').length,
        ansedSpans: document.querySelectorAll('.AnsedObject').length
      },
      answerInputs: tbs.map(el => ({
        label: el.getAttribute('aria-label') || '',
        value: el.getAttribute('aria-valuetext') || '',
        kind: el.getAttribute('data-aleks-a11y'),
        tag: el.tagName.toLowerCase(),
        cls: clsOf(el),
        id: el.id || '',
        meta: el.getAttribute('data-aleks-meta') || '',
        rect: rectOf(el),
        html: htmlContext(el)   // raw HTML snippet for selector mapping
      })),
      buttons: btns.map(el => ({
        label: el.getAttribute('aria-label') || '',
        cls: clsOf(el),
        id: el.id || '',
        native: el.getAttribute('data-aleks-a11y-native') === '1',
        hidden: el.getAttribute('data-aleks-a11y-hidden') === '1',
        rect: rectOf(el)
      })),
      canvases: [...document.querySelectorAll('canvas')].map(c => ({
        math: c.__aleksA11yLastText || '',
        meta: c.getAttribute('data-aleks-meta') || '',
        w: c.width, h: c.height,
        rect: rectOf(c),
        html: c.__aleksA11yLastText ? undefined : htmlContext(c).slice(0, 2)
      })),
      ansedTrees: [...document.querySelectorAll('[class*="ansed"]')]
        .filter(e => e.querySelector('.AnsedObject'))
        .map(e => ({
          id: e.id || '',
          cls: clsOf(e),
          math: (e.getAttribute('data-parsed-math') || e.__aleksA11yAnsedText || ''),
          rect: rectOf(e)
        }))
        .filter(x => x.math),
      unhandledOnclick: [...document.querySelectorAll('[onclick]')]
        .filter(e => !e.getAttribute('data-aleks-a11y'))
        .map(e => ({ tag: e.tagName.toLowerCase(), cls: clsOf(e), id: e.id || '', txt: cleanTextOf(e).slice(0, 60) }))
    };
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return true; }
    } catch (e) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch (e) { return false; }
  }

  function saveDump(name) {
    try {
      const payload = { frame: location.href, dump: dump(), snapshot: snapshot() };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (name || 'aleks-a11y-dump') + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return true;
    } catch (e) { console.warn('[ALEKS-A11Y] save failed', e); return false; }
  }

  function refresh() {
    document.querySelectorAll('canvas').forEach(c => { try { flushCanvas(c); } catch (e) {} });
    document.querySelectorAll('svg').forEach(s => { try { extractSvg(s); } catch (e) {} });
    document.querySelectorAll('[class*="ansed"]').forEach(s => { try { if (s.querySelector('.AnsedObject')) scheduleAnsed(s); } catch (e) {} });
    registry.textboxes.forEach(t => { try { reflectState(t); } catch (e) {} });
    return true;
  }

  function applyHighlight(on) {
    cfg.highlight = !!on;
    const toggle = el => { try { el.classList.toggle('aleks-a11y-hl', cfg.highlight); } catch (e) {} };
    registry.buttons.forEach(toggle);
    registry.textboxes.forEach(toggle);
    return cfg.highlight;
  }

  /* ------------------------------------------------------------------ */
  /* Debug panel (top frame only; Alt+Shift+A)                           */
  /* ------------------------------------------------------------------ */
  let panel = null;

  function buildPanel() {
    try {
      const box = document.createElement('div');
      box.setAttribute('data-aleks-a11y-own', '1');
      box.id = 'aleks-a11y-panel';
      box.style.cssText = 'display:none;position:fixed;top:8px;right:8px;z-index:2147483000;background:#0d1117;color:#e6edf3;font:11px/1.4 monospace;padding:8px;border-radius:6px;border:1px solid #444;box-shadow:0 4px 16px rgba(0,0,0,.6);max-width:380px;max-height:75vh;overflow:auto';
      box.innerHTML =
        '<div style="font-weight:bold;margin-bottom:4px">ALEKS A11y Bridge</div>' +
        '<pre id="aleks-a11y-summary" style="white-space:pre-wrap;max-height:45vh;overflow:auto;margin:0 0 6px"></pre>' +
        '<button data-a="dump">Dump (console)</button>' +
        '<button data-a="snap">Snapshot</button>' +
        '<button data-a="save">Save dump</button>' +
        '<button data-a="hl">Highlight</button>' +
        '<button data-a="close">Close</button>';
      document.documentElement.appendChild(box);
      const btnStyle = 'background:#21262d;color:#e6edf3;border:1px solid #444;border-radius:4px;margin:2px;padding:3px 8px;cursor:pointer';
      box.querySelectorAll('button').forEach(b => { b.style.cssText = btnStyle; });
      box.querySelector('[data-a="dump"]').addEventListener('click', () => { console.log('[ALEKS-A11Y] dump', dump()); copyText(JSON.stringify(dump())); });
      box.querySelector('[data-a="snap"]').addEventListener('click', () => { console.log('[ALEKS-A11Y] snapshot', snapshot()); });
      box.querySelector('[data-a="save"]').addEventListener('click', () => saveDump());
      box.querySelector('[data-a="hl"]').addEventListener('click', () => applyHighlight(!cfg.highlight));
      box.querySelector('[data-a="close"]').addEventListener('click', () => { box.style.display = 'none'; });
      return box;
    } catch (e) { return null; }
  }

  function togglePanel() {
    if (window !== window.top) return;
    if (!panel) panel = buildPanel();
    if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  }

  function updatePanel() {
    if (!panel || panel.style.display === 'none') return;
    const sum = panel.querySelector('#aleks-a11y-summary');
    if (!sum) return;
    const tbs = [...registry.textboxes].filter(e => e.isConnected);
    const bts = [...registry.buttons].filter(e => e.isConnected);
    const lines = ['buttons: ' + bts.length + ' | inputs: ' + tbs.length + ' | canvases: ' + document.querySelectorAll('canvas').length];
    for (const t of tbs) {
      const v = t.getAttribute('aria-valuetext') || '';
      lines.push((t.getAttribute('aria-label') || '?') + ' = ' + (v.length > 80 ? v.slice(0, 80) + '…' : v));
    }
    sum.textContent = lines.join('\n');
  }

  /* ------------------------------------------------------------------ */
  /* Cross-frame aggregation (top frame collects child-frame snapshots)  */
  /* ------------------------------------------------------------------ */
  function originOk(origin) {
    try { return /(^|\.)aleks\.com$/.test(new URL(origin).hostname); }
    catch (e) { return false; }
  }

  function setupMessaging() {
    const CH = 'aleks-a11y';
    if (window === window.top) {
      const frames = new Map();
      API.frames = frames;
      window.addEventListener('message', ev => {
        const d = ev.data;
        if (!d || typeof d !== 'object' || d.channel !== CH) return;
        if (!originOk(ev.origin)) return;
        if (d.type === 'hello' || d.type === 'report') frames.set(d.href || ev.origin, d.data);
      });
      API.broadcast = () => {
        document.querySelectorAll('iframe').forEach(f => {
          try { f.contentWindow && f.contentWindow.postMessage({ channel: CH, type: 'request' }, '*'); } catch (e) {}
        });
      };
      API.dumpAsync = async () => {
        API.broadcast();
        await sleep(700);
        return { top: dump(), frames: Object.fromEntries([...frames.entries()].map(([k, v]) => [k, v])) };
      };
    } else {
      const send = (type, data) => {
        try { window.top.postMessage({ channel: CH, type, data, href: location.href }, '*'); } catch (e) {}
      };
      send('hello', snapshot());
      window.addEventListener('message', ev => {
        const d = ev.data;
        if (!d || typeof d !== 'object' || d.channel !== CH) return;
        if (d.type === 'request') {
          send('report', snapshot());
          document.querySelectorAll('iframe').forEach(f => {
            try { f.contentWindow && f.contentWindow.postMessage({ channel: CH, type: 'request' }, '*'); } catch (e) {}
          });
        }
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Self-reporting status marker (visible to agents that read page text, */
  /* invisible to humans and screenshots)                                */
  /* ------------------------------------------------------------------ */
  function updateStatusMarker() {
    try {
      let m = document.getElementById('aleks-a11y-status');
      if (!m) {
        m = document.createElement('div');
        m.id = 'aleks-a11y-status';
        m.setAttribute('data-aleks-a11y-own', '1');
        m.setAttribute('aria-hidden', 'false');
        m.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden';
        (document.body || document.documentElement).appendChild(m);
      }
      const tbs = [...registry.textboxes].filter(e => e.isConnected).length;
      const bts = [...registry.buttons].filter(e => e.isConnected).length;
      let txt = 'ALEKS A11y Bridge active v' + SCRIPT_VERSION + ' | inputs: ' + tbs +
        ' | buttons: ' + bts + ' | ansedSpans: ' + document.querySelectorAll('.AnsedObject').length;
      if (lastVerify.at && Date.now() - lastVerify.at < 15000 && lastVerify.method) {
        txt += ' | lastBridge: ' + lastVerify.method + ' "' + String(lastVerify.text || '').slice(0, 40) + '"';
      }
      m.textContent = txt;
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* Global hotkeys                                                      */
  /* ------------------------------------------------------------------ */
  function onGlobalKeydown(e) {
    if (!(e.altKey && e.shiftKey) || e.ctrlKey || e.metaKey) return;
    if (e.code === 'KeyA') togglePanel();
    else if (e.code === 'KeyH') applyHighlight(!cfg.highlight);
    else if (e.code === 'KeyD') console.log('[ALEKS-A11Y] dump', dump());
    else if (e.code === 'KeyS') saveDump();
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */
  function apiHelp() {
    console.log([
      '[ALEKS-A11Y] API quick reference',
      '  ALEKSA11Y.dump()              -> full diagnostic (buttons/inputs/canvases + raw HTML context)',
      '  ALEKSA11Y.snapshot()          -> compact view for the agent',
      '  ALEKSA11Y.save("name")        -> download dump as JSON (send back to harden selectors)',
      '  ALEKSA11Y.copy()              -> copy dump JSON to clipboard',
      '  ALEKSA11Y.textboxes()         -> list detected answer inputs',
      '  ALEKSA11Y.buttons(label?)     -> list detected buttons',
      '  ALEKSA11Y.click("Check")      -> bridge-click a button by label/index/element',
      '  ALEKSA11Y.clickAt(x, y)       -> bridge full mouse sequence at page coords',
      '  ALEKSA11Y.type("3/4")         -> type into the first answer input',
      '  ALEKSA11Y.type("1/2", {target:"Answer Input 1", clear:true})',
      '  ALEKSA11Y.palette("fraction") -> bridge-click a palette button by name',
      '  ALEKSA11Y.type("\\frac{1}{2}", {latex:true}) -> experimental LaTeX shortcut mode',
      '  Tokens in type(): {BACKSPACE} {ENTER} {LEFT} {RIGHT} {TAB} {DELETE} — e.g. "-4x^2{RIGHT}+5"',
      '  Interval shorthand: "inf"/"-inf" -> ∞/−∞ and "∪" -> union (e.g. "(-inf,0)∪(0,inf)")',
      '  Symbols: "pi" -> π, "theta" -> θ, "≤"/"le" -> ≤, "≥"/"ge" -> ≥, {SQRT}...{RIGHT} -> √, {ABS}...{RIGHT} -> |…|, {FRAC} -> empty fraction, {NROOT} -> nth root',
      '  ALEKSA11Y.key("Enter")        -> dispatch keydown/keypress/keyup at current focus',
      '  ALEKSA11Y.verify()            -> result of the last type(): {method, verified, before, after}',
      '  ALEKSA11Y.editorFor(target)    -> check the direct-editor API resolved for an input',
      '  ALEKSA11Y.highlight(true)     -> outline promoted elements',
      '  ALEKSA11Y.refresh()           -> re-read canvases/state now',
      '  ALEKSA11Y.rescan()            -> re-scan DOM with current config',
      '  ALEKSA11Y.config              -> live config (tune thresholds, add selectors)',
      '  ALEKSA11Y.dumpAsync()         -> top frame only: aggregate all child frames',
      '  Keys: Alt+Shift+A panel | Alt+Shift+H highlight | Alt+Shift+D dump | Alt+Shift+S save'
    ].join('\n'));
  }

  const API = {
    version: SCRIPT_VERSION,
    config: cfg,
    help: apiHelp,
    dump: dump,
    snapshot: snapshot,
    save: saveDump,
    copy: () => copyText(JSON.stringify(dump())),
    textboxes: () => [...registry.textboxes].filter(e => e.isConnected).map(el => ({
      label: el.getAttribute('aria-label') || '',
      value: el.getAttribute('aria-valuetext') || '',
      kind: el.getAttribute('data-aleks-a11y')
    })),
    buttons: (label) => [...registry.buttons].filter(e =>
      e.isConnected &&
      (!label || ((e.getAttribute('aria-label') || '').toLowerCase().includes(String(label).toLowerCase())))
    ).map(el => {
      const r = rectOf(el);
      return { label: el.getAttribute('aria-label') || '', visible: !!(r && r.w > 0), native: el.getAttribute('data-aleks-a11y-native') === '1' };
    }),
    click: apiClick,
    clickAt: clickAt,
    type: apiType,
    palette: apiPalette,
    key: (k, target) => {
      const tb = resolveTextbox(target) ||
        ((document.activeElement && document.activeElement !== document.body) ? document.activeElement : null);
      if (!tb) return { ok: false, error: 'no focus target' };
      const name = String(k).replace(/^\{|\}$/g, '').trim().toUpperCase();
      const code = SPECIAL_KEY_CODES[name];
      const ie = tb && tb.nodeType === 1 ? findAleksEditorFor(tb) : null;
      if (ie && code !== undefined && typeof ie.actionOnSpecialKey === 'function') {
        try {
          ie.actionOnSpecialKey({ eventKeyCode: code, eventShiftKey: false, eventCharacter: '' });
          return { ok: true, via: 'editor', key: name };
        } catch (e) {}
      }
      synthKey(tb, String(k).replace(/[{}]/g, ''));
      return { ok: true, via: 'synthetic', key: name };
    },
    verify: () => Object.assign({}, lastVerify),
    editorFor: (target) => {
      const tb = resolveTextbox(target);
      const ie = tb ? findAleksEditorFor(tb) : null;
      return ie ? {
        found: true,
        recall: String(ie.getRecall ? ie.getRecall() : '').slice(0, 80),
        focus: typeof ie.focus === 'function',
        actionOnKey: typeof ie.actionOnKey === 'function'
      } : { found: false };
    },
    highlight: applyHighlight,
    debug: on => {
      if (window !== window.top) return false;
      if (!panel) panel = buildPanel();
      if (panel) panel.style.display = on === false ? 'none' : 'block';
      return true;
    },
    refresh: refresh,
    rescan: () => { scan(document.body); return true; },
    clearCanvases: () => {
      document.querySelectorAll('canvas').forEach(c => { if (c.__aleksA11yItems) c.__aleksA11yItems.clear(); });
      return true;
    }
  };

  // Expose the API. Chrome: @grant none already runs in the page context.
  // Firefox: Tampermonkey honors @inject-into page when no GM_ grants are used;
  // if it still lands in the sandbox realm, mirror into unsafeWindow so page
  // scripts (and agent extensions' injected JS) can reach the API too.
  window.ALEKSA11Y = API;
  try { if (typeof unsafeWindow !== 'undefined' && unsafeWindow !== window) unsafeWindow.ALEKSA11Y = API; } catch (e) {}

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */
  function boot() {
    injectStyles();
    if (window === window.top) buildPanel();
    const mo = new MutationObserver(onMutations);
    mo.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('click', onCapturedClick, true);
    document.addEventListener('pointerdown', onCapturedDown, true);
    document.addEventListener('mousedown', onCapturedDown, true);
    window.addEventListener('keydown', onGlobalKeydown, true);
    scanNow([document.body]);
    setupMessaging();
    setInterval(() => { flushAll(); updateStatusMarker(); }, cfg.canvasPollMs);
    setInterval(pollExternalFills, 600);
    updateStatusMarker();
    if (window === window.top) setInterval(updatePanel, 800);
    console.log(
      '%c[ALEKS-A11Y] Bridge active in ' + location.href,
      'color:#0af;font-weight:bold',
      '\n  ALEKSA11Y.help() for commands | Alt+Shift+A debug panel'
    );
  }

  whenReady(boot);
})();
