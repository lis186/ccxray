"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

describe("login / logout endpoints", () => {
	let server;
	let port;
	let auth;
	let originalToken;

	before(async () => {
		originalToken = process.env.AUTH_TOKEN;
		process.env.AUTH_TOKEN = "test-secret";
		delete require.cache[require.resolve("../server/auth")];
		auth = require("../server/auth");
		server = http.createServer((req, res) => {
			if (auth.handleLogin(req, res)) return;
			if (auth.handleLogout(req, res)) return;
			if (!auth.authMiddleware(req, res)) return;
			res.writeHead(200);
			res.end("ok");
		});
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		port = server.address().port;
	});

	after(async () => {
		await new Promise((r) => server.close(r));
		if (originalToken !== undefined) process.env.AUTH_TOKEN = originalToken;
		else delete process.env.AUTH_TOKEN;
		delete require.cache[require.resolve("../server/auth")];
	});

	function request(method, urlPath, { body, headers } = {}) {
		return new Promise((resolve, reject) => {
			const data = body == null ? "" : JSON.stringify(body);
			const req = http.request(
				{
					host: "127.0.0.1",
					port,
					method,
					path: urlPath,
					agent: false,
					headers: {
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(data),
						...(headers || {}),
					},
				},
				(res) => {
					let buf = "";
					res.on("data", (c) => {
						buf += c;
					});
					res.on("end", () =>
						resolve({
							status: res.statusCode,
							headers: res.headers,
							body: buf,
						}),
					);
				},
			);
			req.on("error", reject);
			req.end(data);
		});
	}

	it("POST /login with correct token sets HttpOnly SameSite=Strict cookie", async () => {
		const { status, headers } = await request("POST", "/login", {
			body: { token: "test-secret" },
		});
		assert.equal(status, 200);
		const setCookie = headers["set-cookie"];
		assert.ok(setCookie, "Set-Cookie header present");
		const cookieStr = Array.isArray(setCookie)
			? setCookie.join("; ")
			: setCookie;
		assert.match(cookieStr, /ccxray_auth=/);
		assert.match(cookieStr, /HttpOnly/i);
		assert.match(cookieStr, /SameSite=Strict/i);
		assert.match(cookieStr, /Path=\//i);
	});

	it("POST /login with wrong token returns 401 and no cookie", async () => {
		const { status, headers } = await request("POST", "/login", {
			body: { token: "bad" },
		});
		assert.equal(status, 401);
		assert.equal(headers["set-cookie"], undefined);
	});

	it("cookie from /login grants access to protected endpoint", async () => {
		const loginRes = await request("POST", "/login", {
			body: { token: "test-secret" },
		});
		const setCookie = Array.isArray(loginRes.headers["set-cookie"])
			? loginRes.headers["set-cookie"][0]
			: loginRes.headers["set-cookie"];
		const cookieValue = setCookie.split(";")[0];
		const { status } = await request("GET", "/_api/ping", {
			headers: { Cookie: cookieValue },
		});
		assert.equal(status, 200);
	});

	it("POST /logout clears session cookie", async () => {
		const loginRes = await request("POST", "/login", {
			body: { token: "test-secret" },
		});
		const setCookie = Array.isArray(loginRes.headers["set-cookie"])
			? loginRes.headers["set-cookie"][0]
			: loginRes.headers["set-cookie"];
		const cookieValue = setCookie.split(";")[0];

		const { status, headers } = await request("POST", "/logout", {
			headers: { Cookie: cookieValue },
		});
		assert.equal(status, 200);
		const clear = Array.isArray(headers["set-cookie"])
			? headers["set-cookie"][0]
			: headers["set-cookie"];
		assert.match(clear, /Max-Age=0/i);

		// Cookie no longer valid
		const { status: s2 } = await request("GET", "/_api/ping", {
			headers: { Cookie: cookieValue },
		});
		assert.equal(s2, 401);
	});

	it("GET /login returns 405", async () => {
		const { status } = await request("GET", "/login");
		assert.equal(status, 405);
	});

	it("bearer token still works for CLI access", async () => {
		const { status } = await request("GET", "/_api/ping", {
			headers: { Authorization: "Bearer test-secret" },
		});
		assert.equal(status, 200);
	});

	it("?token= query param is rejected", async () => {
		const { status } = await request("GET", "/_api/ping?token=test-secret");
		assert.equal(status, 401);
	});
});
