/*
 * generator.js — seed placement and the full generation pass.
 *
 * Output shape:
 *   { artW, artH, paths: [ {pts:[x,y,...], closed:bool, w:number} ], seeds:[...] }
 *
 * `paths` is resolution independent: the canvas renderer and the SVG exporter
 * both consume it, which is why the SVG contains genuine vector geometry.
 */
(function (root) {
  'use strict';
  var GA = (root.GA = root.GA || {});

  /*
   * Two quality tiers. `preview` is what runs while a slider or a seed is being
   * dragged: coarser grid, fewer noise octaves, lighter smoothing. It is visually
   * very close but several times cheaper, which keeps dragging at interactive
   * speed on a phone. The full pass runs once, on release.
   */
  var QUALITY = {
    preview: { res: 128, smoothIters: 2, octaves: 2, cellCap: 0.7, maxCells: 90000 },
    full: { res: 340, smoothIters: 4, octaves: 3, cellCap: 0.55, maxCells: 220000 }
  };

  /* --------------------------------------------------------------------- */
  /* Seed creation                                                          */
  /* --------------------------------------------------------------------- */

  function makeSeed(rng, x, y, params, groupPool, opts) {
    opts = opts || {};
    var harm = [];
    var count = rng.i(2, 3);
    var used = {};
    for (var k = 0; k < count; k++) {
      var m = rng.pick([2, 3, 3, 4, 5]);
      if (used[m]) m = m + 1;
      used[m] = 1;
      harm.push({
        m: m,
        a: rng.f(0.05, 0.17) * (opts.small ? 0.7 : 1),
        p: rng.f(0, Math.PI * 2)
      });
    }
    /*
     * Group id decides who merges with whom. A new seed either joins an
     * existing group (their contour systems will fuse into one bigger organic
     * shape) or starts its own (their contours will push apart). That is what
     * makes "sometimes merge" controllable rather than random-looking.
     */
    var group;
    if (groupPool.length && rng.chance(params.merge)) {
      group = rng.pick(groupPool);
    } else {
      group = groupPool.length ? Math.max.apply(null, groupPool) + 1 : 0;
      groupPool.push(group);
    }

    var s = {
      x: x,
      y: y,
      rr: opts.small ? rng.f(0.55, 0.95) : rng.f(1.1, 2.3),
      harm: harm,
      geoJ: rng.f(0.72, 1),      // per-seed geometry jitter, applied at resolve
      geo: 0,
      sides: rng.i(4, 7),
      rot: rng.f(0, Math.PI * 2),
      group: group,
      small: !!opts.small
    };
    return s;
  }

  /*
   * Derive the per-seed values that depend on the live parameters. Radii are
   * expressed as a multiple of the contour spacing so the whole composition
   * stays coherent when you change Spacing or Overall scale.
   */
  function resolveSeeds(seeds, params) {
    var sp = params.spacing * params.scale;
    for (var i = 0; i < seeds.length; i++) {
      var s = seeds[i];
      s.r = s.rr * sp;
      s.geo = params.geometry * (s.geoJ == null ? 1 : s.geoJ);
      s.rMax = GA.seedMaxRadius(s);
      s._lut = null;                   // angular profile cache is now stale
    }
    return seeds;
  }

  /*
   * Three placement strategies. Each one deliberately leaves a large empty
   * region so the finished drawing keeps its negative space (rule 9) and is
   * balanced without being symmetric (rule 10).
   */
  function placeSeeds(rng, params, artW, artH) {
    var n = params.shapes;
    var sp = params.spacing * params.scale;
    var reach = sp * params.layers;
    var short = Math.min(artW, artH);
    // keep most of each system on the page — a little clipping reads as a map
    // crop, a lot just looks like a mistake
    var margin = params.layout === 'grid'
      ? short * 0.08                    // a lattice should fill the page
      : Math.max(short * 0.09, Math.min(short * 0.34, reach * 0.62));
    var seeds = [];
    var pool = [];
    var i, tries;

    // a randomly placed "void" the seeds avoid — the main negative-space device
    var void_ = {
      x: rng.f(margin, artW - margin),
      y: rng.f(margin, artH - margin),
      r: Math.min(artW, artH) * rng.f(0.16, 0.3)
    };

    if (params.layout === 'grid') {
      // jittered lattice — reads as decorative / tile-like
      var cols = Math.max(2, Math.round(Math.sqrt(n * (artW / artH))));
      var rows = Math.max(1, Math.ceil(n / cols));
      var cw = (artW - margin * 2) / cols;
      var ch = (artH - margin * 2) / rows;
      var cells = [];
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) cells.push([c, r]);
      }
      // shuffle then take n
      for (i = cells.length - 1; i > 0; i--) {
        var j = rng.i(0, i);
        var t = cells[i]; cells[i] = cells[j]; cells[j] = t;
      }
      for (i = 0; i < Math.min(n, cells.length); i++) {
        var cx = margin + (cells[i][0] + 0.5) * cw + rng.gauss() * cw * 0.16;
        var cy = margin + (cells[i][1] + 0.5) * ch + rng.gauss() * ch * 0.16;
        seeds.push(makeSeed(rng, cx, cy, params, pool));
      }
    } else if (params.layout === 'cluster') {
      // two loose clusters — sparse, architectural, lots of empty ground
      var nc = rng.i(1, 2);
      var centers = [];
      for (i = 0; i < nc; i++) {
        // biased towards the middle of the sheet, but never centred on it
        centers.push([
          Math.max(artW * 0.3, Math.min(artW * 0.7, artW * 0.5 + rng.gauss() * artW * 0.19)),
          Math.max(artH * 0.3, Math.min(artH * 0.7, artH * 0.5 + rng.gauss() * artH * 0.19))
        ]);
      }
      var spread = reach * 0.85;
      for (i = 0; i < n; i++) {
        var ctr = rng.pick(centers);
        var px = ctr[0] + rng.gauss() * spread * 0.6;
        var py = ctr[1] + rng.gauss() * spread * 0.6;
        px = Math.max(margin, Math.min(artW - margin, px));
        py = Math.max(margin, Math.min(artH - margin, py));
        seeds.push(makeSeed(rng, px, py, params, pool));
      }
    } else {
      /*
       * Scatter: best-candidate sampling. The separation is deliberately close
       * to a full system diameter — neighbouring contour systems should meet
       * and deform at their edges, not sit on top of each other. That is what
       * preserves the negative space (rules 8 and 9).
       */
      var minDist = Math.max(reach * 1.15, sp * 4);
      for (i = 0; i < n; i++) {
        var best = null, bestScore = -1;
        for (tries = 0; tries < 40; tries++) {
          var qx = rng.f(margin, artW - margin);
          var qy = rng.f(margin, artH - margin);
          if (Math.hypot(qx - void_.x, qy - void_.y) < void_.r) continue;
          var d = 1e9, m;
          for (m = 0; m < seeds.length; m++) {
            d = Math.min(d, Math.hypot(qx - seeds[m].x, qy - seeds[m].y));
          }
          if (d > bestScore) { bestScore = d; best = [qx, qy]; }
          if (d > minDist) break;
        }
        if (best) seeds.push(makeSeed(rng, best[0], best[1], params, pool));
      }
    }
    return seeds;
  }

  /* --------------------------------------------------------------------- */
  /* Generation                                                             */
  /* --------------------------------------------------------------------- */

  function makeGrid(artW, artH, sp, Q) {
    var pad = sp * 2.2;
    var w = artW + pad * 2, h = artH + pad * 2;
    var cell = Math.max(w, h) / Q.res;
    // never let the grid be so coarse that contours alias into polygons
    cell = Math.min(cell, sp * Q.cellCap);
    var gw = Math.max(8, Math.ceil(w / cell) + 1);
    var gh = Math.max(8, Math.ceil(h / cell) + 1);
    // very small spacing at large scale would otherwise ask for a grid big
    // enough to stall a phone — trade a little crispness for staying responsive
    if (gw * gh > Q.maxCells) {
      cell *= Math.sqrt((gw * gh) / Q.maxCells);
      gw = Math.max(8, Math.ceil(w / cell) + 1);
      gh = Math.max(8, Math.ceil(h / cell) + 1);
    }
    return { gw: gw, gh: gh, cell: cell, ox: -pad, oy: -pad };
  }

  /*
   * One full pass: field -> contours -> smoothing -> gaps.
   * `collectGaps` makes it also return candidate positions for secondary seeds.
   */
  function pass(seeds, params, quality, rngSeed, artW, artH, collectGaps) {
    var Q = QUALITY[quality] || QUALITY.full;
    var sp = params.spacing * params.scale;
    resolveSeeds(seeds, params);

    var grid = makeGrid(artW, artH, sp, Q);
    var nrng = new GA.RNG(rngSeed ^ 0x51ed270b);
    var n2 = GA.makeNoise2D(nrng);
    var n3 = GA.makeNoise2D(nrng);
    var noise = {
      warp: GA.makeFbm(n2, Q.octaves, 0.5),
      jitter: GA.makeFbm(n3, Math.max(1, Q.octaves - 1), 0.5)
    };

    var F = GA.buildField(grid, seeds, {
      sp: sp,
      layers: params.layers,
      geometry: params.geometry,
      distortion: params.distortion,
      repulsion: params.repulsion,
      mergeBlur: 0.34
    }, noise);

    var tracer = new GA.Tracer(grid.gw, grid.gh);
    var rng = new GA.RNG(rngSeed ^ 0x2f9e3a17);
    var paths = [];
    var gapPoints = [];
    var step = Math.max(grid.cell * 1.05, sp * 0.16);
    var minLen = sp * 1.3;

    var gapOpt = {
      prob: params.gapProb,
      every: sp * 4.2,
      min: sp * 0.8,
      max: sp * 2.9,
      minSeg: sp * 1.2
    };

    for (var L = 0; L < params.layers; L++) {
      var level = L * sp;
      var chains = tracer.trace(F, level);
      for (var c = 0; c < chains.length; c++) {
        var ch = chains[c];
        // grid -> world
        var p = ch.pts;
        for (var k = 0; k < p.length; k += 2) {
          p[k] = grid.ox + p[k] * grid.cell;
          p[k + 1] = grid.oy + p[k + 1] * grid.cell;
        }
        if (GA.geom.polyLength(p, ch.closed) < minLen) continue; // drop specks

        p = GA.geom.resample(p, step, ch.closed);
        if (p.length < 6) continue;
        p = GA.geom.smooth(p, ch.closed, Q.smoothIters, 0.55);

        /*
         * Thin the point set before it becomes Béziers. The curve is already
         * smooth, so one control point every half-spacing tracks it to well
         * under a line width — and it cuts the exported SVG (and the redraw
         * cost) by roughly three. Short loops keep a floor of ~14 points so
         * small inner rings do not collapse into triangles.
         */
        var plen = GA.geom.polyLength(p, ch.closed);
        var outStep = Math.min(Math.max(sp * 0.5, grid.cell), plen / 14);
        if (outStep > step * 1.2) {
          p = GA.geom.resample(p, outStep, ch.closed);
          if (p.length < 6) continue;
        }

        // innermost line is the seed outline itself — draw it a touch heavier
        var w = params.lineWidth * (L === 0 ? 1.35 : 1);

        if (params.gapProb > 0.0001 && L > 0) {
          var g = GA.geom.applyGaps(p, ch.closed, rng, gapOpt);
          for (var q = 0; q < g.parts.length; q++) {
            g.parts[q].w = w;
            g.parts[q].level = L;      // drives the draw-on order
            paths.push(g.parts[q]);
          }
          if (collectGaps) {
            for (var z = 0; z < g.gaps.length; z++) gapPoints.push(g.gaps[z]);
          }
        } else {
          paths.push({ pts: p, closed: ch.closed, w: w, level: L });
        }
      }
    }

    return { paths: paths, gapPoints: gapPoints, grid: grid };
  }

  /*
   * Rule 7: some of the gaps we punched into the contours become the birthplace
   * of a new small seed. We find the gaps in a first pass, add the seeds, then
   * rebuild — so the little shapes genuinely interact with the field around
   * them instead of being pasted on top.
   */
  function deriveSecondary(gapPoints, seeds, params, rng, artW, artH) {
    if (!gapPoints.length || params.secondary <= 0.001) return [];
    var sp = params.spacing * params.scale;
    var out = [];
    var pool = [];
    for (var i = 0; i < seeds.length; i++) {
      if (pool.indexOf(seeds[i].group) === -1) pool.push(seeds[i].group);
    }
    var maxNew = Math.max(1, Math.round(params.shapes * 0.9 * params.secondary));
    var minSep = sp * 3.2;
    var order = gapPoints.slice();
    // shuffle so we do not always pick the same (outermost) contours
    for (i = order.length - 1; i > 0; i--) {
      var j = rng.i(0, i);
      var t = order[i]; order[i] = order[j]; order[j] = t;
    }
    for (i = 0; i < order.length && out.length < maxNew; i++) {
      if (!rng.chance(params.secondary * 0.5)) continue;
      var px = order[i][0], py = order[i][1];
      if (px < sp || py < sp || px > artW - sp || py > artH - sp) continue;
      var ok = true, m;
      for (m = 0; m < seeds.length; m++) {
        if (Math.hypot(px - seeds[m].x, py - seeds[m].y) < minSep) { ok = false; break; }
      }
      for (m = 0; m < out.length && ok; m++) {
        if (Math.hypot(px - out[m].x, py - out[m].y) < minSep) ok = false;
      }
      if (!ok) continue;
      out.push(makeSeed(rng, px, py, params, pool, { small: true }));
    }
    return out;
  }

  /*
   * Public entry point.
   *   state.seed    numeric random seed
   *   state.params  all slider values
   *   state.seeds   primary seeds (user editable)
   *   state.secondary cached secondary seeds (null = recompute)
   */
  function generate(state, quality) {
    var params = state.params;
    var artW = state.artW, artH = state.artH;
    var primary = state.seeds;

    var secondary = state.secondary;
    if (quality === 'full' && secondary === null && params.secondary > 0.001) {
      var probe = pass(primary.slice(), params, 'preview', state.seed, artW, artH, true);
      var srng = new GA.RNG(state.seed ^ 0x7a4b19c3);
      secondary = deriveSecondary(probe.gapPoints, primary, params, srng, artW, artH);
      state.secondary = secondary;
    }
    var all = primary.concat(secondary || []);

    var r = pass(all, params, quality, state.seed, artW, artH, false);
    return {
      artW: artW,
      artH: artH,
      paths: r.paths,
      quality: quality,
      seeds: all
    };
  }

  GA.generator = {
    generate: generate,
    placeSeeds: placeSeeds,
    makeSeed: makeSeed,
    resolveSeeds: resolveSeeds
  };
})(typeof window !== 'undefined' ? window : globalThis);
