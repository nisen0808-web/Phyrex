'use strict';
const fs = require('fs');
const path = require('path');

// Exact, immutable allowlist: never resolve a request path on the filesystem.
// The legacy local demo and its debug/account endpoints are not exposed here.
function createConsoleAssets() {
  const assets = new Map();
  for (const [route, file, mime] of [
    ['/', 'index.html', 'text/html'],
    ['/console/style.css', 'style.css', 'text/css'],
    ['/console/app.mjs', 'app.mjs', 'text/javascript'],
    ['/console/session.mjs', 'session.mjs', 'text/javascript'],
    ['/console/guide.mjs', 'guide.mjs', 'text/javascript'],
  ]) assets.set(route, { body: fs.readFileSync(path.join(__dirname, '../client/durable', file)), mime });
  return assets;
}
function serveConsoleAsset(req, res, asset) {
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Type', `${asset.mime}; charset=utf-8`);
  res.setHeader('Content-Length', asset.body.length);
  res.statusCode = 200;
  req.resume();
  res.end(req.method === 'HEAD' ? undefined : asset.body);
}
module.exports = { createConsoleAssets, serveConsoleAsset };
