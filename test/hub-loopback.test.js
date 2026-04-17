"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const TEST_HUB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ccxray-hub-lb-"));
process.env.CCXRAY_HOME = TEST_HUB_DIR;

const hub = require("../server/hub");
hub.setOnShutdown(() => {});

describe("hub loopback + validation", () => {
	let server;
	let port;

	before(async () => {
		server = http.createServer((req, res) => {
			if (!hub.handleHubRoutes(req, res)) {
				res.writeHead(404);
				res.end("not found");
			}
		});
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		port = server.address().port;
		hub.setHubPort(port);
	});

	after(async () => {
		await new Promise((r) => server.close(r));
		fs.rmSync(TEST_HUB_DIR, { recursive: true, force: true });
	});

	function reqJSON(method, urlPath, body, extraHeaders = {}) {
		return new Promise((resolve, reject) => {
			const data = body ? JSON.stringify(body) : "";
			const r = http.request(
				{
					host: "127.0.0.1",
					port,
					method,
					path: urlPath,
					agent: false,
					headers: {
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(data),
						...extraHeaders,
					},
				},
				(res) => {
					let buf = "";
					res.on("data", (c) => {
						buf += c;
					});
					res.on("end", () => resolve({ status: res.statusCode, body: buf }));
				},
			);
			r.on("error", reject);
			r.end(data);
		});
	}

	it("register with valid payload returns 200", async () => {
		const { status } = await reqJSON("POST", "/_api/hub/register", {
			pid: 12345,
			cwd: "/tmp/foo",
		});
		assert.equal(status, 200);
	});

	it("register rejects negative pid", async () => {
		const { status } = await reqJSON("POST", "/_api/hub/register", {
			pid: -1,
			cwd: "/tmp",
		});
		assert.equal(status, 400);
	});

	it("register rejects non-integer pid", async () => {
		const { status } = await reqJSON("POST", "/_api/hub/register", {
			pid: "abc",
			cwd: "/tmp",
		});
		assert.equal(status, 400);
	});

	it("register rejects pid above cap", async () => {
		const { status } = await reqJSON("POST", "/_api/hub/register", {
			pid: (1 << 22) + 1,
			cwd: "/tmp",
		});
		assert.equal(status, 400);
	});

	it("register rejects empty cwd", async () => {
		const { status } = await reqJSON("POST", "/_api/hub/register", {
			pid: 12347,
			cwd: "",
		});
		assert.equal(status, 400);
	});

	it("register rejects body > 1KB with 413", async () => {
		const payload = JSON.stringify({ pid: 12348, cwd: "x".repeat(2000) });
		const { status } = await new Promise((resolve, reject) => {
			const r = http.request(
				{
					host: "127.0.0.1",
					port,
					method: "POST",
					path: "/_api/hub/register",
					headers: {
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(payload),
					},
				},
				(res) => {
					res.resume();
					res.on("end", () => resolve({ status: res.statusCode }));
				},
			);
			r.on("error", reject);
			r.end(payload);
		});
		assert.equal(status, 413);
	});

	it("unregister with valid pid returns 200", async () => {
		await reqJSON("POST", "/_api/hub/register", { pid: 22222, cwd: "/tmp" });
		const { status } = await reqJSON("POST", "/_api/hub/unregister", {
			pid: 22222,
		});
		assert.equal(status, 200);
	});

	it("hub/status accessible from loopback", async () => {
		const { status } = await reqJSON("GET", "/_api/hub/status");
		assert.equal(status, 200);
	});

	it("health endpoint works without loopback check", async () => {
		const { status } = await reqJSON("GET", "/_api/health");
		assert.equal(status, 200);
	});
});

describe("hub rejects non-loopback remote", () => {
	it("non-loopback remoteAddress returns 403", () => {
		// Direct unit test on handleHubRoutes with faked remoteAddress
		const fakeReq = {
			url: "/_api/hub/status",
			method: "GET",
			socket: { remoteAddress: "192.168.1.42" },
			on: () => {},
		};
		let status = null;
		const fakeRes = {
			writeHead: (s) => {
				status = s;
				return fakeRes;
			},
			end: () => {},
		};
		const handled = hub.handleHubRoutes(fakeReq, fakeRes);
		assert.equal(handled, true);
		assert.equal(status, 403);
	});

	it("loopback ::1 is allowed", () => {
		const fakeReq = {
			url: "/_api/hub/status",
			method: "GET",
			socket: { remoteAddress: "::1" },
			on: () => {},
		};
		let status = null;
		const fakeRes = {
			writeHead: (s) => {
				status = s;
				return fakeRes;
			},
			end: () => {},
		};
		hub.handleHubRoutes(fakeReq, fakeRes);
		assert.equal(status, 200);
	});

	it("loopback ::ffff:127.0.0.1 is allowed", () => {
		const fakeReq = {
			url: "/_api/hub/status",
			method: "GET",
			socket: { remoteAddress: "::ffff:127.0.0.1" },
			on: () => {},
		};
		let status = null;
		const fakeRes = {
			writeHead: (s) => {
				status = s;
				return fakeRes;
			},
			end: () => {},
		};
		hub.handleHubRoutes(fakeReq, fakeRes);
		assert.equal(status, 200);
	});
});
