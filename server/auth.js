'use strict';

/**
 * Simple API key authentication middleware for cloud deployments.
 *
 * Enable by setting AUTH_TOKEN environment variable.
 * When set, all requests must include either:
 *   - Header: Authorization: Bearer <token>
 *   - Query param: ?token=<token>
 *
 * Dashboard and SSE endpoints are also protected.
 * The proxy endpoint (forwarding to Anthropic) uses the client's own API key
 * for Anthropic auth, but still requires AUTH_TOKEN for access control.
 */

const AUTH_TOKEN = process.env.AUTH_TOKEN || null;

function authMiddleware(req, res) {
  if (!AUTH_TOKEN) return true; // no auth configured — allow all

  // Check Authorization header
  const authHeader = req.headers['authorization'] || '';
  if (authHeader === `Bearer ${AUTH_TOKEN}`) return true;

  // Check query param
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.searchParams.get('token') === AUTH_TOKEN) return true;

  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized', message: 'Valid AUTH_TOKEN required' }));
  return false;
}

module.exports = { authMiddleware, AUTH_TOKEN };
