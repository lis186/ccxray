"use strict";

// ── In-memory store & SSE clients ───────────────────────────────────
const MAX_ENTRIES = parseInt(process.env.CCXRAY_MAX_ENTRIES || "5000", 10);
const entries = [];
const sseClients = [];
const sseClientsByIp = new Map();

function trimEntries() {
	if (entries.length > MAX_ENTRIES) {
		entries.splice(0, entries.length - MAX_ENTRIES);
	}
}

// ── Rate limit state (from Anthropic response headers) ──────────────
let rateLimitState = null;

// ── Session tracking ────────────────────────────────────────────────
let currentSessionId = null;
let lastMsgCount = 0;
let sessionCounter = 0;

// ── Session metadata (cwd per session) ──────────────────────────────
const sessionMeta = {}; // { sessionId: { cwd, lastSeenAt } }
const activeRequests = {}; // sessionId → in-flight count
const sessionCosts = new Map(); // sessionId → accumulated cost

// ── Version Index (cc_version → { reqId, b2Len, firstSeen }) ────────
const versionIndex = new Map();

// ── Intercept (request pause) ────────────────────────────────────────
const interceptSessions = new Set();
const pendingRequests = new Map();
let interceptTimeout = 120;

function isQuotaCheck(req) {
	return (
		req?.max_tokens === 1 &&
		!req?.system &&
		req?.messages?.length === 1 &&
		req.messages[0]?.content === "quota"
	);
}

function extractCwd(req) {
	if (isQuotaCheck(req)) return "(quota-check)";
	if (!req?.system) return null;
	const txt = Array.isArray(req.system)
		? req.system.map((b) => b.text || "").join("\n")
		: String(req.system);
	const m = txt.match(/Primary working directory: (.+)/);
	return m ? m[1].trim() : null;
}

function extractSessionId(req) {
	const uid = req?.metadata?.user_id || "";
	// New format: user_id is JSON like {"session_id":"xxx-yyy"}
	const jsonMatch = uid.match(/"session_id"\s*:\s*"([a-f0-9-]+)"/);
	if (jsonMatch) return jsonMatch[1];
	// Legacy format: user_id is "session_xxx-yyy"
	const m = uid.match(/session_([a-f0-9-]+)/);
	return m ? m[1] : null;
}

// Bare subagent requests: no session_id, no system prompt, no tools, 1-2 messages.
// These are Claude Code's Agent tool kickoff calls that lack any identifying metadata.
function isLikelySubagent(req) {
	if (extractSessionId(req)) return false; // has explicit session → not orphan
	if (extractCwd(req)) return false; // has system prompt with cwd → not bare
	if (req?.tools?.length) return false; // has tool definitions → not bare
	if ((req?.messages?.length || 0) > 2) return false;
	// Require metadata to be absent or empty (genuine API callers usually set metadata)
	const meta = req?.metadata;
	if (meta && Object.keys(meta).length > 0) return false;
	return true;
}

// Find the best parent session for an orphan subagent request.
// Scoring: inflight sessions get massive priority boost, then sorted by recency.
// Only considers sessions active within the last 30s to avoid stale attribution.
function inferParentSession() {
	const now = Date.now();
	const WINDOW_MS = 30000;
	let best = null,
		bestScore = -1;

	for (const [sid, meta] of Object.entries(sessionMeta)) {
		if (sid === "direct-api") continue;
		const seenAt = meta.lastSeenAt || 0;
		if (now - seenAt > WINDOW_MS) continue;

		const inflight = (activeRequests[sid] || 0) > 0;
		// Inflight sessions score 1e13 + recency; idle sessions score just recency
		const score = (inflight ? 1e13 : 0) + seenAt;
		if (score > bestScore) {
			best = sid;
			bestScore = score;
		}
	}
	return best;
}

function detectSession(req) {
	const realId = extractSessionId(req);

	// Explicit session_id → authoritative
	if (realId) {
		const isNew = realId !== currentSessionId;
		if (isNew) {
			sessionCounter++;
			currentSessionId = realId;
		}
		lastMsgCount = req?.messages?.length || 0;
		return { sessionId: currentSessionId, isNewSession: isNew };
	}

	// Likely subagent → infer parent, never pollute global state
	if (isLikelySubagent(req)) {
		const parent = inferParentSession();
		if (parent)
			return { sessionId: parent, isNewSession: false, inferred: true };
		// No recent session → keep as-is, don't create spurious session
		return {
			sessionId: currentSessionId || "direct-api",
			isNewSession: false,
			inferred: true,
		};
	}

	// Non-subagent without session_id: original heuristic
	const isNew =
		!currentSessionId || (req?.messages?.length || 0) < lastMsgCount;
	if (isNew) {
		sessionCounter++;
		currentSessionId = "direct-api";
	}
	lastMsgCount = req?.messages?.length || 0;
	return { sessionId: currentSessionId, isNewSession: isNew };
}

function printSessionBanner(sessionId) {
	const w = 60;
	const shortId = sessionId.slice(0, 8);
	const label = ` NEW SESSION ${shortId} `;
	const pad = Math.max(0, Math.floor((w - label.length) / 2));
	const line = "★".repeat(pad) + label + "★".repeat(w - pad - label.length);
	console.log();
	console.log("\x1b[1;35m" + line + "\x1b[0m");
	console.log(`\x1b[35m   claude --continue ${sessionId}\x1b[0m`);
	console.log();
}

function getRateLimitState() {
	return rateLimitState;
}
function setRateLimitState(state) {
	rateLimitState = state;
}
function getInterceptTimeout() {
	return interceptTimeout;
}
function setInterceptTimeout(val) {
	interceptTimeout = val;
}
function getCurrentSessionId() {
	return currentSessionId;
}

module.exports = {
	MAX_ENTRIES,
	entries,
	trimEntries,
	sseClients,
	sseClientsByIp,
	getRateLimitState,
	setRateLimitState,
	sessionMeta,
	activeRequests,
	sessionCosts,
	versionIndex,
	interceptSessions,
	pendingRequests,
	getInterceptTimeout,
	setInterceptTimeout,
	getCurrentSessionId,
	isQuotaCheck,
	extractCwd,
	extractSessionId,
	detectSession,
	printSessionBanner,
};
