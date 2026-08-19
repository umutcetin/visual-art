/*
 * edt.js — exact Euclidean distance transform (Felzenszwalb & Huttenlocher).
 *
 * WHY THIS MATTERS FOR THE ART
 * ----------------------------
 * A contour map looks right when successive lines are *truly parallel* — i.e.
 * every line sits at a constant distance from the previous one. If you grow
 * curves by offsetting points along normals you get self intersections and
 * corners. Instead we build a distance field once and slice it at even levels:
 * every level set is then automatically a perfect offset curve, smooth, non
 * self-intersecting, and it merges/splits gracefully. This transform is what
 * makes that cheap: O(number of cells), independent of how many seeds there are.
 */
(function (root) {
  'use strict';
  var GA = (root.GA = root.GA || {});

  var INF = 1e20;

  /*
   * 1D squared distance transform of a sampled function f.
   * v/z are scratch buffers (length n and n+1). Writes squared distances into d
   * and, if `src` is given, the index of the winning site into src.
   */
  function edt1d(f, d, src, v, z, n) {
    var k = 0, q, s;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (q = 1; q < n; q++) {
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      var dq = q - v[k];
      d[q] = dq * dq + f[v[k]];
      if (src) src[q] = v[k];
    }
  }

  /*
   * 2D transform.
   *   mask   : Uint8Array, 1 = site ("inside"), 0 = empty
   *   out    : Float32Array receiving SQUARED distance in cell units
   *   nearest: optional Int32Array receiving the flat index of the nearest site
   */
  function edt2d(mask, gw, gh, out, nearest) {
    var n = Math.max(gw, gh);
    var f = new Float64Array(n);
    var d = new Float64Array(n);
    var v = new Int32Array(n);
    var z = new Float64Array(n + 1);
    var srcY = nearest ? new Int32Array(gw * gh) : null;
    var srcLine = nearest ? new Int32Array(n) : null;
    var x, y, i;

    // pass 1 — down each column
    for (x = 0; x < gw; x++) {
      for (y = 0; y < gh; y++) f[y] = mask[y * gw + x] ? 0 : INF;
      edt1d(f, d, srcLine, v, z, gh);
      for (y = 0; y < gh; y++) {
        out[y * gw + x] = d[y];
        if (nearest) srcY[y * gw + x] = srcLine[y];
      }
    }

    // pass 2 — along each row
    for (y = 0; y < gh; y++) {
      for (x = 0; x < gw; x++) f[x] = out[y * gw + x];
      edt1d(f, d, srcLine, v, z, gw);
      for (x = 0; x < gw; x++) {
        i = y * gw + x;
        out[i] = d[x];
        if (nearest) {
          // winning column is srcLine[x]; within that column the winning row
          // was recorded during pass 1
          var sx = srcLine[x];
          nearest[i] = srcY[y * gw + sx] * gw + sx;
        }
      }
    }
    return out;
  }

  GA.edt2d = edt2d;
  GA.EDT_INF = INF;
})(typeof window !== 'undefined' ? window : globalThis);
