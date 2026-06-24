'use strict';

const http = require('http');

const host = process.env.MUD_HEALTH_HOST || '127.0.0.1';
const port = Number(process.env.PORT || process.env.MUD_PORT || 8790);
const timeoutMs = Number(process.env.MUD_HEALTH_TIMEOUT_MS || 3000);

const request = http.get({
  host,
  port,
  path: '/ready',
  timeout: timeoutMs,
  headers: { Accept: 'application/json' },
}, response => {
  const chunks = [];
  response.on('data', chunk => chunks.push(chunk));
  response.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch (_error) { payload = {}; }
    if (response.statusCode === 200 && payload.ready === true) process.exit(0);
    console.error(JSON.stringify({ ok: false, statusCode: response.statusCode, payload }));
    process.exit(1);
  });
});

request.on('timeout', () => request.destroy(new Error('healthcheck_timeout')));
request.on('error', error => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
