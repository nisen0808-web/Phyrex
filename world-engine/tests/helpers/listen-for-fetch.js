'use strict';
const { randomInt } = require('node:crypto');
// Port 0 can select a Fetch-forbidden port on machines with a customized
// ephemeral range. Keep console fixtures above the highest blocked port in
// Node 20/22 (10080); never disable Fetch's protection or consume a test request.
async function listenForFetch(server) {
  for (let attempt = 0; attempt < 16; attempt++) {
    try { await new Promise((resolve, reject) => {
      const failed = error => { server.off('listening', listening); reject(error); };
      const listening = () => { server.off('error', failed); resolve(); };
      server.once('error', failed); server.once('listening', listening);
      // A low customized OS range may keep returning adjacent low ports. After
      // one unsuitable allocation, choose a high candidate and retry collisions.
      server.listen(attempt === 0 ? 0 : randomInt(20000, 60000), '127.0.0.1');
    }); } catch (error) { if (error.code === 'EADDRINUSE') continue; throw error; }
    const port = server.address().port;
    if (port > 10080) return port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  throw new Error('Unable to allocate a Fetch-compatible test port');
}
module.exports = { listenForFetch };
