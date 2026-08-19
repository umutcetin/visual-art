/*
 * rng.js — deterministic pseudo random numbers.
 *
 * Everything in the generator is driven by one integer seed so that the same
 * seed always reproduces exactly the same drawing. We never call Math.random()
 * inside the generation pipeline.
 */
(function (root) {
  'use strict';
  var GA = (root.GA = root.GA || {});

  /* mulberry32 — small, fast, good enough distribution for graphics work. */
  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function RNG(seed) {
    this._n = mulberry32(seed | 0);
  }

  /* uniform [0,1) */
  RNG.prototype.next = function () {
    return this._n();
  };
  /* uniform [a,b) */
  RNG.prototype.f = function (a, b) {
    return a + (b - a) * this._n();
  };
  /* integer [a,b] inclusive */
  RNG.prototype.i = function (a, b) {
    return a + Math.floor(this._n() * (b - a + 1));
  };
  /* true with probability p */
  RNG.prototype.chance = function (p) {
    return this._n() < p;
  };
  RNG.prototype.pick = function (arr) {
    return arr[Math.floor(this._n() * arr.length) % arr.length];
  };
  /* roughly normal, mean 0 stddev 1 (sum of 3 uniforms) */
  RNG.prototype.gauss = function () {
    return (this._n() + this._n() + this._n() - 1.5) * 1.4142;
  };
  /* a fresh independent stream, derived deterministically */
  RNG.prototype.fork = function (salt) {
    return new RNG((Math.floor(this._n() * 0xffffffff) ^ (salt | 0)) | 0);
  };

  GA.RNG = RNG;
  GA.randomSeed = function () {
    return (Math.floor(Math.random() * 0xffffff) + 1) | 0;
  };
})(typeof window !== 'undefined' ? window : globalThis);
