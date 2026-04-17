"use strict";

/**
 * API key + session-cookie authentication.
 *
 * When AUTH_TOKEN env var is set, all protected routes require either:
 *   - Authorization: Bearer <token>              (CLI / programmatic callers)
 *   - Cookie: ccxray_auth=<signed-session-id>    (browser after POST /login)
 *
 * Query-param tokens are NOT accepted (URLs get cached/logged).
 */

const crypto = require("crypto");

const AUTH_TOKEN = process.env.AUTH_TOKEN || null;
const COOKIE_NAME = "ccxray_auth";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const HMAC_SECRET = crypto.randomBytes(32);
const sessions = new Map(); // sid → { createdAt }

function sign(sid) {
	return crypto
		.createHmac("sha256", HMAC_SECRET)
		.update(sid)
		.digest("base64url");
}

function createSession() {
	const sid = crypto.randomBytes(24).toString("base64url");
	sessions.set(sid, { createdAt: Date.now() });
	return `${sid}.${sign(sid)}`;
}

function verifySessionCookie(cookieValue) {
	if (!cookieValue || typeof cookieValue !== "string") return false;
	const dot = cookieValue.lastIndexOf(".");
	if (dot <= 0) return false;
	const sid = cookieValue.slice(0, dot);
	const sig = cookieValue.slice(dot + 1);
	const expected = sign(sid);
	if (sig.length !== expected.length) return false;
	try {
		if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
			return false;
	} catch {
		return false;
	}
	const meta = sessions.get(sid);
	if (!meta) return false;
	if (Date.now() - meta.createdAt > SESSION_TTL_MS) {
		sessions.delete(sid);
		return false;
	}
	return true;
}

function destroySession(cookieValue) {
	if (!cookieValue || typeof cookieValue !== "string") return;
	const dot = cookieValue.lastIndexOf(".");
	if (dot <= 0) return;
	sessions.delete(cookieValue.slice(0, dot));
}

function parseCookies(header) {
	const out = {};
	if (!header || typeof header !== "string") return out;
	for (const part of header.split(/;\s*/)) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
	}
	return out;
}

function timingSafeTokenEqual(a, b) {
	if (typeof a !== "string" || typeof b !== "string") return false;
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) {
		// Compare against equal-length buffer to keep timing uniform.
		try {
			crypto.timingSafeEqual(ab, Buffer.alloc(ab.length));
		} catch {}
		return false;
	}
	try {
		return crypto.timingSafeEqual(ab, bb);
	} catch {
		return false;
	}
}

function readBearer(authHeader) {
	if (!authHeader || typeof authHeader !== "string") return null;
	const m = authHeader.match(/^Bearer\s+(.+)$/);
	return m ? m[1] : null;
}

function wantsHtml(req) {
	const accept = req.headers && req.headers["accept"];
	if (!accept || typeof accept !== "string") return false;
	return accept.includes("text/html");
}

function authMiddleware(req, res) {
	if (!AUTH_TOKEN) return true;

	// Allow login/logout endpoints themselves and the login page asset
	const url = req.url || "";
	const pathOnly = url.split("?")[0];
	if (
		pathOnly === "/login" ||
		pathOnly === "/logout" ||
		pathOnly === "/login.html"
	) {
		return true;
	}

	const cookies = parseCookies(req.headers && req.headers.cookie);
	if (verifySessionCookie(cookies[COOKIE_NAME])) return true;

	const bearer = readBearer(req.headers && req.headers.authorization);
	if (bearer && timingSafeTokenEqual(bearer, AUTH_TOKEN)) return true;

	if (wantsHtml(req)) {
		res.writeHead(302, { Location: "/login.html" });
		res.end();
		return false;
	}

	res.writeHead(401, { "Content-Type": "application/json" });
	res.end(
		JSON.stringify({
			error: "unauthorized",
			message: "Valid AUTH_TOKEN required",
		}),
	);
	return false;
}

function isLoopbackRemote(req) {
	const addr = req.socket && req.socket.remoteAddress;
	return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function buildSessionCookie(token, req) {
	const secureFlag = isLoopbackRemote(req) ? "" : "; Secure";
	const maxAge = Math.floor(SESSION_TTL_MS / 1000);
	return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureFlag}`;
}

function handleLogin(req, res) {
	if (req.url !== "/login") return false;
	if (req.method !== "POST") {
		res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
		res.end(JSON.stringify({ error: "method_not_allowed" }));
		return true;
	}
	if (!AUTH_TOKEN) {
		res.writeHead(204);
		res.end();
		return true;
	}
	const chunks = [];
	let size = 0;
	let aborted = false;
	req.on("data", (c) => {
		if (aborted) return;
		size += c.length;
		if (size > 4096) {
			aborted = true;
			res.writeHead(413, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "payload_too_large" }));
			req.destroy();
		} else {
			chunks.push(c);
		}
	});
	req.on("end", () => {
		if (aborted) return;
		let token;
		try {
			const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
			token = body.token;
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "bad_json" }));
			return;
		}
		if (
			!timingSafeTokenEqual(typeof token === "string" ? token : "", AUTH_TOKEN)
		) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "invalid_token" }));
			return;
		}
		const cookie = buildSessionCookie(createSession(), req);
		res.writeHead(200, {
			"Content-Type": "application/json",
			"Set-Cookie": cookie,
		});
		res.end(JSON.stringify({ ok: true }));
	});
	return true;
}

function handleLogout(req, res) {
	if (req.url !== "/logout") return false;
	if (req.method !== "POST") {
		res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
		res.end(JSON.stringify({ error: "method_not_allowed" }));
		return true;
	}
	const cookies = parseCookies(req.headers && req.headers.cookie);
	destroySession(cookies[COOKIE_NAME]);
	res.writeHead(200, {
		"Content-Type": "application/json",
		"Set-Cookie": `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
	});
	res.end(JSON.stringify({ ok: true }));
	return true;
}

module.exports = {
	AUTH_TOKEN,
	authMiddleware,
	handleLogin,
	handleLogout,
	// exported for tests
	_internal: {
		createSession,
		verifySessionCookie,
		timingSafeTokenEqual,
		parseCookies,
		sessions,
	},
};
