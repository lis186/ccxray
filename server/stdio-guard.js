'use strict';

// A detached hub's stdout/stderr are a FILE on the data disk: hub.js forkHub
// opens hub.log and hands the fd to the child. When that disk fills, a console
// write fails and Node emits 'error' on the stdio stream on a later tick —
// after Console's own swallow listener has already been removed — so with no
// listener the 'error' becomes an uncaughtException and the proxy dies.
// (2026-11-25: the hub logged three ENOSPC write failures, then crashed on the
// next console.error; the stack itself was lost to the same full disk.)
//
// Losing log lines must never take the proxy down. Once a write has failed,
// Node destroys the stream, so the process stays silent until it restarts —
// accepted: there is no disk to log to, and the proxy keeps serving.
function ignoreStdioWriteErrors(streams = [process.stdout, process.stderr]) {
  for (const stream of streams) stream.on('error', () => {});
}

module.exports = { ignoreStdioWriteErrors };
