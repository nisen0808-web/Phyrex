'use strict';

const packageInfo = require('../package.json');

const RELEASE_CHANNEL = 'stable';
const API_VERSION = 1;

function getVersionInfo(options = {}) {
  return {
    service: options.service || 'phyrex-world-engine',
    version: options.version || packageInfo.version || '0.0.0',
    channel: options.channel || process.env.PHYREX_RELEASE_CHANNEL || RELEASE_CHANNEL,
    apiVersion: API_VERSION,
    node: process.version,
    buildSha: options.buildSha || process.env.PHYREX_BUILD_SHA || null,
    buildDate: options.buildDate || process.env.PHYREX_BUILD_DATE || null,
  };
}

module.exports = {
  RELEASE_CHANNEL,
  API_VERSION,
  getVersionInfo,
};
