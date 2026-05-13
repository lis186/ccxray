'use strict';

// CLI argv parsing for ccxray. Splits flag detection from server/index.js so
// new subcommands can be added without growing the entry-point file. Mutates
// process.argv in place to strip consumed flags (existing behaviour).

const providers = require('./providers');

function parseArgs(argv = process.argv, env = process.env) {
  const portIdx = argv.indexOf('--port');
  let explicitPort = false;
  let port = null;
  if (portIdx !== -1) {
    const portVal = argv[portIdx + 1];
    const parsed = parseInt(portVal, 10);
    if (!portVal || isNaN(parsed) || parsed < 1 || parsed > 65535) {
      console.error('\x1b[31mError: --port requires a valid port number (1-65535)\x1b[0m');
      process.exit(1);
    }
    port = parsed;
    explicitPort = true;
    argv.splice(portIdx, 2);
  }

  const hubMode = argv.includes('--hub-mode');
  if (hubMode) argv.splice(argv.indexOf('--hub-mode'), 1);

  const allowUpstreamLoop = argv.includes('--allow-upstream-loop') || env.CCXRAY_ALLOW_UPSTREAM_LOOP === '1';
  if (argv.includes('--allow-upstream-loop')) argv.splice(argv.indexOf('--allow-upstream-loop'), 1);

  const noBrowser = argv.includes('--no-browser');
  if (noBrowser) argv.splice(argv.indexOf('--no-browser'), 1);

  const cliCommand = argv[2];
  const unknownCommand = cliCommand
    && cliCommand !== 'status'
    && !cliCommand.startsWith('-')
    && !providers.isAgentProvider(cliCommand);
  if (unknownCommand) {
    console.error(`\x1b[31mError: unsupported provider "${cliCommand}". Supported providers: ${providers.supportedProviderList()}\x1b[0m`);
    process.exit(1);
  }

  const agentCommand = providers.isAgentProvider(cliCommand) ? cliCommand : null;
  const agentMode = Boolean(agentCommand);
  const agentArgs = agentMode ? argv.slice(3) : [];
  const displayName = providers.getDisplayName(agentCommand, env);

  return {
    port,
    explicitPort,
    hubMode,
    allowUpstreamLoop,
    noBrowser,
    cliCommand,
    agentCommand,
    agentMode,
    agentArgs,
    displayName,
  };
}

module.exports = { parseArgs };
