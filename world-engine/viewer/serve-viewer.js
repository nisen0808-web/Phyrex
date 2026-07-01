'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const port = Number(process.env.PORT || process.argv[2] || 8787);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function main() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const pathname = decodeURIComponent(url.pathname);
    const relativePath = pathname === '/' ? 'viewer/index.html' : pathname.replace(/^\//, '');
    const filePath = path.normalize(path.join(root, relativePath));

    if (!filePath.startsWith(root)) {
      send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
      return;
    }

    fs.readFile(filePath, (error, content) => {
      if (error) {
        send(res, 404, `Not found: ${relativePath}`, 'text/plain; charset=utf-8');
        return;
      }
      const type = MIME_TYPES[path.extname(filePath)] || 'application/octet-stream';
      send(res, 200, content, type);
    });
  });

  server.listen(port, () => {
    console.log(`World Engine Viewer: http://localhost:${port}/viewer/index.html`);
    console.log(`Snapshot default:     http://localhost:${port}/output/demo-snapshot.json`);
    console.log(`Performance report:  http://localhost:${port}/output/performance-report.json`);
    console.log('Generate snapshot first with: npm run snapshot');
    console.log('Generate performance report with: npm run performance:report');
  });
}

function send(res, statusCode, body, contentType) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

if (require.main === module) main();
