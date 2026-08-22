/*
 * field.js — builds the scalar field whose level sets ARE the contour lines.
 *
 * Pipeline for one generation:
 *
 *   1. rasterise every seed shape into a coarse grid  -> mask + group id
 *   2. exact distance transform of the mask           -> signed distance to the
 *                                                        union of all seeds
 *   3. blur slightly                                  -> rounds the creases
 *                                                        where two shapes meet
 *                                                        (soft merging, rule 4)
 *   4. add a ridge along the boundary between groups  -> systems push away from
 *                                                        each other and flow
 *                                                        around (rule 3)
 *   5. domain warp + additive noise                   -> organic irregularity
 *                                                        (rule 5)
 *
 * Slicing that field at 0, s, 2s, 3s ... gives lines that are everywhere ~s
 * apart, always smooth, never crossing.
 */
(function (root) {
  'use strict';
  var GA = (root.GA = root.GA || {});

  /* --------------------------------------------------------------------- */
  /* Seed outline                                                          */
  /* --------------------------------------------------------------------- */

  /*
   * Radius of a seed's closed curve at angle `th`.
   * Two ingredients:
   *   - a few low harmonics -> soft biomorphic blob
   *   - an optional regular polygon term -> soft ceramic-tile geometry
   * They are blended by seed.geo (the "Geometry" slider).
   */
  function seedRadius(s, th) {
    var m = 1, h, k;
    for (k = 0; k < s.harm.length; k++) {
      h = s.harm[k];
      m += h.a * Math.cos(h.m * th + h.p);
    }
    if (s.geo > 0.001) {
      var N = s.sides;
      var step = (Math.PI * 2) / N;
      var a = th + s.rot;
      a = a - Math.floor(a / step) * step - step * 0.5; // fold into [-step/2, step/2]
      var poly = Math.cos(Math.PI / N) / Math.cos(a);   // inradius-normalised n-gon
      m *= 1 - s.geo + s.geo * poly;
    }
    return s.r * m;
  }

  /* Largest possible radius — used to size the rasterisation bounding box. */
  function seedMaxRadius(s) {
    var m = 1, k;
    for (k = 0; k < s.harm.length; k++) m += Math.abs(s.harm[k].a);
    var corner = s.sides ? 1 / Math.cos(Math.PI / s.sides) : 1;
    var polygonReach = 1 + (s.geo || 0) * (corner - 1);
    return s.r * m * polygonReach * 1.05;
  }

  var LUT_N = 1024;

  /* Cache the whole angular profile so the inner loops never call cos/atan2 on
     the harmonics — just one table lookup plus a lerp. */
  function seedLUT(s) {
    if (s._lut) return s._lut;         // cleared by resolveSeeds when params move
    var lut = new Float32Array(LUT_N + 1);
    for (var i = 0; i <= LUT_N; i++) {
      lut[i] = seedRadius(s, (i / LUT_N) * Math.PI * 2 - Math.PI);
    }
    s._lut = lut;
    return lut;
  }

  /* --------------------------------------------------------------------- */
  /* Small helpers                                                         */
  /* --------------------------------------------------------------------- */

  /* Separable box blur, run twice -> close enough to a Gaussian, and cheap. */
  function blur(src, tmp, gw, gh, r) {
    if (r < 1) return src;
    var inv = 1 / (2 * r + 1);
    var x, y, i, sum, k;
    // horizontal
    for (y = 0; y < gh; y++) {
      var row = y * gw;
      sum = 0;
      for (k = -r; k <= r; k++) sum += src[row + Math.min(gw - 1, Math.max(0, k))];
      for (x = 0; x < gw; x++) {
        tmp[row + x] = sum * inv;
        var add = row + Math.min(gw - 1, x + r + 1);
        var sub = row + Math.max(0, x - r);
        sum += src[add] - src[sub];
      }
    }
    // vertical
    for (x = 0; x < gw; x++) {
      sum = 0;
      for (k = -r; k <= r; k++) sum += tmp[Math.min(gh - 1, Math.max(0, k)) * gw + x];
      for (y = 0; y < gh; y++) {
        src[y * gw + x] = sum * inv;
        var addY = Math.min(gh - 1, y + r + 1) * gw + x;
        var subY = Math.max(0, y - r) * gw + x;
        sum += tmp[addY] - tmp[subY];
      }
    }
    return src;
  }

  /* Bilinear sample of a grid, clamped at the borders. */
  function sample(F, gw, gh, gx, gy) {
    if (gx < 0) gx = 0; else if (gx > gw - 1.001) gx = gw - 1.001;
    if (gy < 0) gy = 0; else if (gy > gh - 1.001) gy = gh - 1.001;
    var x0 = gx | 0, y0 = gy | 0;
    var fx = gx - x0, fy = gy - y0;
    var i = y0 * gw + x0;
    var a = F[i], b = F[i + 1], c = F[i + gw], d = F[i + gw + 1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  /* --------------------------------------------------------------------- */
  /* Main entry                                                            */
  /* --------------------------------------------------------------------- */

  /*
   * grid  : {gw, gh, cell, ox, oy}   (ox/oy = world coords of grid cell 0,0)
   * seeds : array of seed objects
   * P     : {sp, distortion, repulsion, mergeBlur}
   * noise : {warp: fbm, jitter: fbm}
   *
   * Returns a Float32Array of signed distances in *world* units.
   */
  function buildField(grid, seeds, P, noise) {
    var gw = grid.gw, gh = grid.gh, cell = grid.cell, ox = grid.ox, oy = grid.oy;
    var n = gw * gh;
    var i, x, y, si;

    var mask = new Uint8Array(n);
    var group = new Int32Array(n);
    for (i = 0; i < n; i++) group[i] = -1;

    /* --- 1. rasterise seeds ------------------------------------------- */
    for (si = 0; si < seeds.length; si++) {
      var s = seeds[si];
      var rmax = s.rMax;
      var x0 = Math.max(0, Math.floor((s.x - rmax - ox) / cell));
      var x1 = Math.min(gw - 1, Math.ceil((s.x + rmax - ox) / cell));
      var y0 = Math.max(0, Math.floor((s.y - rmax - oy) / cell));
      var y1 = Math.min(gh - 1, Math.ceil((s.y + rmax - oy) / cell));
      var painted = false;
      for (y = y0; y <= y1; y++) {
        var wy = oy + y * cell - s.y;
        for (x = x0; x <= x1; x++) {
          var wx = ox + x * cell - s.x;
          var len = Math.sqrt(wx * wx + wy * wy);
          if (len <= seedRadius(s, Math.atan2(wy, wx))) {
            i = y * gw + x;
            mask[i] = 1;
            group[i] = s.group;
            painted = true;
          }
        }
      }
      // a seed smaller than one grid cell would vanish — keep at least one cell
      if (!painted) {
        var cx = Math.round((s.x - ox) / cell);
        var cy = Math.round((s.y - oy) / cell);
        if (cx >= 0 && cx < gw && cy >= 0 && cy < gh) {
          i = cy * gw + cx;
          mask[i] = 1;
          group[i] = s.group;
        }
      }
    }

    /* --- 2. signed distance to the union of all seeds ------------------ */
    var d2out = new Float32Array(n);
    var nearest = new Int32Array(n);
    GA.edt2d(mask, gw, gh, d2out, nearest);

    var inv = new Uint8Array(n);
    for (i = 0; i < n; i++) inv[i] = mask[i] ? 0 : 1;
    var d2in = new Float32Array(n);
    GA.edt2d(inv, gw, gh, d2in, null);

    var F = new Float32Array(n);
    for (i = 0; i < n; i++) {
      // outside: +distance to shape, inside: -distance to boundary
      F[i] = (Math.sqrt(d2out[i]) - Math.sqrt(d2in[i])) * cell;
    }

    /*
     * --- 2b. keep the seed's geometry in the OUTER rings ----------------
     *
     * A true distance offset rounds every corner away: after a few rings a
     * hexagon has become a circle. That is physically correct but it throws
     * away the tile / ceramic character we want. So we also build a purely
     * radial field (|p-c| minus the seed's own profile at that angle), whose
     * level sets keep the angular signature at every radius, and cross-fade
     * between the two with the Geometry slider.
     */
    if (P.geometry > 0.02) {
      var Frad = new Float32Array(n);
      var BIG = 1e9;
      for (i = 0; i < n; i++) Frad[i] = BIG;
      var reach = P.sp * (P.layers + 2);
      for (si = 0; si < seeds.length; si++) {
        var sd = seeds[si];
        var lut = seedLUT(sd);
        var R = reach + sd.rMax;
        var bx0 = Math.max(0, Math.floor((sd.x - R - ox) / cell));
        var bx1 = Math.min(gw - 1, Math.ceil((sd.x + R - ox) / cell));
        var by0 = Math.max(0, Math.floor((sd.y - R - oy) / cell));
        var by1 = Math.min(gh - 1, Math.ceil((sd.y + R - oy) / cell));
        var k = LUT_N / (Math.PI * 2);
        for (y = by0; y <= by1; y++) {
          var ry = oy + y * cell - sd.y;
          for (x = bx0; x <= bx1; x++) {
            var rx = ox + x * cell - sd.x;
            var t = (Math.atan2(ry, rx) + Math.PI) * k;
            var ti = t | 0;
            var tf = t - ti;
            var rad = lut[ti] + (lut[ti + 1] - lut[ti]) * tf;
            var v = Math.sqrt(rx * rx + ry * ry) - rad;
            i = y * gw + x;
            if (v < Frad[i]) Frad[i] = v;
          }
        }
      }
      var g = P.geometry;
      for (i = 0; i < n; i++) {
        if (Frad[i] < BIG) F[i] += g * (Frad[i] - F[i]);
      }
    }

    /* --- 3. soften merges --------------------------------------------- */
    var tmp = new Float32Array(n);
    var blurR = Math.round(Math.min(6, Math.max(0, (P.sp / cell) * P.mergeBlur)));
    if (blurR >= 1) blur(F, tmp, gw, gh, blurR);

    /* --- 4. repulsion ridge between different groups ------------------- */
    if (P.repulsion > 0.001) {
      var seam = new Uint8Array(n);
      var anySeam = false;
      for (y = 0; y < gh; y++) {
        for (x = 0; x < gw; x++) {
          i = y * gw + x;
          var g0 = group[nearest[i]];
          if (x + 1 < gw && group[nearest[i + 1]] !== g0) { seam[i] = 1; seam[i + 1] = 1; anySeam = true; }
          if (y + 1 < gh && group[nearest[i + gw]] !== g0) { seam[i] = 1; seam[i + gw] = 1; anySeam = true; }
        }
      }
      if (anySeam) {
        var d2seam = new Float32Array(n);
        GA.edt2d(seam, gw, gh, d2seam, null);
        // squared distance keeps the bump C1-smooth right on the seam
        var w2 = P.sp * P.sp * 1.15;
        var amp = P.repulsion * P.sp * 2.3;
        var c2 = cell * cell;
        for (i = 0; i < n; i++) {
          F[i] += amp * Math.exp(-(d2seam[i] * c2) / w2);
        }
      }
    }

    /* --- 5. domain warp + jitter --------------------------------------- */
    if (P.distortion > 0.001) {
      var out = new Float32Array(n);
      /*
       * The warp is deliberately LONG wavelength (about twenty line spacings).
       * Short-wavelength warping reads as noise or glitch; long wavelength
       * pulls whole systems into lobed, flowing shapes while every line stays
       * locally parallel to its neighbour. The second, much finer term only
       * nudges the spacing so it is never mechanically even.
       */
      var fq = 1 / (P.sp * 20);
      var fq2 = 1 / (P.sp * 3.5);
      var amp2 = P.distortion * P.sp * 4.6;
      var jit = P.distortion * P.sp * 0.42;
      for (y = 0; y < gh; y++) {
        for (x = 0; x < gw; x++) {
          i = y * gw + x;
          var wxx = ox + x * cell, wyy = oy + y * cell;
          var dx = noise.warp(wxx * fq, wyy * fq) * amp2;
          var dy = noise.warp(wxx * fq + 91.37, wyy * fq - 17.71) * amp2;
          out[i] = sample(F, gw, gh, (wxx + dx - ox) / cell, (wyy + dy - oy) / cell) +
                   noise.jitter(wxx * fq2 - 40.1, wyy * fq2 + 12.9) * jit;
        }
      }
      F = out;
    }

    return F;
  }

  GA.seedRadius = seedRadius;
  GA.seedMaxRadius = seedMaxRadius;
  GA.buildField = buildField;
})(typeof window !== 'undefined' ? window : globalThis);
