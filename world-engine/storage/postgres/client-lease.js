'use strict';
const { databaseError } = require('./config');
const { performance } = require('node:perf_hooks');

function unavailable(stage) {
  return databaseError('UNAVAILABLE', `PostgreSQL ${stage} did not complete`);
}

// pg's server-side statement_timeout cannot detect a lost reply or a blackholed
// connection. Destroy an expired lease; never return a still-running query to
// the pool. Destroyed clients retain a harmless listener for late driver errors.
function guardClientLease(client, { queryTimeoutMillis = 30000, checkDeadline } = {}) {
  let failure = null, released = false;
  const pending = new Set();
  const onError = () => destroy(unavailable('connection'));
  client.on?.('error', onError);

  function destroy(error = unavailable('connection')) {
    failure ||= error;
    for (const query of [...pending]) query.reject(failure);
    if (released) return;
    released = true;
    client.once?.('end', () => client.removeListener?.('error', onError));
    try { client.release(true); }
    catch (_) {
      // Do not allow a misbehaving injected driver's cleanup to hide the error.
      try { Promise.resolve(client.end?.()).catch(() => {}); } catch (_) {}
    }
  }

  return {
    query(...args) {
      const deadlineFailure = checkDeadline?.();
      if (deadlineFailure) destroy(deadlineFailure);
      if (failure || released) return Promise.reject(failure || unavailable('lease'));
      return new Promise((resolve, reject) => {
        let done = false, timer;
        const deadline = performance.now() + queryTimeoutMillis;
        const check = () => {
          const error = checkDeadline?.();
          if (error || performance.now() >= deadline) destroy(error || unavailable('query deadline'));
        };
        const entry = {
          reject(error) {
            if (done) return;
            done = true; clearTimeout(timer); pending.delete(entry); reject(error);
          },
        };
        pending.add(entry);
        timer = setTimeout(() => destroy(unavailable('query deadline')), queryTimeoutMillis);
        Promise.resolve().then(() => {
          check();
          if (failure || released) throw failure || unavailable('lease');
          return client.query(...args);
        }).then(result => {
          check();
          if (done) return;
          if (failure) { entry.reject(failure); return; }
          done = true; clearTimeout(timer); pending.delete(entry); resolve(result);
        }, error => { check(); entry.reject(failure || error); });
      });
    },
    destroy,
    release(broken = false) {
      if (released) return;
      if (broken || failure || pending.size) { destroy(); return; }
      released = true;
      // The pool installs its idle error listener before ours is removed.
      try { client.release(false); }
      finally { client.removeListener?.('error', onError); }
    },
  };
}

function destroyLateClient(client) {
  // Acquisition timed out before this client arrived: destroy without SQL.
  guardClientLease(client).destroy(unavailable('connection acquisition'));
}

function createClientLeaseManager(pool, config) {
  const operations = new Set();
  let closing = false, closePromise = null;
  let closeDeadline = Infinity, closeTimer, closeSettled = false, endStarted = false;
  let resolveClose, rejectClose;

  function finishClose(error, value) {
    if (closeSettled) return;
    closeSettled = true; clearTimeout(closeTimer);
    if (error) rejectClose(error); else resolveClose(value);
  }
  function endWhenDrained() {
    if (!closing || operations.size || endStarted) return;
    endStarted = true;
    Promise.resolve().then(() => pool.end()).then(value => {
      finishClose(performance.now() >= closeDeadline ? unavailable('close deadline') : null, value);
    }, error => finishClose(error));
  }
  function expireClose() {
    if (closeSettled) return;
    for (const operation of [...operations]) operation.cancel(unavailable('close deadline'));
    endWhenDrained();
    finishClose(unavailable('close deadline'));
  }

  function withClient(work) {
    if (closing) return Promise.reject(databaseError('CLOSED', 'PostgreSQL store is closed'));
    let lease = null, failure = null, settled = false, timer, cancelAcquire;
    const deadline = performance.now() + config.transactionTimeoutMillis;
    let resolveResult, rejectResult;
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const operation = { hasLease: () => !!lease, cancel(error) {
      if (settled) return;
      failure = error;
      cancelAcquire?.(error);
      lease?.destroy(error);
      finish(error);
    } };
    function finish(error, value) {
      if (settled) return;
      if (!error && performance.now() >= deadline) { operation.cancel(unavailable('transaction deadline')); return; }
      if (!error && closing && performance.now() >= closeDeadline) { expireClose(); return; }
      settled = true; clearTimeout(timer); operations.delete(operation);
      try { lease?.release(); } catch (_) { error ||= unavailable('lease release'); }
      if (error) rejectResult(error); else resolveResult(value);
      endWhenDrained();
    }
    function acquire() {
      return new Promise((resolve, reject) => {
        let acquired = false;
        const acquisitionDeadline = performance.now() + config.connectionTimeoutMillis;
        const acquisitionTimer = setTimeout(() => cancel(unavailable('connection deadline')), config.connectionTimeoutMillis);
        function cancel(error) {
          if (acquired) return;
          acquired = true; clearTimeout(acquisitionTimer); reject(error);
        }
        cancelAcquire = cancel;
        Promise.resolve().then(() => {
          if (failure) throw failure;
          if (performance.now() >= acquisitionDeadline) throw unavailable('connection deadline');
          return pool.connect();
        }).then(client => {
          if (!acquired && performance.now() >= acquisitionDeadline) cancel(unavailable('connection deadline'));
          if (acquired || failure || closing) { destroyLateClient(client); return; }
          acquired = true; clearTimeout(acquisitionTimer); cancelAcquire = null; resolve(client);
        }, error => cancel(error));
      });
    }
    operations.add(operation);
    // Total budget includes pool acquisition, BEGIN/COMMIT and non-query awaits
    // inside work (for example a backup sink), rather than resetting per SQL.
    timer = setTimeout(() => operation.cancel(unavailable('transaction deadline')), config.transactionTimeoutMillis);
    Promise.resolve().then(async () => {
      if (failure) throw failure;
      const client = await acquire();
      if (failure || closing) { destroyLateClient(client); throw failure || unavailable('close'); }
      lease = guardClientLease(client, { ...config, checkDeadline: () => {
        if (closing && performance.now() >= closeDeadline) expireClose();
        if (!failure && performance.now() >= deadline) operation.cancel(unavailable('transaction deadline'));
        return failure;
      } });
      return work(lease);
    }).then(value => finish(null, value), error => finish(error));
    return result;
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closeDeadline = performance.now() + config.closeTimeoutMillis;
    closePromise = new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    closeTimer = setTimeout(expireClose, config.closeTimeoutMillis);
    // Deny new work and cancel acquisitions, but preserve the existing close
    // contract: checked-out work may finish within this one total close budget.
    // On expiry all remaining leases are destroyed, including non-query awaits.
    for (const operation of [...operations]) {
      if (!operation.hasLease()) operation.cancel(unavailable('close'));
    }
    endWhenDrained();
    return closePromise;
  }
  return { withClient, close };
}

module.exports = { guardClientLease, createClientLeaseManager };
