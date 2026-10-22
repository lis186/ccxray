'use strict';

const { isOpenAISide, isAnthropicSide } = require('./request-signals');

const lastWarnings = new Map();
const WARNING_INTERVAL_MS = 60_000;
const WARNING_CAP = 500;

function checkHttpRoute(req, res, upstream) {
  if (upstream
      && !(upstream.provider === 'anthropic' && isOpenAISide(req.headers, req))
      && !(upstream.provider === 'openai' && isAnthropicSide(req.headers, req))) return true;
  const pathname = (req.url || '/').split('?')[0];
  const now = Date.now();
  const key = `${req.method} ${pathname}`;
  for (const [previousKey, time] of lastWarnings) {
    if (now - time >= WARNING_INTERVAL_MS) lastWarnings.delete(previousKey);
  }
  if (!lastWarnings.has(key)) {
    if (lastWarnings.size >= WARNING_CAP) lastWarnings.delete(lastWarnings.keys().next().value);
    lastWarnings.set(key, now);
    console.warn(`[ccxray] refused ${key} (unknown route, not forwarded)`);
  }
  res.writeHead(421, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: {
    type: 'ccxray_unknown_route',
    message: `ccxray could not determine the upstream for ${req.method} ${pathname}; request was not forwarded (see #745)`,
  } }));
  return false;
}

module.exports = { checkHttpRoute };
