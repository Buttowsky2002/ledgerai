/**
 * Next.js standalone entry with a longer Node request timeout.
 * Default is 300s; Cursor 90-day syncs via the BFF regularly exceed that.
 */
const http = require('http');

const LONG_MS = 10 * 60 * 1000;
const origListen = http.Server.prototype.listen;
http.Server.prototype.listen = function patchedListen(...args) {
  this.requestTimeout = LONG_MS;
  this.headersTimeout = LONG_MS + 5_000;
  return origListen.apply(this, args);
};

require('./server.js');
