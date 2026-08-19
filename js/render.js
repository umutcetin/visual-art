/*
 * render.js — draws a generated artwork onto a 2D canvas.
 *
 * The renderer never touches the generation data; it only walks `art.paths` and
 * emits Béziers. Panning and zooming therefore cost a redraw, not a regenerate.
 */
(function (root) {
  'use strict';
  var GA = (root.GA = root.GA || {});

  var PAPER = '#faf8f4';
  var INK = '#16161a';

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
      ctx.fillStyle = PAPER;
      ctx.fillRect(0, 0, art.artW, art.artH);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, art.artW, art.artH);
    ctx.clip();

    ctx.strokeStyle = opt.ink || INK;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.miterLimit = 2;

    // batch by stroke width so we set state as rarely as possible
    var buckets = groupByWidth(art.paths, opt.plotter);
    for (var b = 0; b < buckets.length; b++) {
      var bucket = buckets[b];
      ctx.lineWidth = bucket.w;
      ctx.beginPath();
      for (var i = 0; i < bucket.paths.length; i++) {
        var p = bucket.paths[i];
        GA.geom.emitPath(p.pts, p.closed, ctx);
      }
      ctx.stroke();
    }
    ctx.restore();

    if (opt.frame) {
      ctx.strokeStyle = 'rgba(0,0,0,0.16)';
      ctx.lineWidth = 1 / v.k;
      ctx.strokeRect(0, 0, art.artW, art.artH);
    }
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
    for (var i = 0; i < seeds.length; i++) {
      var s = seeds[i];
      var sx = s.x * v.k + v.x;
      var sy = s.y * v.k + v.y;
      var active = opt.activeIndex === i;
      ctx.beginPath();
      ctx.arc(sx, sy, active ? 9 : 5.5, 0, Math.PI * 2);
      ctx.fillStyle = active ? 'rgba(20,20,24,0.9)' : 'rgba(20,20,24,0.28)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx, sy, active ? 9 : 5.5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(250,248,244,0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  GA.render = { draw: draw, drawSeeds: drawSeeds, PAPER: PAPER, INK: INK, groupByWidth: groupByWidth };
})(typeof window !== 'undefined' ? window : globalThis);
