/*
 * exporters.js — PNG, SVG and Web Share.
 *
 * The SVG writer walks exactly the same path list the screen renderer uses and
 * emits `M ... C ...` curves or `M ... L ...` geometric segments. There is no
 * <image> tag anywhere: the file is genuine vector geometry that a plotter or
 * laser cutter can consume directly.
 */
(function (root) {
  'use strict';
  var GA = (root.GA = root.GA || {});

  /* A tiny sink object with the same interface as CanvasRenderingContext2D. */
  function PathSink(dec) {
    this.d = '';
    this.k = Math.pow(10, dec == null ? 2 : dec);
  }
  PathSink.prototype._n = function (v) {
    var r = Math.round(v * this.k) / this.k;
    return r === 0 ? '0' : String(r);
  };
  PathSink.prototype.moveTo = function (x, y) {
    this.d += (this.d ? ' ' : '') + 'M' + this._n(x) + ' ' + this._n(y);
  };
  PathSink.prototype.lineTo = function (x, y) {
    this.d += ' L' + this._n(x) + ' ' + this._n(y);
  };
  PathSink.prototype.bezierCurveTo = function (x1, y1, x2, y2, x, y) {
    this.d += ' C' + this._n(x1) + ' ' + this._n(y1) + ' ' +
              this._n(x2) + ' ' + this._n(y2) + ' ' +
              this._n(x) + ' ' + this._n(y);
  };
  PathSink.prototype.closePath = function () { this.d += ' Z'; };

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /*
   * opt: {background:bool, plotter:bool, ink:string, meta:{seed, preset}}
   */
  function toSVG(art, opt) {
    opt = opt || {};
    var W = art.artW, H = art.artH;
    var ink = opt.ink || GA.render.INK;
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<svg xmlns="http://www.w3.org/2000/svg" version="1.1" ' +
      'width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">');
    if (opt.meta) {
      out.push('  <title>Contour study — seed ' + esc(opt.meta.seed) + '</title>');
      out.push('  <desc>' + esc(JSON.stringify(opt.meta)) + '</desc>');
    }
    out.push('  <defs><clipPath id="board"><rect x="0" y="0" width="' + W +
      '" height="' + H + '"/></clipPath></defs>');
    if (opt.background !== false) {
      out.push('  <rect x="0" y="0" width="' + W + '" height="' + H +
        '" fill="' + (opt.paper || GA.render.PAPER) + '"/>');
    }
    out.push('  <g clip-path="url(#board)" fill="none" ' +
      'stroke-linecap="round" stroke-linejoin="round">');

    var buckets = GA.render.groupStyled(art.paths, opt.plotter, {
      ink: ink,
      colors: opt.colors,
      colorFlow: opt.colorFlow
    });
    for (var b = 0; b < buckets.length; b++) {
      var bucket = buckets[b];
      out.push('    <g stroke="' + bucket.color + '" stroke-width="' +
        (Math.round(bucket.w * 1000) / 1000) + '">');
      for (var i = 0; i < bucket.items.length; i++) {
        var path = bucket.items[i].path;
        var sink = new PathSink(2);
        GA.geom.emitPath(path.pts, path.closed, sink, path.linear);
        if (sink.d) out.push('      <path d="' + sink.d + '"/>');
      }
      out.push('    </g>');
    }
    out.push('  </g>');
    out.push('</svg>');
    return out.join('\n');
  }

  /* Render the artwork to an offscreen canvas at `scale` x artboard size. */
  function toCanvas(art, opt) {
    opt = opt || {};
    var scale = opt.scale || 2;
    var c = document.createElement('canvas');
    c.width = Math.round(art.artW * scale);
    c.height = Math.round(art.artH * scale);
    var ctx = c.getContext('2d');
    GA.render.draw(ctx, art, {
      dpr: 1,
      width: c.width,
      height: c.height,
      view: { x: 0, y: 0, k: scale },
      background: opt.background !== false,
      paper: opt.paper,
      ink: opt.ink,
      colors: opt.colors,
      colorFlow: opt.colorFlow,
      plotter: opt.plotter,
      frame: false
    });
    return c;
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve) {
      if (canvas.toBlob) canvas.toBlob(resolve, 'image/png');
      else {
        var url = canvas.toDataURL('image/png');
        resolve(dataURLtoBlob(url));
      }
    });
  }

  function dataURLtoBlob(url) {
    var parts = url.split(',');
    var bin = atob(parts[1]);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: 'image/png' });
  }

  /*
   * Saving on iOS Safari: the anchor+download route works from iOS 13 up. If the
   * browser refuses it we fall back to opening the blob in a new tab so the user
   * can still long-press / share it.
   */
  function anchorSave(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    try {
      a.click();
    } catch (e) {
      window.open(url, '_blank');
    }
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 4000);
  }

  /*
   * Some hosts sandbox the page so it cannot start a download itself — a Claude
   * Artifact is one — and instead mediate the save through their own confirm
   * dialog. Use that route when it is there, the ordinary anchor everywhere
   * else. Resolves when the file is on its way, rejects with a {code, message}
   * so the caller can say something useful.
   */
  function saveBlob(blob, filename) {
    var c = root.claude;
    if (!c || typeof c.use !== 'function') {
      anchorSave(blob, filename);
      return Promise.resolve({ status: 'saved' });
    }
    return c.use('downloads').then(function (downloads) {
      if (!downloads) {                 // not granted here — try the normal way
        anchorSave(blob, filename);
        return { status: 'saved' };
      }
      return downloads.save({ filename: filename, data: blob });
    });
  }

  /* Turn a host save rejection into something worth reading. */
  function explainSaveError(err, kind) {
    var code = (err && err.code) || 'unavailable';
    if (code === 'declined') return 'Save cancelled';
    if (code === 'rate_limited') return 'Another save is still open — try again in a moment';
    if (code === 'too_large') return 'File is too large to save — lower the PNG resolution';
    if (code === 'extension_not_enabled' || code === 'rejected_extension') {
      return kind === 'svg'
        ? 'SVG saving is not allowed here — run the app from its own page to export vectors'
        : 'This file type cannot be saved here';
    }
    return 'Saving is not available in this window';
  }

  function canShareFiles() {
    return !!(navigator.canShare && navigator.share);
  }

  function shareFile(blob, filename, title) {
    var file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file], title: title });
    }
    return Promise.reject(new Error('unsupported'));
  }

  GA.exporters = {
    toSVG: toSVG,
    toCanvas: toCanvas,
    canvasToBlob: canvasToBlob,
    saveBlob: saveBlob,
    explainSaveError: explainSaveError,
    canShareFiles: canShareFiles,
    shareFile: shareFile,
    PathSink: PathSink
  };
})(typeof window !== 'undefined' ? window : globalThis);
