'use strict';

/**
 * Strip ccxray's own auth query parameters from URLs before:
 *   - forwarding to upstream (would leak ccxray's AUTH_TOKEN to OpenAI/Anthropic)
 *   - writing to entry logs on disk (~/.ccxray/logs/{id}_req.json)
 *   - broadcasting to dashboard via SSE
 *
 * Only strips ccxray-recognized auth params (currently `?token=`). Upstream API
 * keys travel in Authorization headers, not query params, so this never affects
 * upstream authentication.
 *
 * See server/auth.js — `?token=<AUTH_TOKEN>` is the supported query-param auth.
 */

const AUTH_QUERY_PARAMS = Object.freeze(['token']);

function stripAuthParams(url) {
  if (typeof url !== 'string' || url.length === 0) return url;
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return url;

  const pathname = url.slice(0, qIdx);
  const query = url.slice(qIdx + 1);

  // Cheap pre-check: if none of the auth param names appear at all, return as-is.
  let mightContain = false;
  for (const name of AUTH_QUERY_PARAMS) {
    if (query.indexOf(name) !== -1) { mightContain = true; break; }
  }
  if (!mightContain) return url;

  const params = new URLSearchParams(query);
  let modified = false;
  for (const name of AUTH_QUERY_PARAMS) {
    if (params.has(name)) {
      params.delete(name);
      modified = true;
    }
  }
  if (!modified) return url;

  const remaining = params.toString();
  return remaining ? pathname + '?' + remaining : pathname;
}

function stripControlChars(str) {
  return typeof str === 'string' ? str.replace(/[\x00-\x1f\x7f]/g, '') : str;
}

module.exports = { stripAuthParams, AUTH_QUERY_PARAMS, stripControlChars };
