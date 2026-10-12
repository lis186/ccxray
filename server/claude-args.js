'use strict';

// Inspect only the common Claude options needed to find --bg/--background.
// This intentionally recognizes exact short-option tokens, not combined short
// flags. Known options also accept their `=value` form without changing argv.
const REQUIRED_VALUE_OPTIONS = new Set([
  '-p', '--print', '-m', '--model', '--session-id',
  '--output-format', '--input-format', '--permission-mode', '--setting-sources',
  '--settings', '--system-prompt', '--append-system-prompt', '--max-turns',
  '--max-budget-usd', '--mcp-config', '--add-dir', '--plugin-dir',
  '--fallback-model', '--json-schema', '--agent', '--effort', '--betas',
]);

const OPTIONAL_VALUE_OPTIONS = new Set(['-r', '--resume']);

const BOOLEAN_OPTIONS = new Set([
  '--bg', '--background', '--verbose', '--debug', '--dangerously-skip-permissions',
]);

function hasClaudeBackgroundFlag(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return false;
    if (arg === '--bg' || arg === '--background') return true;

    const equalsAt = arg.indexOf('=');
    const option = equalsAt < 0 ? arg : arg.slice(0, equalsAt);
    const hasInlineValue = equalsAt >= 0;

    if (REQUIRED_VALUE_OPTIONS.has(option)) {
      if (!hasInlineValue) i++;
      continue;
    }
    if (OPTIONAL_VALUE_OPTIONS.has(option)) {
      if (!hasInlineValue && args[i + 1] && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    if (BOOLEAN_OPTIONS.has(option)) continue;
  }
  return false;
}

module.exports = { hasClaudeBackgroundFlag };
