'use strict';

const { isOpenAISide } = require('./request-signals');

const lastWarnings = new Map();
const WARNING_INTERVAL_MS = 60_000;

function checkHttpRoute(req, res, upstream) {
  if (upstream && !(upstream.provider === 'anthropic' && isOpenAISide(req.headers, req))) return true;
  const pathname = (req.url || '/').split('?')[0];
  const now = Date.now();
  const key = `${req.method} ${pathname}`;
  for (const [previousKey, time] of lastWarnings) {
    if (now - time >= WARNING_INTERVAL_MS) lastWarnings.delete(previousKey);
  }
  if (!lastWarnings.has(key)) {
    lastWarnings.set(key, now);
    console.warn(`[ccxray] ${key}`);
  }
  res.writeHead(421, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: {
    type: 'ccxray_unknown_route',
    message: `ccxray could not determine the upstream for ${req.method} ${pathname}; request was not forwarded (see #740)`,
  } }));
  return false;
}

module.exports = { checkHttpRoute };
