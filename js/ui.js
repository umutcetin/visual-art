/*
 * ui.js — control construction and chrome behaviour.
 *
 * The controls are described as data and rendered into tabbed panels, so the
 * phone never shows a long vertical wall of sliders: six short sections
 * (Shape, Contours, Distortion, Gaps, Style, Export) with short controls each.
 *
 * Slider protocol: dragging emits phase 'preview' (cheap regeneration), letting
 * go emits phase 'commit' (full quality).
 */
(function (root) {
  'use strict';
  var GA = (root.GA = root.GA || {});

  var SECTIONS = [
    { id: 'shape', label: 'Shape' },
    { id: 'contours', label: 'Contours' },
    { id: 'distortion', label: 'Distortion' },
    { id: 'gaps', label: 'Gaps' },
    { id: 'style', label: 'Style' },
    { id: 'export', label: 'Export' }
  ];

  /*
   * `relayout: true` means changing this value re-places the seed shapes.
   * Everything else keeps the existing seeds so you can tune a composition you
   * already like.
   */
  var CONTROLS = [
    { sec: 'style', type: 'seg', key: 'pattern', label: 'Pattern language',
      options: [['organic', 'Organic'], ['geometric', 'Geometric']], relayout: true },
    { sec: 'style', type: 'palette', key: 'palette', label: 'Colour palette',
      options: [
        ['mono', 'Monochrome', ['#16161a', '#77736b']],
        ['spectrum', 'Spectrum', ['#e63946', '#f4a261', '#e9c46a', '#2a9d8f', '#457b9d', '#6d45c5']],
        ['sunset', 'Sunset', ['#d62828', '#f77f00', '#fcbf49', '#7b2cbf']],
        ['lagoon', 'Lagoon', ['#006d77', '#00a6a6', '#83c5be', '#3a86ff', '#8338ec']]
      ], renderOnly: true },
    { sec: 'style', type: 'seg', key: 'colorFlow', label: 'Colour rhythm',
      options: [['level', 'Rings'], ['weave', 'Weave'], ['path', 'Shuffle']], renderOnly: true },

    { sec: 'shape', type: 'slider', key: 'shapes', label: 'Initial shapes',
      sub: 'How many seed forms to start from', min: 2, max: 14, step: 1, dec: 0, relayout: true },
    { sec: 'shape', type: 'seg', key: 'layout', label: 'Placement',
      options: [['scatter', 'Scatter'], ['grid', 'Grid'], ['cluster', 'Cluster']], relayout: true },
    { sec: 'shape', type: 'slider', key: 'geometry', label: 'Geometry',
      sub: 'Organic blob → soft polygon', min: 0, max: 1, step: 0.01, dec: 2 },
    { sec: 'shape', type: 'slider', key: 'scale', label: 'Overall scale',
      sub: 'Size of everything at once', min: 0.4, max: 2.5, step: 0.01, dec: 2 },

    { sec: 'contours', type: 'slider', key: 'layers', label: 'Contour layers',
      sub: 'Rings grown out of each seed', min: 2, max: 48, step: 1, dec: 0 },
    { sec: 'contours', type: 'slider', key: 'spacing', label: 'Contour spacing',
      sub: 'Distance between neighbouring lines', min: 4, max: 40, step: 0.5, dec: 1 },
    { sec: 'contours', type: 'slider', key: 'lineWidth', label: 'Line thickness',
      min: 0.2, max: 4, step: 0.05, dec: 2 },

    { sec: 'distortion', type: 'slider', key: 'distortion', label: 'Organic distortion',
      sub: 'Bends the whole field', min: 0, max: 1, step: 0.01, dec: 2 },
    { sec: 'distortion', type: 'slider', key: 'repulsion', label: 'Collision / repulsion',
      sub: 'How hard systems push each other away', min: 0, max: 1, step: 0.01, dec: 2 },
    { sec: 'distortion', type: 'slider', key: 'merge', label: 'Merge tendency',
      sub: 'Chance two seeds fuse into one system', min: 0, max: 1, step: 0.01, dec: 2, relayout: true },

    { sec: 'gaps', type: 'slider', key: 'gapProb', label: 'Line gap probability',
      sub: 'Intentional breaks in the contours', min: 0, max: 0.9, step: 0.01, dec: 2 },
    { sec: 'gaps', type: 'slider', key: 'secondary', label: 'Secondary seed chance',
      sub: 'New small shapes born inside the gaps', min: 0, max: 1, step: 0.01, dec: 2, resecondary: true }
  ];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmt(v, dec) {
    return dec === 0 ? String(Math.round(v)) : Number(v).toFixed(dec);
  }

  /* --------------------------------------------------------------------- */
  /* Build                                                                  */
  /* --------------------------------------------------------------------- */

  /*
   * opts = {
   *   body, tabsEl,
   *   get(key), onParam(key, value, phase, meta),
   *   flags, onFlag(key, value),
   *   onExport(kind)
   * }
   */
  function build(opts) {
    var panels = {};
    var widgets = {};
    var tabButtons = {};

    SECTIONS.forEach(function (sec, idx) {
      var tab = el('button', 'tab', sec.label);
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', idx === 0 ? 'true' : 'false');
      tab.addEventListener('click', function () { activate(sec.id); });
      opts.tabsEl.appendChild(tab);
      tabButtons[sec.id] = tab;

      var panel = el('div', 'panel' + (idx === 0 ? ' active' : ''));
      panel.setAttribute('role', 'tabpanel');
      opts.body.appendChild(panel);
      panels[sec.id] = panel;
    });

    function activate(id) {
      SECTIONS.forEach(function (s) {
        panels[s.id].classList.toggle('active', s.id === id);
        tabButtons[s.id].setAttribute('aria-selected', s.id === id ? 'true' : 'false');
      });
      opts.body.scrollTop = 0;
    }

    CONTROLS.forEach(function (c) {
      var w = c.type === 'seg' ? makeSegment(c, opts)
        : c.type === 'palette' ? makePalette(c, opts)
        : makeSlider(c, opts);
      panels[c.sec].appendChild(w.node);
      widgets[c.key] = w;
    });

    var extras = buildExportPanel(panels['export'], opts);

    return {
      activate: activate,
      /* Push current parameter values back into every widget. */
      sync: function () {
        CONTROLS.forEach(function (c) { widgets[c.key].set(opts.get(c.key)); });
      },
      /* The theme can also be changed from the More menu — keep the segmented
         control in the panel in step with it. */
      setTheme: function (v) { extras.theme.set(v); },
      controls: CONTROLS
    };
  }

  /* --------------------------------------------------------------------- */
  /* Slider with tappable numeric field                                     */
  /* --------------------------------------------------------------------- */

  function makeSlider(c, opts) {
    var node = el('div', 'ctl');
    var head = el('div', 'ctl-head');

    var lab = el('div');
    var strong = el('span', 'ctl-label', c.label);
    lab.appendChild(strong);
    if (c.sub) lab.appendChild(el('span', 'ctl-sub', c.sub));

    var val = el('button', 'ctl-val');
    val.type = 'button';
    val.setAttribute('aria-label', c.label + ' value, tap to type');

    head.appendChild(lab);
    head.appendChild(val);

    var wrap = el('div', 'range-wrap');
    var range = document.createElement('input');
    range.type = 'range';
    range.min = c.min;
    range.max = c.max;
    range.step = c.step;
    range.setAttribute('aria-label', c.label);
    wrap.appendChild(range);

    node.appendChild(head);
    node.appendChild(wrap);

    function show(v) { val.textContent = fmt(v, c.dec); }

    // dragging = cheap preview, release = full quality
    range.addEventListener('input', function () {
      var v = parseFloat(range.value);
      show(v);
      opts.onParam(c.key, v, 'preview', c);
    });
    var commit = function () {
      opts.onParam(c.key, parseFloat(range.value), 'commit', c);
    };
    range.addEventListener('change', commit);
    range.addEventListener('pointerup', commit);
    range.addEventListener('keyup', commit);

    /* Tapping the number swaps in a real input so exact values can be typed. */
    val.addEventListener('click', function () {
      var input = document.createElement('input');
      input.type = 'number';
      input.className = 'ctl-val';
      input.value = range.value;
      input.min = c.min; input.max = c.max; input.step = c.step;
      input.inputMode = c.dec === 0 ? 'numeric' : 'decimal';
      head.replaceChild(input, val);
      input.focus();
      input.select();
      var done = function (apply) {
        if (input.parentNode !== head) return;
        if (apply) {
          var v = parseFloat(input.value);
          if (!isNaN(v)) {
            v = Math.min(c.max, Math.max(c.min, v));
            range.value = v;
            show(v);
            opts.onParam(c.key, parseFloat(range.value), 'commit', c);
          }
        }
        head.replaceChild(val, input);
      };
      input.addEventListener('blur', function () { done(true); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); done(true); }
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
      });
    });

    return {
      node: node,
      set: function (v) { range.value = v; show(parseFloat(range.value)); }
    };
  }

  /* --------------------------------------------------------------------- */
  /* Segmented control                                                      */
  /* --------------------------------------------------------------------- */

  function makeSegment(c, opts) {
    var node = el('div', 'ctl');
    var head = el('div', 'ctl-head');
    head.appendChild(el('span', 'ctl-label', c.label));
    node.appendChild(head);

    var seg = el('div', 'seg');
    var buttons = [];
    c.options.forEach(function (o) {
      var b = el('button', null, o[1]);
      b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', function () {
        buttons.forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        opts.onParam(c.key, o[0], 'commit', c);
      });
      seg.appendChild(b);
      buttons.push(b);
    });
    node.appendChild(seg);

    return {
      node: node,
      set: function (v) {
        buttons.forEach(function (b, i) {
          b.setAttribute('aria-pressed', c.options[i][0] === v ? 'true' : 'false');
        });
      }
    };
  }

  function makePalette(c, opts) {
    var node = el('div', 'ctl');
    var head = el('div', 'ctl-head');
    head.appendChild(el('span', 'ctl-label', c.label));
    node.appendChild(head);
    var grid = el('div', 'palette-grid');
    var buttons = [];
    c.options.forEach(function (o) {
      var b = el('button', 'palette-option');
      b.type = 'button';
      b.setAttribute('aria-label', o[1] + ' palette');
      b.setAttribute('aria-pressed', 'false');
      var swatches = el('span', 'palette-swatches');
      o[2].forEach(function (color) {
        var swatch = el('span', 'palette-swatch');
        swatch.style.backgroundColor = color;
        swatches.appendChild(swatch);
      });
      b.appendChild(swatches);
      b.appendChild(el('span', 'palette-name', o[1]));
      b.addEventListener('click', function () {
        buttons.forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        opts.onParam(c.key, o[0], 'commit', c);
      });
      grid.appendChild(b);
      buttons.push(b);
    });
    node.appendChild(grid);
    return {
      node: node,
      set: function (v) {
        buttons.forEach(function (b, i) {
          b.setAttribute('aria-pressed', c.options[i][0] === v ? 'true' : 'false');
        });
      }
    };
  }

  /* --------------------------------------------------------------------- */
  /* Export panel                                                           */
  /* --------------------------------------------------------------------- */

  function buildExportPanel(panel, opts) {
    var stack = el('div', 'stack');

    var row1 = el('div', 'row');
    ['png', 'svg'].forEach(function (kind) {
      var b = el('button', 'btn', kind === 'png' ? 'Download PNG' : 'Download SVG');
      b.addEventListener('click', function () { opts.onExport(kind); });
      row1.appendChild(b);
    });
    stack.appendChild(row1);

    var row2 = el('div', 'row');
    var share = el('button', 'btn', 'Share…');
    share.addEventListener('click', function () { opts.onExport('share'); });
    row2.appendChild(share);
    if (!(navigator.share)) share.disabled = true;
    stack.appendChild(row2);

    stack.appendChild(el('div', 'section-title', 'Output options'));

    var pngScale = makeSlider({
      key: '_pngScale', label: 'PNG resolution', sub: 'Multiplier on the artboard size',
      min: 1, max: 6, step: 0.5, dec: 1
    }, {
      get: function () { return opts.flags.pngScale; },
      onParam: function (k, v) { opts.onFlag('pngScale', v); }
    });
    pngScale.set(opts.flags.pngScale);
    stack.appendChild(pngScale.node);

    /* A checkbox row plus its explanatory note. */
    function toggleRow(key, label, note) {
      var lbl = el('label', 'toggle');
      var text = el('span');
      text.appendChild(el('strong', null, label));
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!opts.flags[key];
      cb.addEventListener('change', function () { opts.onFlag(key, cb.checked); });
      lbl.appendChild(text);
      lbl.appendChild(cb);
      stack.appendChild(lbl);
      if (note) stack.appendChild(el('p', 'note', note));
      return cb;
    }

    toggleRow('background', 'Paper background',
      'Off gives a transparent PNG and a background-free SVG');
    toggleRow('plotter', 'Plotter mode',
      'One uniform hairline weight for every path');
    toggleRow('exportAsShown', 'Match screen colours',
      'Off exports the selected palette on light paper, whatever the theme — ' +
      'that is the version you print, plot or cut.');

    /* ---- screen-only display options --------------------------------- */
    stack.appendChild(el('div', 'section-title', 'Display'));

    var themeCtl = makeSegment({
      key: 'theme', label: 'Theme',
      options: [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']]
    }, {
      onParam: function (k, v) { opts.onFlag('theme', v); }
    });
    themeCtl.set(opts.flags.theme);
    stack.appendChild(themeCtl.node);
    stack.appendChild(el('p', 'note', 'Auto follows your system setting.'));

    toggleRow('animate', 'Draw the lines on',
      'New drawings arrive line by line, innermost first. Off is instant — and ' +
      'it is off anyway if your system asks for reduced motion.');
    toggleRow('invertArt', 'Invert the drawing in dark mode',
      'Off keeps the paper white inside the dark interface — a true preview of ' +
      'what you will print.');
    toggleRow('showSeeds', 'Show seed handles',
      'Handles are on-screen only — they never appear in an exported PNG or SVG.');

    panel.appendChild(stack);
    return { theme: themeCtl };
  }

  /* --------------------------------------------------------------------- */
  /* Popovers                                                               */
  /* --------------------------------------------------------------------- */

  function openPopover(pop, anchor) {
    pop.hidden = false;
    var r = anchor.getBoundingClientRect();
    var pr = pop.getBoundingClientRect();
    var left = Math.min(window.innerWidth - pr.width - 8, Math.max(8, r.left));
    var top = r.bottom + 6;
    if (top + pr.height > window.innerHeight - 8) {
      top = Math.max(8, r.top - pr.height - 6);
    }
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2200);
  }

  GA.ui = {
    build: build,
    SECTIONS: SECTIONS,
    CONTROLS: CONTROLS,
    openPopover: openPopover,
    toast: toast,
    el: el
  };
})(typeof window !== 'undefined' ? window : globalThis);
