'use strict';

const childProcess = require('child_process');

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sendSignal(child, signal, platform) {
  try {
    if (platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function taskkill(child, spawnImpl, graceMs) {
  if (!child.pid) return;
  await new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, graceMs);
    let killer;
    try {
      killer = spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
    } catch {
      finish();
      return;
    }
    killer.once('error', finish);
    killer.once('exit', finish);
  });
  try { child.kill(); } catch {}
}

async function defaultTerminate(child, { platform, graceMs, spawnImpl }) {
  if (platform === 'win32') {
    await taskkill(child, spawnImpl, graceMs);
    return;
  }
  try { sendSignal(child, 'SIGTERM', platform); } catch {}
  await wait(graceMs);
  try { sendSignal(child, 'SIGKILL', platform); } catch {}
}

function runBounded({
  file,
  args = [],
  env = process.env,
  cwd,
  deadlineMs = 10_000,
  graceMs = 2_000,
  drainMs = 500,
  maxOutputBytes = 65_536,
}, deps = {}) {
  const platform = deps.platform || process.platform;
  const spawnImpl = deps.spawn || childProcess.spawn;
  const terminate = deps.terminate || ((child, options) => defaultTerminate(child, options));
  const startedAt = Date.now();

  return new Promise(resolve => {
    let child;
    let mode = 'running';
    let exitCode = null;
    let signal = null;
    let exitSeen = false;
    let drainTimer = null;
    let deadlineTimer = null;
    let settling = false;
    let terminationStarted = false;
    let terminationFinished = false;
    let terminationPromise = null;
    let pendingFinish = null;
    let bytes = 0;
    let truncated = false;
    const chunks = { stdout: [], stderr: [] };
    const pipeDone = { stdout: false, stderr: false };

    const output = name => Buffer.concat(chunks[name]).toString('utf8');
    const finish = (status, options = {}) => {
      if (settling) return;
      if (terminationStarted && !terminationFinished
          && (status === 'timeout' || status === 'output-capped')) {
        pendingFinish = { status, options };
        return;
      }
      settling = true;
      clearTimeout(deadlineTimer);
      clearTimeout(drainTimer);
      const { drainComplete = false, error } = options;
      resolve({
        status,
        exitCode,
        signal,
        stdout: output('stdout'),
        stderr: output('stderr'),
        truncated,
        drainComplete,
        durationMs: Date.now() - startedAt,
        ...(error ? { error } : {}),
      });
    };

    const terminateOnce = () => {
      if (terminationPromise) return terminationPromise;
      terminationStarted = true;
      terminationPromise = new Promise(resolveTermination => {
        let done = false;
        const finishTermination = () => {
          if (done) return;
          done = true;
          clearTimeout(boundTimer);
          terminationFinished = true;
          resolveTermination();
          if (pendingFinish) {
            const pending = pendingFinish;
            pendingFinish = null;
            finish(pending.status, pending.options);
          }
        };
        const boundTimer = setTimeout(finishTermination, Math.max(100, graceMs * 2));
        Promise.resolve()
          .then(() => terminate(child, { platform, graceMs, spawnImpl }))
          .then(finishTermination, finishTermination);
      });
      return terminationPromise;
    };

    const drain = () => {
      if (settling || !exitSeen) return;
      if (pipeDone.stdout && pipeDone.stderr) {
        finish(mode === 'running' ? 'exited' : mode, { drainComplete: true });
        return;
      }
      if (drainTimer) return;
      drainTimer = setTimeout(() => {
        for (const name of ['stdout', 'stderr']) {
          if (!pipeDone[name]) {
            try { child?.[name]?.destroy(); } catch {}
          }
        }
        finish(mode === 'running' ? 'exited' : mode, { drainComplete: false });
      }, Math.max(0, drainMs));
    };

    const stop = async status => {
      if (settling || mode !== 'running') return;
      mode = status;
      clearTimeout(deadlineTimer);
      await terminateOnce();
      if (settling) return;
      if (exitSeen) {
        drain();
        return;
      }
      const remaining = Math.max(0, graceMs);
      const waitForExit = new Promise(resolveExit => {
        if (exitSeen) return resolveExit();
        const timer = setTimeout(resolveExit, remaining);
        child?.once?.('exit', () => {
          clearTimeout(timer);
          resolveExit();
        });
      });
      await waitForExit;
      if (exitSeen) drain();
      else {
        for (const name of ['stdout', 'stderr']) {
          try { child?.[name]?.destroy(); } catch {}
        }
        finish(status, { drainComplete: false });
      }
    };

    try {
      child = spawnImpl(file, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: platform !== 'win32',
      });
    } catch (error) {
      finish('spawn-error', { error: error.message });
      return;
    }

    for (const name of ['stdout', 'stderr']) {
      const stream = child?.[name];
      if (!stream) {
        pipeDone[name] = true;
        continue;
      }
      stream.on('data', chunk => {
        if (settling || mode === 'output-capped') return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = Math.max(0, maxOutputBytes - bytes);
        const kept = buffer.subarray(0, remaining);
        if (kept.length) chunks[name].push(kept);
        bytes += buffer.length;
        if (bytes > maxOutputBytes) {
          truncated = true;
          mode = 'output-capped';
          clearTimeout(deadlineTimer);
          try { child.stdout?.destroy(); } catch {}
          try { child.stderr?.destroy(); } catch {}
          void terminateOnce().then(() => {
            if (settling) return;
            if (exitSeen) finish('output-capped', { drainComplete: false });
            else {
              const timer = setTimeout(() => finish('output-capped', { drainComplete: false }), Math.max(0, graceMs));
              child.once?.('exit', () => {
                clearTimeout(timer);
                finish('output-capped', { drainComplete: false });
              });
            }
          }).catch(() => finish('output-capped', { drainComplete: false }));
        }
      });
      stream.once('end', () => { pipeDone[name] = true; drain(); });
      stream.once('close', () => { pipeDone[name] = true; drain(); });
    }

    child.once('error', error => {
      if (settling) return;
      finish('spawn-error', { error: error.message });
    });
    child.once('exit', (code, childSignal) => {
      if (settling) return;
      exitSeen = true;
      exitCode = code;
      signal = childSignal;
      if (mode === 'running') mode = 'exited';
      drain();
    });

    deadlineTimer = setTimeout(() => { void stop('timeout'); }, Math.max(0, deadlineMs));
  });
}

module.exports = { runBounded };
