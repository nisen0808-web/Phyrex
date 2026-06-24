'use strict';

function installHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

module.exports = { installHeaders };
