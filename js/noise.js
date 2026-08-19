/*
 * noise.js — seeded 2D gradient (Perlin) noise + fractal Brownian motion.
 *
 * Used for two things only:
 *   1. domain warping   — bends the whole distance field so contours flow
 *   2. additive jitter  — makes the spacing between contours slightly uneven
 *
 * Both are deliberately low frequency: high frequency noise reads as "glitch",
 * which is exactly the look we are avoiding.
 */
(function (root) {
  'use strict';
  var GA = (root.GA = root.GA || {});

  var GRAD = [
    [1, 1], [-1, 1], [1, -1], [-1, -1],
    [1, 0], [-1, 0], [0, 1], [0, -1]
  ];

  function fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /* Returns a noise2(x,y) function in roughly [-1, 1]. */
  function makeNoise2D(rng) {
    var perm = new Uint8Array(256);
    var i, j, t;
    for (i = 0; i < 256; i++) perm[i] = i;
    for (i = 255; i > 0; i--) {
      j = Math.floor(rng.next() * (i + 1));
      t = perm[i]; perm[i] = perm[j]; perm[j] = t;
    }
    var p = new Uint8Array(512);
    for (i = 0; i < 512; i++) p[i] = perm[i & 255];

    function grad(hash, dx, dy) {
      var g = GRAD[hash & 7];
      return g[0] * dx + g[1] * dy;
    }

    return function noise2(x, y) {
      var xi = Math.floor(x), yi = Math.floor(y);
      var xf = x - xi, yf = y - yi;
      var X = xi & 255, Y = yi & 255;
      var u = fade(xf), v = fade(yf);
      var aa = p[p[X] + Y], ba = p[p[X + 1] + Y];
      var ab = p[p[X] + Y + 1], bb = p[p[X + 1] + Y + 1];
      var x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
      var x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
      return lerp(x1, x2, v);
    };
  }

  /* Classic fBm: a few octaves of the same noise at doubling frequency. */
  function makeFbm(noise2, octaves, gain) {
    octaves = octaves || 3;
    gain = gain == null ? 0.5 : gain;
    // normalising factor so the result stays roughly in [-1,1]
    var norm = 0, a = 1, o;
    for (o = 0; o < octaves; o++) { norm += a; a *= gain; }
    return function (x, y) {
      var amp = 1, freq = 1, sum = 0, k;
      for (k = 0; k < octaves; k++) {
        sum += amp * noise2(x * freq, y * freq);
        amp *= gain;
        freq *= 2.03; // slightly off 2.0 to avoid visible axis alignment
      }
      return sum / norm;
    };
  }

  GA.makeNoise2D = makeNoise2D;
  GA.makeFbm = makeFbm;
})(typeof window !== 'undefined' ? window : globalThis);
