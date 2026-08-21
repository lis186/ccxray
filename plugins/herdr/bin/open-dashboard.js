#!/usr/bin/env node
'use strict';

const {
  herdrRuntime,
  resolvePaneSessionId,
  runCcxray,
  statusReport,
  stripAnsi,
} = require('./lib/ccxray');

function main() {
  const env = process.env.CCXRAY_HERDR_NO_BROWSER === '1'
    ? { ...process.env, BROWSER: 'none' }
    : process.env;
  const status = statusReport({ env });
  if (!status.parsed.running) {
    console.log('ccxray hub is not running.');
    console.log('Start ccxray first, then run this action again.');
    process.exit(1);
  }

  // This action ran a bare `ccxray open`, which lands on whatever the dashboard
  // shows by default — so invoking it FROM a pane threw away the one thing the
  // caller knew, which pane they were looking at. Mission Control's `d` has
  // passed --session since it shipped; this is the same deep link from the
  // standalone action, resolved by the same helper the badge uses so the two
  // cannot disagree about which session a pane is on.
  const runtime = herdrRuntime(env);
  const context = runtime.context || {};
  const paneId = runtime.paneId || context.focused_pane_id || null;
  const sessionId = resolvePaneSessionId({ env, paneId, context });
  const args = sessionId ? ['open', '--session', sessionId] : ['open'];
  console.log(sessionId
    ? `opening the dashboard on session ${sessionId}`
    : 'opening the dashboard (this pane has no session id yet)');

  const result = runCcxray(args, { timeoutMs: 8000, env });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');

  if (result.error) {
    console.error(stripAnsi(result.error.message));
    process.exit(1);
  }
  process.exit(result.status == null ? 1 : result.status);
}

// ADR 0015's two-mode shape, so a test can assert the argv without opening a
// browser on the developer's machine.
if (require.main === module) main();

module.exports = { main };
