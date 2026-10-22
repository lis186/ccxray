'use strict';

const { hasOpenAIHeaders } = require('./request-signals');

function checkHttpRoute(req, res, upstream) {
  if (upstream && !(upstream.provider === 'anthropic' && hasOpenAIHeaders(req.headers))) return true;
  const pathname = (req.url || '/').split('?')[0];
  res.writeHead(421, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: {
    type: 'ccxray_unknown_route',
    message: `ccxray could not determine the upstream for ${req.method} ${pathname}; request was not forwarded (see #740)`,
  } }));
  return false;
}

module.exports = { checkHttpRoute };
