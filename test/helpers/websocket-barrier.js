'use strict';

// ponytail: bounded barrier — rejects on close/error/timeout instead of hanging forever
function waitForFrame(ws, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('barrier timeout: no matching frame')); }, timeoutMs);
    const onMsg = d => {
      if (predicate(d)) { cleanup(); resolve(); }
    };
    const onClose = () => { cleanup(); reject(new Error('ws closed before matching frame')); };
    const onError = err => { cleanup(); reject(err); };
    function cleanup() { clearTimeout(timer); ws.off('message', onMsg); ws.off('close', onClose); ws.off('error', onError); }
    ws.on('message', onMsg);
    ws.on('close', onClose);
    ws.on('error', onError);
  });
}

module.exports = { waitForFrame };
