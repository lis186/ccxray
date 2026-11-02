'use strict';

const hub = require('./hub');

function resolveHttpSessionCwd({ parser, parsedBody, provider, clientReq, getAgentCwdFallback }) {
  return parser.getCwd(parsedBody, clientReq.headers)
    || (provider === 'openai'
      ? getAgentCwdFallback(clientReq)
      : Number.isSafeInteger(clientReq.ccxrayClientPid)
        ? hub.lookupClientCwdForRequest(clientReq)
        : null);
}

module.exports = { resolveHttpSessionCwd };
