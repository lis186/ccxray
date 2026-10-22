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

module.exports = { badEncoding, unsupportedMediaType };
