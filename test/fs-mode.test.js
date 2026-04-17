"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createLocalStorage } = require("../server/storage/local");

const isWindows = process.platform === "win32";

describe("storage fs modes", { skip: isWindows }, () => {
	const tmpDir = path.join(os.tmpdir(), "ccxray-mode-" + Date.now());
	let storage;

	before(async () => {
		storage = createLocalStorage(tmpDir);
		await storage.init();
	});

	after(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("logsDir has 0700 permissions", () => {
		const mode = fs.statSync(tmpDir).mode & 0o777;
		assert.equal(mode, 0o700);
	});

	it("sharedDir has 0700 permissions", () => {
		const mode = fs.statSync(path.join(tmpDir, "shared")).mode & 0o777;
		assert.equal(mode, 0o700);
	});

	it("written log file has 0600 permissions", async () => {
		await storage.write("test-mode", "_req.json", "x");
		const mode =
			fs.statSync(path.join(tmpDir, "test-mode_req.json")).mode & 0o777;
		assert.equal(mode, 0o600);
	});

	it("written shared file has 0600 permissions", async () => {
		await storage.writeSharedIfAbsent("hash-abc", "data");
		const mode =
			fs.statSync(path.join(tmpDir, "shared", "hash-abc")).mode & 0o777;
		assert.equal(mode, 0o600);
	});
});
