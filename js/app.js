/*
 * app.js — state, scheduling, input handling, persistence.
 *
 * Responsibilities
 *   · owns the single source of truth (`state`) and the view transform
 *   · schedules generation: preview while you drag, full quality when you stop
 *   · pointer/touch gestures on the canvas
 *   · undo stack, localStorage, URL hash, export, PWA registration
 */
(function (root) {
  'use strict';
  var GA = root.GA;

  var STORE_KEY = 'contours.v1';
  var BASE = 1200;          // long edge of the artboard, in art units
  var MAX_UNDO = 24;

  var canvas = document.getElementById('canvas');
  var ctx = canvas.getContext('2d');
  var stage = document.getElementById('stage');
  var sheet = document.getElementById('sheet');
  var scrim = document.getElementById('scrim');

  var dpr = 1;
  var cssW = 0, cssH = 0;

  /* ---------------------------------------------------------------------- */
  /* State                                                                   */
  /* ---------------------------------------------------------------------- */

  var state = {
    seed: GA.randomSeed(),
    params: Object.assign({}, GA.DEFAULTS),
    seeds: [],
    secondary: null,          // null = needs deriving
    artW: BASE,
    artH: BASE,
    presetId: 'topographic'
  };

  var flags = {
    pngScale: 2,
    background: true,
    plotter: false,
    showSeeds: true
  };

  var view = { x: 0, y: 0, k: 1 };
  var art = null;
  var undoStack = [];
  var userMovedView = false;

  /* ---------------------------------------------------------------------- */
  /* Canvas sizing                                                           */
  /* ---------------------------------------------------------------------- */

  function resize() {
    var r = stage.getBoundingClientRect();
    cssW = Math.max(1, Math.round(r.width));
    cssH = Math.max(1, Math.round(r.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    if (!userMovedView) fitToScreen(false);
    draw();
  }

  /* Artboard aspect follows the visible canvas area at generation time. */
  function syncArtboard() {
    var a = cssW / cssH;
    if (a >= 1) { state.artW = BASE; state.artH = Math.round(BASE / a); }
    else { state.artH = BASE; state.artW = Math.round(BASE * a); }
  }

  function fitToScreen(redraw) {
    var k = Math.min(cssW / state.artW, cssH / state.artH) * 0.94;
    view.k = k;
    view.x = (cssW - state.artW * k) / 2;
    view.y = (cssH - state.artH * k) / 2;
    userMovedView = false;
    if (redraw !== false) draw();
  }

  /* ---------------------------------------------------------------------- */
  /* Drawing                                                                 */
  /* ---------------------------------------------------------------------- */

  var gestureCache = null, gestureView = null;

  function draw() {
    if (gestureCache) return drawGestureFrame();
    if (!art) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#f3f1ec';
      ctx.fillRect(0, 0, cssW, cssH);
      return;
    }
    GA.render.draw(ctx, art, {
      dpr: dpr, width: cssW, height: cssH, view: view,
      pageColor: '#f3f1ec',
      background: true,
      plotter: flags.plotter,
      frame: true
    });
    if (flags.showSeeds) {
      GA.render.drawSeeds(ctx, state.seeds, { dpr: dpr, view: view, activeIndex: dragIndex });
    }
  }

  /* While pinching/panning we transform the last rendered bitmap instead of
     re-emitting every Bézier — this is what keeps gestures at 60fps. */
  function beginGesture() {
    if (!art) return;
    gestureCache = document.createElement('canvas');
    gestureCache.width = canvas.width;
    gestureCache.height = canvas.height;
    gestureCache.getContext('2d').drawImage(canvas, 0, 0);
    gestureView = { x: view.x, y: view.y, k: view.k };
  }

  function drawGestureFrame() {
    var s = view.k / gestureView.k;
    var tx = view.x - gestureView.x * s;
    var ty = view.y - gestureView.y * s;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#f3f1ec';
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * tx, dpr * ty);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(gestureCache, 0, 0, cssW, cssH);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function endGesture() {
    gestureCache = null;
    gestureView = null;
    draw();
  }

  /* ---------------------------------------------------------------------- */
  /* Generation scheduling                                                   */
  /* ---------------------------------------------------------------------- */

  var rafId = 0, pendingQuality = null, upgradeTimer = 0;

  /* The most recent request wins, and everything is coalesced into one frame:
     a burst of pointermove events costs a single generation, not twenty. */
  function request(quality) {
    pendingQuality = quality;
    clearTimeout(upgradeTimer);
    if (!rafId) rafId = requestAnimationFrame(run);
  }

  function run() {
    rafId = 0;
    var q = pendingQuality || 'full';
    pendingQuality = null;
    var t0 = performance.now();
    try {
      art = GA.generator.generate(state, q);
    } catch (e) {
      console.error(e);
      GA.ui.toast('Generation failed — try a smaller value');
      return;
    }
    draw();
    status(q === 'preview'
      ? 'preview…'
      : art.paths.length + ' lines · ' + Math.round(performance.now() - t0) + 'ms');
    if (q === 'preview') {
      // if nothing else happens shortly, quietly upgrade to full quality
      clearTimeout(upgradeTimer);
      upgradeTimer = setTimeout(function () { request('full'); }, 260);
    }
    save();
  }

  var statusEl = document.getElementById('statusChip');
  function status(msg) {
    statusEl.textContent = msg;
    statusEl.hidden = false;
  }

  /* ---------------------------------------------------------------------- */
  /* Actions                                                                 */
  /* ---------------------------------------------------------------------- */

  function snapshot() {
    return JSON.stringify({
      seed: state.seed, params: state.params, seeds: state.seeds,
      secondary: state.secondary, artW: state.artW, artH: state.artH,
      presetId: state.presetId
    });
  }

  function refreshUndoBtn() {
    document.getElementById('btnUndoQuick').disabled = !undoStack.length;
  }

  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    refreshUndoBtn();
  }

  function dropUndo() {          // interaction turned out to be a no-op
    undoStack.pop();
    refreshUndoBtn();
  }

  function undo() {
    if (!undoStack.length) { GA.ui.toast('Nothing to undo'); return; }
    var s = JSON.parse(undoStack.pop());
    state.seed = s.seed;
    state.params = s.params;
    state.seeds = s.seeds;
    state.secondary = s.secondary;
    state.artW = s.artW;
    state.artH = s.artH;
    state.presetId = s.presetId;
    refreshUndoBtn();
    syncUI();
    request('full');
  }

  function reseed() {
    var rng = new GA.RNG(state.seed);
    state.seeds = GA.generator.placeSeeds(rng, state.params, state.artW, state.artH);
    state.secondary = null;
  }

  /* Generate = rebuild the composition deterministically from the current seed. */
  function generate(newSeed) {
    pushUndo();
    if (newSeed) state.seed = GA.randomSeed();
    syncArtboard();
    reseed();
    if (!userMovedView) fitToScreen(false);
    updateSeedChip();
    request('full');
  }

  function applyPreset(id) {
    var p = GA.presetById(id);
    if (!p) return;
    pushUndo();
    state.presetId = id;
    Object.keys(p.params).forEach(function (k) { state.params[k] = p.params[k]; });
    syncArtboard();
    reseed();
    syncUI();
    request('full');
    GA.ui.toast(p.name + ' — ' + p.note, 2600);
  }

  function resetAll() {
    pushUndo();
    state.params = Object.assign({}, GA.DEFAULTS);
    state.presetId = 'topographic';
    state.seed = GA.randomSeed();
    syncArtboard();
    reseed();
    fitToScreen(false);
    syncUI();
    request('full');
  }

  /* ---------------------------------------------------------------------- */
  /* Parameter plumbing                                                      */
  /* ---------------------------------------------------------------------- */

  // changing any of these makes the cached secondary seeds meaningless
  var INVALIDATES_SECONDARY = {
    shapes: 1, layout: 1, merge: 1, secondary: 1,
    gapProb: 1, layers: 1, spacing: 1, scale: 1
  };

  var uiRef = null;

  function onParam(key, value, phase, meta) {
    if (state.params[key] === value && phase === 'preview') return;
    if (phase === 'commit') pushUndoThrottled();
    state.params[key] = value;
    state.presetId = 'custom';
    updatePresetChip();
    if (meta && meta.relayout) reseed();
    if (INVALIDATES_SECONDARY[key] && phase === 'commit') state.secondary = null;
    request(phase === 'commit' ? 'full' : 'preview');
  }

  // one undo entry per continuous interaction, not per pixel of slider travel
  var undoThrottle = 0;
  function pushUndoThrottled() {
    var now = Date.now();
    if (now - undoThrottle > 900) { pushUndo(); }
    undoThrottle = now;
  }

  function syncUI() {
    if (uiRef) uiRef.sync();
    updateSeedChip();
    updatePresetChip();
  }

  function updateSeedChip() {
    document.getElementById('seedValue').textContent = String(state.seed);
  }

  function updatePresetChip() {
    var p = GA.presetById(state.presetId);
    document.getElementById('presetChip').textContent = p ? p.name : 'Custom';
  }

  /* ---------------------------------------------------------------------- */
  /* Export                                                                  */
  /* ---------------------------------------------------------------------- */

  function fileBase() {
    return 'contours-' + state.seed + '-' + (state.presetId || 'custom');
  }

  function exportSVG() {
    var svg = GA.exporters.toSVG(art, {
      background: flags.background,
      plotter: flags.plotter,
      meta: { seed: state.seed, preset: state.presetId, params: state.params }
    });
    var blob = new Blob([svg], { type: 'image/svg+xml' });
    GA.exporters.saveBlob(blob, fileBase() + '.svg');
    GA.ui.toast('SVG saved — real vector paths');
  }

  function exportPNG() {
    var c = GA.exporters.toCanvas(art, {
      scale: flags.pngScale, background: flags.background, plotter: flags.plotter
    });
    GA.exporters.canvasToBlob(c).then(function (blob) {
      GA.exporters.saveBlob(blob, fileBase() + '.png');
      GA.ui.toast('PNG saved (' + c.width + '×' + c.height + ')');
    });
  }

  function shareArt() {
    if (!navigator.share) { GA.ui.toast('Sharing is not available in this browser'); return; }
    var c = GA.exporters.toCanvas(art, {
      scale: Math.min(flags.pngScale, 3), background: true, plotter: flags.plotter
    });
    GA.exporters.canvasToBlob(c).then(function (blob) {
      GA.exporters.shareFile(blob, fileBase() + '.png', 'Contour study — seed ' + state.seed)
        .catch(function () {
          return navigator.share({ title: 'Contours', text: 'Seed ' + state.seed, url: settingsURL() });
        })
        .catch(function () { GA.ui.toast('Sharing cancelled'); });
    });
  }

  function settingsURL() {
    var payload = { s: state.seed, p: state.presetId, v: state.params };
    return location.origin + location.pathname + '#' + encodeURIComponent(JSON.stringify(payload));
  }

  /* ---------------------------------------------------------------------- */
  /* Persistence                                                             */
  /* ---------------------------------------------------------------------- */

  var saveTimer = 0;
  function saveNow() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        seed: state.seed, params: state.params, seeds: state.seeds,
        secondary: state.secondary, artW: state.artW, artH: state.artH,
        presetId: state.presetId, flags: flags
      }));
    } catch (e) { /* private mode / quota — not fatal */ }
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 250);
  }
  // mobile Safari can discard the page without warning — flush on the way out
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') saveNow();
  });

  function load() {
    // a settings link always wins over stored state
    if (location.hash.length > 2) {
      try {
        var h = JSON.parse(decodeURIComponent(location.hash.slice(1)));
        if (h && h.v) {
          state.seed = h.s | 0;
          state.presetId = h.p || 'custom';
          Object.keys(GA.DEFAULTS).forEach(function (k) {
            if (h.v[k] !== undefined) state.params[k] = h.v[k];
          });
          return 'hash';
        }
      } catch (e) { /* malformed link, fall through */ }
    }
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      var s = JSON.parse(raw);
      if (!s || !s.params) return false;
      state.seed = s.seed;
      Object.keys(GA.DEFAULTS).forEach(function (k) {
        if (s.params[k] !== undefined) state.params[k] = s.params[k];
      });
      state.seeds = s.seeds || [];
      state.secondary = s.secondary || null;
      state.artW = s.artW || BASE;
      state.artH = s.artH || BASE;
      state.presetId = s.presetId || 'custom';
      if (s.flags) Object.keys(flags).forEach(function (k) {
        if (s.flags[k] !== undefined) flags[k] = s.flags[k];
      });
      return state.seeds.length ? 'store' : false;
    } catch (e) { return false; }
  }

  /* ---------------------------------------------------------------------- */
  /* Canvas interaction                                                      */
  /* ---------------------------------------------------------------------- */

  var pointers = new Map();
  var dragIndex = -1;
  var pressStart = null;
  var longPressTimer = 0;
  var moved = false;
  var panning = false;
  var pinch = null;

  function toWorld(cx, cy) {
    return { x: (cx - view.x) / view.k, y: (cy - view.y) / view.k };
  }

  function localPoint(e) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function hitSeed(px, py) {
    var best = -1, bestD = 26; // screen px
    for (var i = 0; i < state.seeds.length; i++) {
      var s = state.seeds[i];
      var d = Math.hypot(s.x * view.k + view.x - px, s.y * view.k + view.y - py);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function nearestSeed(px, py) {
    var best = -1, bestD = Infinity;
    for (var i = 0; i < state.seeds.length; i++) {
      var s = state.seeds[i];
      var d = Math.hypot(s.x * view.k + view.x - px, s.y * view.k + view.y - py);
      if (d < bestD) { bestD = d; best = i; }
    }
    return { index: best, dist: bestD };
  }

  function addSeedAt(wx, wy) {
    pushUndo();
    var pool = [];
    state.seeds.forEach(function (s) { if (pool.indexOf(s.group) === -1) pool.push(s.group); });
    var rng = new GA.RNG((state.seed ^ (state.seeds.length * 2654435761) ^ (Date.now() & 0xffff)) | 0);
    state.seeds.push(GA.generator.makeSeed(rng, wx, wy, state.params, pool));
    state.secondary = null;
    request('full');
  }

  function removeSeed(i) {
    if (i < 0 || i >= state.seeds.length) return;
    if (state.seeds.length <= 1) { GA.ui.toast('Keep at least one seed'); return; }
    pushUndo();
    state.seeds.splice(i, 1);
    state.secondary = null;
    request('full');
  }

  canvas.addEventListener('pointerdown', function (e) {
    canvas.setPointerCapture(e.pointerId);
    var p = localPoint(e);
    pointers.set(e.pointerId, p);

    if (pointers.size === 2) {
      // second finger down — switch to pinch/pan, cancel any seed interaction
      clearTimeout(longPressTimer);
      dragIndex = -1;
      panning = false;
      var pts = Array.from(pointers.values());
      pinch = {
        d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        cx: (pts[0].x + pts[1].x) / 2,
        cy: (pts[0].y + pts[1].y) / 2,
        k: view.k, vx: view.x, vy: view.y
      };
      beginGesture();
      return;
    }
    if (pointers.size > 2) return;

    moved = false;
    pressStart = p;

    var hit = hitSeed(p.x, p.y);
    if (e.shiftKey && e.pointerType === 'mouse') {
      var n = nearestSeed(p.x, p.y);
      if (n.index >= 0 && n.dist < 140) removeSeed(n.index);
      pressStart = null;
      return;
    }
    if (hit >= 0) {
      dragIndex = hit;
      pushUndo();
      // long press on a seed removes it
      longPressTimer = setTimeout(function () {
        if (!moved && dragIndex >= 0) {
          var i = dragIndex;
          dragIndex = -1;
          dropUndo();                    // the drag snapshot is redundant here
          removeSeed(i);
          if (navigator.vibrate) navigator.vibrate(12);
          GA.ui.toast('Seed removed');
        }
      }, 520);
      draw();
    } else {
      panning = true;
      beginGesture();
    }
  });

  canvas.addEventListener('pointermove', function (e) {
    if (!pointers.has(e.pointerId)) return;
    var p = localPoint(e);
    pointers.set(e.pointerId, p);

    if (pinch && pointers.size >= 2) {
      var pts = Array.from(pointers.values());
      var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      var cx = (pts[0].x + pts[1].x) / 2;
      var cy = (pts[0].y + pts[1].y) / 2;
      var s = Math.max(0.05, Math.min(40, d / Math.max(1, pinch.d)));
      view.k = pinch.k * s;
      // keep the pinch midpoint anchored, and follow two-finger dragging
      view.x = cx - (pinch.cx - pinch.vx) * s;
      view.y = cy - (pinch.cy - pinch.vy) * s;
      userMovedView = true;
      draw();
      return;
    }

    if (pressStart && Math.hypot(p.x - pressStart.x, p.y - pressStart.y) > 7) {
      moved = true;
      clearTimeout(longPressTimer);
    }

    if (dragIndex >= 0 && moved) {
      var w = toWorld(p.x, p.y);
      state.seeds[dragIndex].x = w.x;
      state.seeds[dragIndex].y = w.y;
      request('preview');
      return;
    }

    if (panning && moved) {
      view.x += p.x - pressStart.x;
      view.y += p.y - pressStart.y;
      pressStart = p;
      userMovedView = true;
      draw();
    }
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    var p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    clearTimeout(longPressTimer);

    if (pinch) {
      if (pointers.size < 2) { pinch = null; endGesture(); }
      pressStart = null;
      dragIndex = -1;
      panning = false;
      return;
    }

    if (dragIndex >= 0) {
      if (moved) request('full'); else dropUndo();
      dragIndex = -1;
      draw();
      pressStart = null;
      return;
    }

    if (panning) {
      panning = false;
      endGesture();
      if (!moved && pressStart) {
        var w = toWorld(p.x, p.y);
        if (w.x > -40 && w.y > -40 && w.x < state.artW + 40 && w.y < state.artH + 40) {
          addSeedAt(w.x, w.y);
        }
      }
    }
    pressStart = null;
  }

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var p = localPoint(e);
    var f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
    var k2 = Math.max(0.05, Math.min(40, view.k * f));
    view.x = p.x - (p.x - view.x) * (k2 / view.k);
    view.y = p.y - (p.y - view.y) * (k2 / view.k);
    view.k = k2;
    userMovedView = true;
    draw();
  }, { passive: false });

  // iOS Safari page-level pinch zoom
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (t) {
    document.addEventListener(t, function (e) { e.preventDefault(); }, { passive: false });
  });
  document.addEventListener('dblclick', function (e) { e.preventDefault(); });

  /* ---------------------------------------------------------------------- */
  /* Chrome wiring                                                           */
  /* ---------------------------------------------------------------------- */

  var wideQuery = window.matchMedia('(min-width: 760px), (orientation: landscape) and (min-width: 620px)');
  function isWide() { return wideQuery.matches; }

  function openSheet(open) {
    if (isWide()) {
      sheet.classList.toggle('collapsed', !open);
      return;
    }
    sheet.classList.toggle('open', open);
    document.body.classList.toggle('sheet-open', open);
    scrim.hidden = !open;
    document.getElementById('btnSettings').setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  document.getElementById('btnSettings').addEventListener('click', function () {
    openSheet(!sheet.classList.contains('open'));
  });
  document.getElementById('sheetHandle').addEventListener('click', function () { openSheet(false); });
  scrim.addEventListener('click', function () { openSheet(false); closeMenus(); });

  document.getElementById('btnGenerate').addEventListener('click', function () { generate(false); });
  document.getElementById('btnRandom').addEventListener('click', function () { generate(true); });
  document.getElementById('btnFit').addEventListener('click', function () { fitToScreen(); });
  document.getElementById('btnUndoQuick').addEventListener('click', undo);

  /* popovers -------------------------------------------------------------- */

  var presetMenu = document.getElementById('presetMenu');
  var moreMenu = document.getElementById('moreMenu');

  GA.PRESETS.forEach(function (p) {
    var b = GA.ui.el('button', 'preset-item');
    b.appendChild(GA.ui.el('strong', null, p.name));
    b.appendChild(GA.ui.el('small', null, p.note));
    b.addEventListener('click', function () { closeMenus(); applyPreset(p.id); });
    b.dataset.preset = p.id;
    presetMenu.appendChild(b);
  });

  function closeMenus() {
    presetMenu.hidden = true;
    moreMenu.hidden = true;
    document.getElementById('btnPresets').setAttribute('aria-expanded', 'false');
    document.getElementById('btnMore').setAttribute('aria-expanded', 'false');
  }

  function toggleMenu(menu, btn) {
    var wasOpen = !menu.hidden;
    closeMenus();
    if (wasOpen) return;
    Array.prototype.forEach.call(presetMenu.children, function (c) {
      c.setAttribute('aria-current', c.dataset.preset === state.presetId ? 'true' : 'false');
    });
    GA.ui.openPopover(menu, btn);
    btn.setAttribute('aria-expanded', 'true');
  }

  document.getElementById('btnPresets').addEventListener('click', function (e) {
    e.stopPropagation();
    toggleMenu(presetMenu, e.currentTarget);
  });
  document.getElementById('btnMore').addEventListener('click', function (e) {
    e.stopPropagation();
    toggleMenu(moreMenu, e.currentTarget);
  });
  document.addEventListener('pointerdown', function (e) {
    if (!presetMenu.hidden && !presetMenu.contains(e.target)) closeMenus();
    else if (!moreMenu.hidden && !moreMenu.contains(e.target)) closeMenus();
  }, true);

  moreMenu.addEventListener('click', function (e) {
    var act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    closeMenus();
    if (act === 'undo') undo();
    else if (act === 'reset') resetAll();
    else if (act === 'fit') fitToScreen();
    else if (act === 'png') exportPNG();
    else if (act === 'svg') exportSVG();
    else if (act === 'share') shareArt();
    else if (act === 'fullscreen') toggleFullscreen();
    else if (act === 'seedcopy') copySettings();
  });

  function toggleFullscreen() {
    var d = document.documentElement;
    if (!document.fullscreenElement) {
      (d.requestFullscreen || d.webkitRequestFullscreen || function () {
        GA.ui.toast('Add to Home Screen for fullscreen on iOS');
      }).call(d);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    }
  }

  function copySettings() {
    var url = settingsURL();
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function () {
        GA.ui.toast('Settings link copied');
      }, function () { GA.ui.toast('Could not copy'); });
    } else {
      GA.ui.toast('Clipboard unavailable');
    }
  }

  /* seed chip — tap to type an exact seed ---------------------------------- */

  document.getElementById('seedChip').addEventListener('click', function () {
    var chip = document.getElementById('seedChip');
    if (chip.querySelector('input')) return;
    var input = document.createElement('input');
    input.type = 'number';
    input.className = 'ctl-val';
    input.style.width = '110px';
    input.value = state.seed;
    var old = chip.innerHTML;
    chip.innerHTML = '';
    chip.appendChild(input);
    input.focus();
    input.select();
    var finish = function (apply) {
      var v = parseInt(input.value, 10);
      chip.innerHTML = old;
      updateSeedChip();
      if (apply && !isNaN(v)) {
        pushUndo();
        state.seed = v | 0;
        reseed();
        updateSeedChip();
        request('full');
      }
    };
    input.addEventListener('blur', function () { finish(true); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
  });

  /* keyboard shortcuts (desktop) ------------------------------------------ */

  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'g') generate(false);
    else if (e.key === 'r') generate(true);
    else if (e.key === 'f') fitToScreen();
    else if (e.key === 'z' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); undo(); }
  });

  /* ---------------------------------------------------------------------- */
  /* Boot                                                                    */
  /* ---------------------------------------------------------------------- */

  uiRef = GA.ui.build({
    body: document.getElementById('sheetBody'),
    tabsEl: document.getElementById('tabs'),
    get: function (k) { return state.params[k]; },
    onParam: onParam,
    flags: flags,
    onFlag: function (k, v) {
      flags[k] = v;
      if (k === 'plotter' || k === 'showSeeds') draw();
      save();
    },
    onExport: function (kind) {
      if (kind === 'png') exportPNG();
      else if (kind === 'svg') exportSVG();
      else shareArt();
    }
  });

  var restored = load();
  resize();
  // a restored drawing keeps the artboard it was made on, otherwise the stored
  // seed positions would no longer match the composition
  if (!restored || !state.seeds.length) {
    syncArtboard();
    reseed();
  }
  GA.generator.resolveSeeds(state.seeds, state.params);
  fitToScreen(false);
  syncUI();
  request('full');
  if (isWide()) sheet.classList.remove('collapsed');

  window.addEventListener('resize', function () {
    clearTimeout(window.__rz);
    window.__rz = setTimeout(resize, 120);
  });
  window.addEventListener('orientationchange', function () {
    userMovedView = false;
    setTimeout(resize, 220);
  });

  // first-run hint
  if (!localStorage.getItem(STORE_KEY + '.seen')) {
    var hint = document.getElementById('hint');
    setTimeout(function () { hint.classList.add('show'); }, 700);
    setTimeout(function () { hint.classList.remove('show'); }, 5200);
    try { localStorage.setItem(STORE_KEY + '.seen', '1'); } catch (e) {}
  }

  // PWA — only meaningful over http(s); opening index.html from disk still works
  if ('serviceWorker' in navigator &&
      (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  root.CONTOURS = { state: state, view: view, draw: draw, request: request,
                    get art() { return art; } };
})(typeof window !== 'undefined' ? window : globalThis);
