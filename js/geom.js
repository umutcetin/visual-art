/*
 * geom.js — polyline post processing.
 *
 * Raw marching-squares output is a staircase of tiny segments. To get the soft,
 * drawn-by-hand quality we want, each chain goes through:
 *
 *     resample (even spacing) -> Laplacian smoothing -> Catmull-Rom -> cubic Bézier
 *
 * The Bézier step is important for export: the SVG then contains real curve
 * commands rather than thousands of line segments, which is what a plotter,
 * laser cutter or Illustrator actually wants.
 */
(function (root) {
  'use strict';
  var GA = (root.GA = root.GA || {});

  function polyLength(p, closed) {
    var L = 0, n = p.length / 2, i, ax, ay, bx, by;
    for (i = 0; i < n - 1; i++) {
      ax = p[i * 2]; ay = p[i * 2 + 1];
      bx = p[i * 2 + 2]; by = p[i * 2 + 3];
      L += Math.hypot(bx - ax, by - ay);
    }
    if (closed && n > 1) L += Math.hypot(p[0] - p[(n - 1) * 2], p[1] - p[(n - 1) * 2 + 1]);
    return L;
  }

  /* Resample to (approximately) uniform arc-length steps. */
  function resample(p, step, closed) {
    var pts = p;
    var n = pts.length / 2;
    if (n < 2) return pts;
    if (closed) { pts = pts.slice(); pts.push(pts[0], pts[1]); n++; }

    var out = [pts[0], pts[1]];
    var carry = 0, i;
    for (i = 0; i < n - 1; i++) {
      var ax = pts[i * 2], ay = pts[i * 2 + 1];
      var bx = pts[i * 2 + 2], by = pts[i * 2 + 3];
      var seg = Math.hypot(bx - ax, by - ay);
      if (seg < 1e-9) continue;
      var t = step - carry;
      while (t <= seg) {
        var u = t / seg;
        out.push(ax + (bx - ax) * u, ay + (by - ay) * u);
        t += step;
      }
      carry = seg - (t - step);
    }
    if (closed) {
      // drop a trailing point that lands on top of the first one
      var m = out.length / 2;
      if (m > 2 && Math.hypot(out[out.length - 2] - out[0], out[out.length - 1] - out[1]) < step * 0.5) {
        out.length -= 2;
      }
    } else {
      out.push(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1]);
    }
    return out;
  }

  /* Laplacian smoothing — removes the marching-squares staircase. */
  function smooth(p, closed, iters, lambda) {
    var n = p.length / 2;
    if (n < 3) return p;
    var a = p.slice(), b = new Array(p.length), it, i, pi, ni;
    for (it = 0; it < iters; it++) {
      for (i = 0; i < n; i++) {
        if (!closed && (i === 0 || i === n - 1)) {
          b[i * 2] = a[i * 2]; b[i * 2 + 1] = a[i * 2 + 1];
          continue;
        }
        pi = (i - 1 + n) % n;
        ni = (i + 1) % n;
        b[i * 2] = a[i * 2] + lambda * ((a[pi * 2] + a[ni * 2]) * 0.5 - a[i * 2]);
        b[i * 2 + 1] = a[i * 2 + 1] + lambda * ((a[pi * 2 + 1] + a[ni * 2 + 1]) * 0.5 - a[i * 2 + 1]);
      }
      var t = a; a = b; b = t;
    }
    return a;
  }

  /* Extract the piece of a polyline between arc lengths a and b. */
  function slice(p, closed, a, b) {
    var pts = p, n = p.length / 2;
    if (closed) { pts = p.slice(); pts.push(p[0], p[1]); n++; }
    var out = [], acc = 0, i;
    for (i = 0; i < n - 1; i++) {
      var ax = pts[i * 2], ay = pts[i * 2 + 1];
      var bx = pts[i * 2 + 2], by = pts[i * 2 + 3];
      var seg = Math.hypot(bx - ax, by - ay);
      if (seg < 1e-9) continue;
      var s0 = acc, s1 = acc + seg;
      if (s1 > a && s0 < b) {
        var u0 = Math.max(0, (a - s0) / seg);
        var u1 = Math.min(1, (b - s0) / seg);
        if (out.length === 0) out.push(ax + (bx - ax) * u0, ay + (by - ay) * u0);
        out.push(ax + (bx - ax) * u1, ay + (by - ay) * u1);
      }
      acc = s1;
      if (acc >= b) break;
    }
    return out;
  }

  /*
   * Break a contour into dashes. Returns {parts, gaps} where `gaps` holds the
   * midpoint of each removed piece — those are the places where a secondary
   * seed is allowed to appear (rules 6 and 7).
   */
  function applyGaps(p, closed, rng, opt) {
    var total = polyLength(p, closed);
    if (opt.prob <= 0.0001 || total < opt.every * 0.8) {
      return { parts: [{ pts: p, closed: closed }], gaps: [] };
    }
    var intervals = [], gaps = [];
    var drawStart = 0, probe = 0;
    var guard = 0;
    while (guard++ < 400) {
      probe += rng.f(opt.every * 0.6, opt.every * 1.6);
      if (probe >= total) { intervals.push([drawStart, total]); break; }
      if (rng.chance(opt.prob)) {
        var glen = rng.f(opt.min, opt.max);
        if (probe - drawStart > opt.minSeg) intervals.push([drawStart, probe]);
        gaps.push(probe + glen * 0.5);
        drawStart = probe + glen;
        probe = drawStart;
        if (drawStart >= total) break;
      }
    }

    var parts = [], i;
    for (i = 0; i < intervals.length; i++) {
      var seg = slice(p, closed, intervals[i][0], intervals[i][1]);
      if (seg.length >= 6) parts.push({ pts: seg, closed: false });
    }
    // convert gap arc-lengths into actual points on the curve
    var gapPts = [];
    for (i = 0; i < gaps.length; i++) {
      var g = slice(p, closed, Math.max(0, gaps[i] - 0.5), gaps[i] + 0.5);
      if (g.length >= 2) gapPts.push([g[0], g[1]]);
    }
    return { parts: parts, gaps: gapPts };
  }

  /*
   * Emit a smooth path through `pts` as cubic Béziers (Catmull-Rom converted).
   * `sink` only needs moveTo / bezierCurveTo / closePath, so the exact same code
   * feeds both the canvas renderer and the SVG exporter.
   */
  function emitPath(p, closed, sink, linear) {
    var n = p.length / 2;
    if (n < 2) return;
    var i, p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y;
    sink.moveTo(p[0], p[1]);
    if (linear && sink.lineTo) {
      for (i = 1; i < n; i++) sink.lineTo(p[i * 2], p[i * 2 + 1]);
      if (closed && sink.closePath) sink.closePath();
      return;
    }
    if (n === 2) {
      sink.bezierCurveTo(p[0], p[1], p[2], p[3], p[2], p[3]);
      return;
    }
    var last = closed ? n : n - 1;
    for (i = 0; i < last; i++) {
      var i0 = closed ? (i - 1 + n) % n : Math.max(0, i - 1);
      var i1 = i;
      var i2 = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
      var i3 = closed ? (i + 2) % n : Math.min(n - 1, i + 2);
      p0x = p[i0 * 2]; p0y = p[i0 * 2 + 1];
      p1x = p[i1 * 2]; p1y = p[i1 * 2 + 1];
      p2x = p[i2 * 2]; p2y = p[i2 * 2 + 1];
      p3x = p[i3 * 2]; p3y = p[i3 * 2 + 1];
      sink.bezierCurveTo(
        p1x + (p2x - p0x) / 6, p1y + (p2y - p0y) / 6,
        p2x - (p3x - p1x) / 6, p2y - (p3y - p1y) / 6,
        p2x, p2y
      );
    }
    if (closed && sink.closePath) sink.closePath();
  }

  GA.geom = {
    polyLength: polyLength,
    resample: resample,
    smooth: smooth,
    slice: slice,
    applyGaps: applyGaps,
    emitPath: emitPath
  };
})(typeof window !== 'undefined' ? window : globalThis);
