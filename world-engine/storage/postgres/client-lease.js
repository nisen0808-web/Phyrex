'use strict';
const { databaseError } = require('./config');

// pg's pool error listener covers idle clients, not checked-out clients. A
// disconnect can arrive between queries, including while a backup sink awaits.
function guardClientLease(client) {
  let failure = null;
  const onError = () => { failure ||= databaseError('UNAVAILABLE', 'PostgreSQL connection was lost'); };
  client.on?.('error', onError);
  return {
    async query(...args) {
      if (failure) throw failure;
      try {
        const result = await client.query(...args);
        if (failure) throw failure;
        return result;
      } catch (error) { throw failure || error; }
    },
    release(broken) {
      // Install the pool's idle listener (or destroy) before removing ours.
      try { client.release(broken || !!failure); }
      finally { client.removeListener?.('error', onError); }
    },
  };
}
module.exports = { guardClientLease };
