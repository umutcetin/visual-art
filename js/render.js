/*
 * render.js — draws a generated artwork onto a 2D canvas.
 *
 * The renderer never touches the generation data; it only walks `art.paths` and
 * emits Béziers. Panning and zooming therefore cost a redraw, not a regenerate.
 */
(function (root) {
  'use strict';
  var GA = (root.GA = root.GA || {});

  /*
   * Artwork palettes are a *drawing* decision rather than an interface theme.
   * PRINT provides the fabrication-safe paper/ink pair; SCREEN_DARK provides
   * the inverted monochrome base used when a phone is in dark mode.
   */
  var PRINT = { paper: '#faf8f4', ink: '#16161a' };
  var SCREEN_DARK = { paper: '#141418', ink: '#e9e7e1' };

  var PALETTES = {
    mono: {
      light: ['#16161a'],
      dark: ['#e9e7e1']
    },
    spectrum: {
      light: ['#d62839', '#f26b38', '#e9a820', '#15956f', '#237eae', '#6847c6'],
      dark: ['#ff5d73', '#ff9368', '#ffd166', '#34d6a0', '#4db9e9', '#a58aff']
    },
    sunset: {
      light: ['#c81d25', '#eb5e28', '#f2a900', '#d1495b', '#7b2cbf'],
      dark: ['#ff5964', '#ff8c42', '#ffd166', '#ef6f8f', '#bd7cff']
    },
    lagoon: {
      light: ['#006d77', '#008f8c', '#2a9d8f', '#277da1', '#4f46b8'],
      dark: ['#35d0ba', '#5ce1c8', '#90e0d0', '#58b6e7', '#9b8cff']
    }
  };

  var PAPER = PRINT.paper;
  var INK = PRINT.ink;

  function styleFor(id, dark) {
    var palette = PALETTES[id] || PALETTES.mono;
    var colors = (dark ? palette.dark : palette.light).slice();
    return {
      paper: dark ? SCREEN_DARK.paper : PRINT.paper,
      ink: colors[0],
      colors: colors
    };
  }

  function pathColor(path, index, opt) {
    var colors = opt.colors;
    if (opt.plotter || !colors || colors.length < 2) return opt.ink || INK;
    var level = path.level || 0;
    var key;
    if (opt.colorFlow === 'weave') key = level * 2 + (index % 4);
    else if (opt.colorFlow === 'path') key = (index * 7 + Math.floor(index / 3) * 3);
    else key = level;

    /* While a line is revealing, let it travel through the neighbouring
       colours before resting on its final one. The animation remains finite
       and respects reduced-motion because it uses the existing draw-on pass. */
    if (opt.reveal && opt.reveal[index] > 0 && opt.reveal[index] < 0.999) {
      key += Math.ceil((1 - opt.reveal[index]) * Math.min(3, colors.length - 1));
    }
    key %= colors.length;
    if (key < 0) key += colors.length;
    return colors[key];
  }

  function groupStyled(paths, plotter, opt, include) {
    opt = opt || {};
    var map = {}, order = [], i, key, w, color;
    for (i = 0; i < paths.length; i++) {
      if (include && !include(i, paths[i])) continue;
      w = plotter ? 1 : paths[i].w;
      color = pathColor(paths[i], i, {
        plotter: plotter,
        ink: opt.ink,
        colors: opt.colors,
        colorFlow: opt.colorFlow,
        reveal: opt.reveal
      });
      key = w.toFixed(3) + '|' + color;
      if (!map[key]) {
        map[key] = { w: w, color: color, items: [] };
        order.push(key);
      }
      map[key].items.push({ path: paths[i], index: i });
    }
    return order.map(function (k) { return map[k]; });
  }

  /*
   * ctx      canvas 2D context (already sized in device pixels)
   * art      {artW, artH, paths}
   * opt      {view:{x,y,k}, dpr, width, height, plotter:bool, background:bool,
   *           frame:bool}
   */
  function draw(ctx, art, opt) {
    var dpr = opt.dpr || 1;
    var v = opt.view;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, opt.width, opt.height);

    // page behind the artboard (only visible on screen, never in export)
    if (opt.pageColor) {
      ctx.fillStyle = opt.pageColor;
      ctx.fillRect(0, 0, opt.width, opt.height);
    }

    ctx.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * v.x, dpr * v.y);

    if (opt.background !== false) {
      ctx.fillStyle = opt.paper || PAPER;
      ctx.fillRect(0, 0, art.artW, art.artH);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, art.artW, art.artH);
    ctx.clip();

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.miterLimit = 2;

    if (opt.reveal) drawRevealed(ctx, art, opt);
    else {
      // batch by stroke width so we set state as rarely as possible
      var buckets = groupStyled(art.paths, opt.plotter, opt);
      for (var b = 0; b < buckets.length; b++) {
        var bucket = buckets[b];
        ctx.strokeStyle = bucket.color;
        ctx.lineWidth = bucket.w;
        ctx.beginPath();
        for (var i = 0; i < bucket.items.length; i++) {
          var p = bucket.items[i].path;
          GA.geom.emitPath(p.pts, p.closed, ctx, p.linear);
        }
        ctx.stroke();
      }
    }
    ctx.restore();

    if (opt.frame) {
      ctx.strokeStyle = opt.frameColor || 'rgba(0,0,0,0.16)';
      ctx.lineWidth = 1 / v.k;
      ctx.strokeRect(0, 0, art.artW, art.artH);
    }
  }

  /*
   * Draw-on mode. `opt.reveal[i]` is how much of path i is drawn, 0..1, and
   * `opt.lengths[i]` is its arc length in art units.
   *
   * The trick is a dash pattern of [drawn, everything-else]: with the offset at
   * zero, the first `L*t` of the path strokes and the remainder falls in the
   * gap, so the line grows from its own start point. Paths cannot be batched
   * here — each needs its own dash — which is why the normal renderer above
   * keeps its fast path.
   */
  function drawRevealed(ctx, art, opt) {
    var paths = art.paths, reveal = opt.reveal, lengths = opt.lengths;
    var n = paths.length;
    var i, p, t, w;

    /*
     * Only the handful of lines currently mid-draw need their own dash state.
     * Everything already finished is batched exactly like the static renderer,
     * which is what keeps the frame cost flat as the drawing fills in — and
     * finished lines are the vast majority for most of the animation.
     */
    var finished = groupStyled(paths, opt.plotter, opt, function (idx) {
      return reveal[idx] >= 0.999;
    });
    ctx.setLineDash([]);
    for (var k = 0; k < finished.length; k++) {
      var bucket = finished[k];
      ctx.lineWidth = bucket.w;
      ctx.strokeStyle = bucket.color;
      ctx.beginPath();
      for (i = 0; i < bucket.items.length; i++) {
        p = bucket.items[i].path;
        GA.geom.emitPath(p.pts, p.closed, ctx, p.linear);
      }
      ctx.stroke();
    }

    for (i = 0; i < n; i++) {
      t = reveal[i];
      if (t <= 0.001 || t >= 0.999) continue;   // a 0-length dash stamps a dot
      p = paths[i];
      ctx.lineWidth = opt.plotter ? 1 : p.w;
      ctx.strokeStyle = pathColor(p, i, opt);
      // slight overshoot: the Bézier is a touch longer than the polyline it was
      // measured from, and running over is better than a visible gap at the end
      var L = lengths[i] * 1.04;
      ctx.setLineDash([L * t, L * 2]);
      ctx.lineDashOffset = 0;
      ctx.beginPath();
      GA.geom.emitPath(p.pts, p.closed, ctx, p.linear);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  /* In plotter mode every line gets exactly the same weight. */
  function groupByWidth(paths, plotter) {
    var map = {}, order = [], i, key;
    for (i = 0; i < paths.length; i++) {
      var w = plotter ? 1 : paths[i].w;
      key = w.toFixed(3);
      if (!map[key]) { map[key] = { w: w, paths: [] }; order.push(key); }
      map[key].paths.push(paths[i]);
    }
    return order.map(function (k) { return map[k]; });
  }

  /* Draw the seed handles (screen space, never exported). */
  function drawSeeds(ctx, seeds, opt) {
    var dpr = opt.dpr || 1, v = opt.view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // handles read as ink on paper, so they invert along with the drawing
    var fill = opt.ink || INK;
    var halo = opt.paper || PAPER;
    for (var i = 0; i < seeds.length; i++) {
      var s = seeds[i];
      var sx = s.x * v.k + v.x;
      var sy = s.y * v.k + v.y;
      var active = opt.activeIndex === i;
      var r = active ? 9 : 5.5;
      ctx.globalAlpha = active ? 0.9 : 0.3;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.strokeStyle = halo;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  GA.render = {
    draw: draw, drawSeeds: drawSeeds, groupByWidth: groupByWidth,
    groupStyled: groupStyled, pathColor: pathColor, styleFor: styleFor,
    PALETTES: PALETTES,
    PAPER: PAPER, INK: INK, PRINT: PRINT, SCREEN_DARK: SCREEN_DARK
  };
})(typeof window !== 'undefined' ? window : globalThis);
