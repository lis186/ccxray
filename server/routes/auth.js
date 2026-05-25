'use strict';

// Phase 1.3 — auth domain routes.
//
// POST /_auth/redeem  → consume one-time bootstrap token, mint cookie.
// GET  /_auth/status  → server-side session probe (replaces the HttpOnly-
//                       incompatible document.cookie check; errata §1.1).
//
// Both endpoints live on the dashboard domain so dispatch() routes them
// through verifyDashboard. /_auth/redeem MUST run BEFORE verifyDashboard
// because it's the entry point that creates the cookie; we therefore
// invoke it directly from server/index.js before the auth gate.
//
// /_auth/status is exempt from authentication too: its whole job is to
// answer "am I authenticated?" without forcing a 401 elsewhere. The
// inline browser bootstrap polls it to decide whether to show the
// "Run `ccxray open`" message.

const auth = require('../auth');

function handleAuthRoutes(req, res) {
  const pathname = req.url.split('?')[0];

  if (req.method === 'POST' && pathname === '/_auth/redeem') {
    auth.redeemBootstrap(req, res);
    return true;
  }

  if (req.method === 'GET' && pathname === '/_auth/status') {
    auth.authStatus(req, res);
    return true;
  }

  return false;
}

module.exports = { handleAuthRoutes };
