/*
 * contour.js — marching squares with proper polyline stitching.
 *
 * Slices the scalar field at a given level and returns closed loops / open
 * chains as flat [x0,y0,x1,y1,...] arrays in GRID coordinates.
 *
 * Implementation notes:
 *  - Every crossing point lives on a grid edge, and each edge is shared by two
 *    cells. By keying points on the *edge index* (not on floating point
 *    coordinates) the chains stitch together exactly, with no epsilon matching.
 *  - Buffers are allocated once per Tracer and reused for every level, so
 *    extracting 40 levels costs almost nothing extra.
 *  - Saddle cells (5 and 10) are disambiguated with the cell centre average,
 *    which keeps the topology consistent and avoids "bow tie" crossings.
 */
(function (root) {
  'use strict';
  var GA = (root.GA = root.GA || {});

  function Tracer(gw, gh) {
    this.gw = gw;
    this.gh = gh;
    var E = 2 * gw * gh; // edge slots: horizontal block then vertical block
    this.px = new Float32Array(E);
    this.py = new Float32Array(E);
    this.nb0 = new Int32Array(E);
    this.nb1 = new Int32Array(E);
    this.deg = new Uint8Array(E);
    this.stamp = new Int32Array(E);  // "has this edge a point for this level?"
    this.vis = new Int32Array(E);    // "already consumed by a chain?"
    this.touched = new Int32Array(E);
    this.cur = 0;
  }

  /* Extract every polyline of F at `level`. Returns array of {pts, closed}. */
  Tracer.prototype.trace = function (F, level) {
    var gw = this.gw, gh = this.gh;
    var px = this.px, py = this.py, nb0 = this.nb0, nb1 = this.nb1;
    var deg = this.deg, stamp = this.stamp, vis = this.vis, touched = this.touched;
    var s = ++this.cur;
    var nTouched = 0;
    var HB = 0, VB = gw * gh; // block offsets for horizontal / vertical edges

    /* Lazily create the interpolated point sitting on a horizontal edge. */
    function edgeH(x, y) {
      var e = HB + y * gw + x;
      if (stamp[e] !== s) {
        stamp[e] = s;
        deg[e] = 0;
        vis[e] = 0;
        var i = y * gw + x;
        var a = F[i], b = F[i + 1];
        var t = (level - a) / (b - a);
        if (!(t >= 0)) t = 0; else if (t > 1) t = 1;
        px[e] = x + t;
        py[e] = y;
        touched[nTouched++] = e;
      }
      return e;
    }
    function edgeV(x, y) {
      var e = VB + y * gw + x;
      if (stamp[e] !== s) {
        stamp[e] = s;
        deg[e] = 0;
        vis[e] = 0;
        var i = y * gw + x;
        var a = F[i], b = F[i + gw];
        var t = (level - a) / (b - a);
        if (!(t >= 0)) t = 0; else if (t > 1) t = 1;
        px[e] = x;
        py[e] = y + t;
        touched[nTouched++] = e;
      }
      return e;
    }
    function link(a, b) {
      if (deg[a] === 0) nb0[a] = b; else if (deg[a] === 1) nb1[a] = b; else return;
      deg[a]++;
      if (deg[b] === 0) nb0[b] = a; else if (deg[b] === 1) nb1[b] = a; else return;
      deg[b]++;
    }

    var x, y;
    for (y = 0; y < gh - 1; y++) {
      for (x = 0; x < gw - 1; x++) {
        var i0 = y * gw + x;
        var c00 = F[i0], c10 = F[i0 + 1];
        var c01 = F[i0 + gw], c11 = F[i0 + gw + 1];
        var idx = (c00 < level ? 1 : 0) | (c10 < level ? 2 : 0) |
                  (c11 < level ? 4 : 0) | (c01 < level ? 8 : 0);
        if (idx === 0 || idx === 15) continue;

        // T = top edge, R = right, B = bottom, L = left
        switch (idx) {
          case 1: case 14: link(edgeH(x, y), edgeV(x, y)); break;              // T-L
          case 2: case 13: link(edgeH(x, y), edgeV(x + 1, y)); break;          // T-R
          case 3: case 12: link(edgeV(x, y), edgeV(x + 1, y)); break;          // L-R
          case 4: case 11: link(edgeV(x + 1, y), edgeH(x, y + 1)); break;      // R-B
          case 6: case 9:  link(edgeH(x, y), edgeH(x, y + 1)); break;          // T-B
          case 7: case 8:  link(edgeV(x, y), edgeH(x, y + 1)); break;          // L-B
          case 5:
            // c00 & c11 inside — is the centre inside too?
            if ((c00 + c10 + c01 + c11) * 0.25 < level) {
              link(edgeH(x, y), edgeV(x + 1, y));      // T-R
              link(edgeV(x, y), edgeH(x, y + 1));      // L-B
            } else {
              link(edgeH(x, y), edgeV(x, y));          // T-L
              link(edgeV(x + 1, y), edgeH(x, y + 1));  // R-B
            }
            break;
          case 10:
            if ((c00 + c10 + c01 + c11) * 0.25 < level) {
              link(edgeH(x, y), edgeV(x, y));          // T-L
              link(edgeV(x + 1, y), edgeH(x, y + 1));  // R-B
            } else {
              link(edgeH(x, y), edgeV(x + 1, y));      // T-R
              link(edgeV(x, y), edgeH(x, y + 1));      // L-B
            }
            break;
        }
      }
    }

    /* Walk chains: dangling ends first (open lines), then remaining loops. */
    var result = [];
    var k, e;

    function walk(start) {
      var pts = [];
      var prev = -1, cur = start, closed = false;
      for (;;) {
        vis[cur] = s;
        pts.push(px[cur], py[cur]);
        var a = deg[cur] > 0 ? nb0[cur] : -1;
        var b = deg[cur] > 1 ? nb1[cur] : -1;
        var nxt = -1;
        if (a !== -1 && a !== prev) nxt = a;
        else if (b !== -1 && b !== prev) nxt = b;
        if (nxt === -1) break;
        if (nxt === start) { closed = true; break; }
        if (vis[nxt] === s) break;
        prev = cur;
        cur = nxt;
      }
      if (pts.length >= 6) result.push({ pts: pts, closed: closed });
    }

    for (k = 0; k < nTouched; k++) {
      e = touched[k];
      if (deg[e] === 1 && vis[e] !== s) walk(e);
    }
    for (k = 0; k < nTouched; k++) {
      e = touched[k];
      if (vis[e] !== s && deg[e] >= 2) walk(e);
    }
    return result;
  };

  GA.Tracer = Tracer;
})(typeof window !== 'undefined' ? window : globalThis);
