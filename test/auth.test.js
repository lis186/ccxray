"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

describe("auth middleware", () => {
	let originalToken;

	before(() => {
		originalToken = process.env.AUTH_TOKEN;
	});

	after(() => {
		if (originalToken !== undefined) {
			process.env.AUTH_TOKEN = originalToken;
		} else {
			delete process.env.AUTH_TOKEN;
		}
		delete require.cache[require.resolve("../server/auth")];
	});

	function mockReqRes(headers = {}, url = "/") {
		const req = {
			headers,
			url,
			socket: { remoteAddress: "127.0.0.1" },
			on: () => {},
		};
		const res = {
			statusCode: null,
			body: null,
			headers: {},
			writeHead(code, h) {
				this.statusCode = code;
				this.headers = h || {};
			},
			end(body) {
				this.body = body;
			},
		};
		return { req, res };
	}

	function loadAuth(token) {
		if (token === null) delete process.env.AUTH_TOKEN;
		else process.env.AUTH_TOKEN = token;
		delete require.cache[require.resolve("../server/auth")];
		return require("../server/auth");
	}

	it("allows all requests when AUTH_TOKEN is not set", () => {
		const { authMiddleware } = loadAuth(null);
		const { req, res } = mockReqRes();
		assert.equal(authMiddleware(req, res), true);
	});

	it("rejects requests without token when AUTH_TOKEN is set", () => {
		const { authMiddleware } = loadAuth("test-secret");
		const { req, res } = mockReqRes();
		assert.equal(authMiddleware(req, res), false);
		assert.equal(res.statusCode, 401);
	});

	it("accepts correct Bearer token", () => {
		const { authMiddleware } = loadAuth("test-secret");
		const { req, res } = mockReqRes({
			authorization: "Bearer test-secret",
			host: "localhost",
		});
		assert.equal(authMiddleware(req, res), true);
	});

	it("rejects wrong Bearer token", () => {
		const { authMiddleware } = loadAuth("test-secret");
		const { req, res } = mockReqRes({
			authorization: "Bearer wrong",
			host: "localhost",
		});
		assert.equal(authMiddleware(req, res), false);
		assert.equal(res.statusCode, 401);
	});

	it("rejects ?token= query param even when value matches AUTH_TOKEN", () => {
		const { authMiddleware } = loadAuth("test-secret");
		const { req, res } = mockReqRes(
			{ host: "localhost" },
			"/?token=test-secret",
		);
		assert.equal(authMiddleware(req, res), false);
		assert.equal(res.statusCode, 401);
	});

	it("timing-safe compare rejects length-mismatched bearer token", () => {
		const { authMiddleware } = loadAuth("test-secret");
		const { req, res } = mockReqRes({ authorization: "Bearer x" });
		assert.equal(authMiddleware(req, res), false);
		assert.equal(res.statusCode, 401);
	});

	it("Accept: text/html with no credentials returns 302 /login.html", () => {
		const { authMiddleware } = loadAuth("test-secret");
		const { req, res } = mockReqRes({ accept: "text/html" });
		assert.equal(authMiddleware(req, res), false);
		assert.equal(res.statusCode, 302);
		assert.equal(res.headers.Location, "/login.html");
	});

	it("Accept: application/json with no credentials returns 401", () => {
		const { authMiddleware } = loadAuth("test-secret");
		const { req, res } = mockReqRes({ accept: "application/json" });
		assert.equal(authMiddleware(req, res), false);
		assert.equal(res.statusCode, 401);
	});

	it("login and logout paths bypass auth middleware", () => {
		const { authMiddleware } = loadAuth("test-secret");
		for (const url of ["/login", "/logout", "/login.html"]) {
			const { req, res } = mockReqRes({}, url);
			assert.equal(authMiddleware(req, res), true, url);
		}
	});

	it("valid session cookie grants access", () => {
		const auth = loadAuth("test-secret");
		const token = auth._internal.createSession();
		const { req, res } = mockReqRes({ cookie: `ccxray_auth=${token}` });
		assert.equal(auth.authMiddleware(req, res), true);
	});

	it("tampered session cookie is rejected", () => {
		const auth = loadAuth("test-secret");
		const token = auth._internal.createSession();
		const tampered = token.slice(0, -1) + (token.slice(-1) === "A" ? "B" : "A");
		const { req, res } = mockReqRes({ cookie: `ccxray_auth=${tampered}` });
		assert.equal(auth.authMiddleware(req, res), false);
	});
});
