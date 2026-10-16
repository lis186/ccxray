'use strict';

// Observe close (stdio drained), even when an error precedes it.
function childClosed(child) {
  return new Promise(resolve => {
    let error;
    child.on('error', err => { error = err; });
    child.once('close', (code, signal) => resolve({ code, signal, error }));
  });
}

async function stopChild(child, closed, timeoutMs = 3000) {
  if (!child) return;
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { childClosed, stopChild };
