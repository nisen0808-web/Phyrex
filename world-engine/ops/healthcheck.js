'use strict';

const http = require('http');

function checkHealth(options = {}) {
  const host = options.host || process.env.PHYREX_HEALTH_HOST || '127.0.0.1';
  const port = Number(options.port || process.env.PHYREX_PORT || 8790);
  const timeoutMs = Number(options.timeoutMs || process.env.PHYREX_HEALTH_TIMEOUT_MS || 3000);
  const pathname = options.pathname || '/ready';

  return new Promise((resolve, reject) => {
    const request = http.get({ host, port, path: pathname, timeout: timeoutMs }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(text || '{}'); } catch (_error) {}
        if (response.statusCode >= 200 && response.statusCode < 300 && body?.ok === true) {
          resolve({ ok: true, statusCode: response.statusCode, body });
        } else {
          reject(new Error(`Healthcheck failed: HTTP ${response.statusCode} ${text}`));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error(`Healthcheck timed out after ${timeoutMs}ms`)));
    request.on('error', reject);
  });
}

async function main() {
  try {
    const result = await checkHealth();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  checkHealth,
  main,
};
