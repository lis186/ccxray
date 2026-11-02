'use strict';

// 400 reply for a URL segment with malformed percent-encoding. Returns true so
// a route handler can `return badEncoding(res)` as "handled".
function badEncoding(res) {
  if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'malformed percent-encoding in URL' }));
  return true;
}

// 415 reply for a JSON-body write route called without application/json.
function unsupportedMediaType(res) {
  res.writeHead(415, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Content-Type must be application/json' }));
  return true;
}

// 500 reply for an unexpected error while handling a request. Once headers are
// out the response can no longer carry a JSON error, so it is destroyed instead.
function failRequest(res, err) {
  console.error('[ccxray] request handler error:', err && err.message);
  try {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal error' }));
  } catch {}
}

module.exports = { badEncoding, unsupportedMediaType, failRequest };
