'use strict';

// Recognising agentflow's external runner in tool evidence (docs/agentflow-
// integration.md, E1 and E5). Matching is on text, not parsed JSON: a result may
// be a truncated preview or a wrapper's own printout.

const { stripSlash } = require('../paths');

const CLONE_PATTERN = /\/agentflow-external-runner-[^/]+\/clone\/?$/u;
const NAMES_RUNNER = /external-runner|run_external_command/u;
// Keys only the runner's result carries beside `working_directory`
// (external-runner.js run_external_command's return value).
// Quotes may be double (JSON) or single (a wrapper printing a Python dict).
const RUNNER_KEYS = /["'](?:stdin_closed|stdout_identity|clone_diff_identity|stderr_identity)["']/u;

function unescape(text) {
  return text.includes('\\"') ? text.replace(/\\\\/gu, '\\').replace(/\\"/gu, '"') : text;
}

// Clone paths a tool result reports in the runner's result structure: a
// `clone` object's `root`, a wrapper's `clone.root`, or `working_directory`
// beside the runner's other result keys; with `summary`, also a wrapper's bare
// `clone` key, which proves a known clone (E5) but discovers none (E1). Never a
// checkout root.
function runnerClonePaths(text, { checkoutRoots = [], summary = true } = {}) {
  if (!text) return [];
  const t = unescape(text);
  const found = new Set();
  for (const m of t.matchAll(/["']clone["']\s*:\s*\{[^{}]*?["']root["']\s*:\s*["'](\/[^"']+)["']/gu)) found.add(m[1]);
  for (const m of t.matchAll(/clone\.root["']?\s*[:=]\s*["']?(\/[^\s"',}]+)/gu)) found.add(m[1]);
  if (RUNNER_KEYS.test(t)) for (const m of t.matchAll(/["']working_directory["']\s*:\s*["'](\/[^"']+)["']/gu)) found.add(m[1]);
  // A wrapper's summary naming the clone under a `clone` key.
  if (summary) for (const m of t.matchAll(/["']clone["']\s*:\s*["'](\/[^"']+)["']/gu)) found.add(m[1]);
  const roots = new Set(checkoutRoots.map(stripSlash));
  return [...found].map(stripSlash).filter(p => !roots.has(p));
}

function namesRunner(input) {
  return !!input && NAMES_RUNNER.test(input);
}

// Handles a launch's immediate result returns for later reading: a background
// task id and the file its output is written to (Claude), or the session id of a
// still-running command (Codex).
function launchHandles(result) {
  if (!result) return [];
  const t = unescape(result);
  const out = new Set();
  for (const m of t.matchAll(/"backgroundTaskId"\s*:\s*"([^"]+)"/gu)) out.add(m[1]);
  for (const m of t.matchAll(/running in background with ID:\s*([\w-]+)/gu)) out.add(m[1]);
  for (const m of t.matchAll(/[Oo]utput is being written to:\s*(\/\S+)/gu)) out.add(m[1].replace(/[.,;]$/u, ''));
  // Codex: a command still running is read later through write_stdin's session_id.
  for (const m of t.matchAll(/Process running with session ID (\d+)/gu)) out.add(`"session_id":${m[1]}`);
  return [...out];
}

module.exports = { CLONE_PATTERN, runnerClonePaths, namesRunner, launchHandles };
