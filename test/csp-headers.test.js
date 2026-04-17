"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

describe("security headers", () => {
	let proc;
	let port;
	const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccxray-csp-"));

	before(async () => {
		port = 40000 + Math.floor(Math.random() * 10000);
		proc = spawn(
			process.execPath,
			[
				path.join(__dirname, "..", "server", "index.js"),
				"--port",
				String(port),
			],
			{
				env: { ...process.env, CCXRAY_HOME: tmpHome, BROWSER: "none" },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		await new Promise((resolve, reject) => {
			const t = setTimeout(
				() => reject(new Error("server start timeout")),
				5000,
			);
			proc.stdout.on("data", (c) => {
				if (c.toString().includes("listening")) {
					clearTimeout(t);
					resolve();
				}
			});
			proc.on("error", reject);
		});
	});

	after(async () => {
		proc.kill("SIGTERM");
		await new Promise((r) => proc.once("exit", r));
		fs.rmSync(tmpHome, { recursive: true, force: true });
	});

	function request(method, urlPath) {
		return new Promise((resolve, reject) => {
			const r = http.request(
				{ host: "127.0.0.1", port, method, path: urlPath, agent: false },
				(res) => {
					res.resume();
					res.on("end", () =>
						resolve({ status: res.statusCode, headers: res.headers }),
					);
				},
			);
			r.on("error", reject);
			r.end();
		});
	}

	it("GET / returns CSP header", async () => {
		const { headers } = await request("GET", "/");
		assert.ok(headers["content-security-policy"]);
		assert.match(headers["content-security-policy"], /default-src 'self'/);
		assert.match(headers["content-security-policy"], /frame-ancestors 'none'/);
	});

	it("GET / returns nosniff header", async () => {
		const { headers } = await request("GET", "/");
		assert.equal(headers["x-content-type-options"], "nosniff");
	});

	it("GET / returns no-referrer header", async () => {
		const { headers } = await request("GET", "/");
		assert.equal(headers["referrer-policy"], "no-referrer");
	});

	it("index.html contains JSON config block, not inline script assignment", async () => {
		const body = await new Promise((resolve, reject) => {
			http
				.get(`http://127.0.0.1:${port}/`, (res) => {
					let buf = "";
					res.on("data", (c) => {
						buf += c;
					});
					res.on("end", () => resolve(buf));
				})
				.on("error", reject);
		});
		assert.match(
			body,
			/<script id="__proxy_config__" type="application\/json">/,
		);
		assert.doesNotMatch(body, /window\.__PROXY_CONFIG__\s*=/);
	});
});
