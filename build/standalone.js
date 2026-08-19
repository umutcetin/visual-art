/*
 * build/standalone.js — bundles the app into one self-contained HTML file.
 *
 *   node build/standalone.js            -> dist/contours.html   (full document)
 *   node build/standalone.js --body OUT -> body-only fragment, for hosts that
 *                                          supply their own <head> (e.g. a
 *                                          Claude Artifact)
 *
 * Everything is inlined: no relative requests at all, so the file works when
 * opened straight from disk, AirDropped to a phone, or dropped on a static
 * host. Nothing about the generator changes — this only concatenates sources.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = [
  'rng', 'noise', 'edt', 'field', 'contour', 'geom',
  'presets', 'generator', 'render', 'exporters', 'ui', 'app'
];

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function buildBody(opts) {
  const html = read('index.html');
  const css = read('styles.css');

  // take the markup between <body> and </body>, minus the <script src> tags
  let markup = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  markup = markup.replace(/\s*<script src="[^"]*"><\/script>/g, '').trim();

  const js = SCRIPTS.map(
    (n) => `/* ---- js/${n}.js ---- */\n` + read(`js/${n}.js`)
  ).join('\n');

  const parts = [];
  parts.push('<title>Contours — generative topographic drawings</title>');

  if (opts.body) {
    /*
     * The host writes its own <head>, so the viewport rules that stop iOS from
     * pinch-zooming the page have to be installed at runtime instead.
     */
    parts.push(
      '<script>(function(){var m=document.querySelector(\'meta[name="viewport"]\')||' +
      'document.head.appendChild(document.createElement("meta"));' +
      'm.name="viewport";' +
      'm.content="width=device-width, initial-scale=1, maximum-scale=1, ' +
      'user-scalable=no, viewport-fit=cover";})();</script>'
    );
  }

  parts.push('<style>\n' + css + '\n</style>');
  parts.push(markup);
  parts.push('<script>\n' + js + '\n</script>');
  return parts.join('\n\n');
}

/* Split the assembled body back into head-bound and body-bound halves so the
   standalone document has its <style> in <head> and its markup in <body>. */
function buildDocument() {
  const body = buildBody({ body: false });
  const titleEnd = body.indexOf('</title>') + 8;
  const head = body.slice(0, titleEnd);
  const rest = body.slice(titleEnd).trim();
  const styleEnd = rest.indexOf('</style>') + 8;
  const style = rest.slice(0, styleEnd);
  const afterStyle = rest.slice(styleEnd).trim();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#faf8f4">
<meta name="description" content="Generative contour drawings — an offline tool for topographic, biomorphic and architectural line art.">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Contours">
${head}
${style}
</head>
<body>
${afterStyle}
</body>
</html>
`;
}

const args = process.argv.slice(2);
const bodyIdx = args.indexOf('--body');

if (bodyIdx !== -1) {
  const out = args[bodyIdx + 1];
  if (!out) throw new Error('--body needs an output path');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buildBody({ body: true }));
  console.log('wrote', out, (fs.statSync(out).size / 1024).toFixed(0) + ' KB');
} else {
  const out = path.join(ROOT, 'dist', 'contours.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buildDocument());
  console.log('wrote', out, (fs.statSync(out).size / 1024).toFixed(0) + ' KB');
}
