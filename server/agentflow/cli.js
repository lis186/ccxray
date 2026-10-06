'use strict';

// `ccxray agentflow report` (docs/agentflow-integration.md, CLI). Dispatched from
// the pre-scan block of server/index.js, so it never boots a server, imports or
// prunes; it only reads.

const fs = require('fs');
const path = require('path');

const HELP = `Usage: ccxray agentflow report [options]

Report token usage, cost and time per Ask of an agentflow notebook.

Options:
  --notebook <path>   Notebook to report (default: ag.json target-doc, else .agentflow/devlog.md)
  --ask <A-NNN>       Only this Ask
  --json              JSON output
  --help              Show this help`;

class UsageError extends Error {}

function parseArgs(argv) {
  if (argv[0] !== 'report') throw new UsageError(argv[0] ? `unknown agentflow command "${argv[0]}"` : 'missing agentflow command');
  const args = { notebook: null, ask: null, json: false, help: false };
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--help' || tok === '-h') args.help = true;
    else if (tok === '--json') args.json = true;
    else if (tok === '--notebook' || tok === '--ask') {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('-')) throw new UsageError(`${tok} needs a value`);
      if (tok === '--notebook') args.notebook = val;
      else if (/^A-\d+$/.test(val)) args.ask = val;
      else throw new UsageError(`--ask expects an Ask id like A-012, got "${val}"`);
      i++;
    } else throw new UsageError(`unknown option "${tok}"`);
  }
  return args;
}

function readSwitches(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'ag.json'), 'utf8')).switches || {};
  } catch {
    return {};
  }
}

function defaultNotebook(cwd) {
  const sw = readSwitches(cwd);
  return path.resolve(cwd, typeof sw['target-doc'] === 'string' ? sw['target-doc'] : '.agentflow/devlog.md');
}

// The name agentflow's compaction gives the archive (upstream ag-settings.js):
// `<topic>.devlog.md` → `<topic>.archive.md`, any other `<x>.md` → `<x>.archive.md`.
function archivePathFor(notebook) {
  const dir = path.dirname(notebook), base = path.basename(notebook);
  if (base.endsWith('.devlog.md')) return path.join(dir, base.slice(0, -'.devlog.md'.length) + '.archive.md');
  if (base.endsWith('.md')) return path.join(dir, base.slice(0, -'.md'.length) + '.archive.md');
  return null;
}

function resolveInputs(args, cwd = process.cwd()) {
  const notebook = args.notebook ? path.resolve(cwd, args.notebook) : defaultNotebook(cwd);
  if (!fs.existsSync(notebook)) throw new UsageError(`notebook not found: ${notebook}`);
  const archive = archivePathFor(notebook);
  return { notebook, archive: archive && fs.existsSync(archive) ? archive : null };
}

async function run(argv) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) { process.stdout.write(HELP + '\n'); return; }
    resolveInputs(args);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}. Run "ccxray agentflow report --help" for usage.`);
    process.exitCode = 1;
    return;
  }
  // The report itself lands in later phases (Ask windows, attribution, render).
  console.error('agentflow report: not implemented yet');
  process.exitCode = 2;
}

module.exports = { run, parseArgs, resolveInputs, archivePathFor, defaultNotebook, UsageError };
