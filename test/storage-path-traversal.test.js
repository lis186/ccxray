"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createLocalStorage, safeJoin } = require("../server/storage/local");

describe("storage path traversal guard", () => {
	const tmpDir = path.join(os.tmpdir(), "ccxray-pt-" + Date.now());
	let storage;

	before(async () => {
		storage = createLocalStorage(tmpDir);
		await storage.init();
	});

	after(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("rejects id containing ..", async () => {
		await assert.rejects(() =>
			storage.write("../../etc/passwd", "_req.json", "x"),
		);
	});

	it("rejects id containing slash", async () => {
		await assert.rejects(() => storage.write("foo/bar", "_req.json", "x"));
	});

	it("rejects id containing backslash", async () => {
		await assert.rejects(() => storage.write("foo\\bar", "_req.json", "x"));
	});

	it("rejects id containing null byte", async () => {
		await assert.rejects(() => storage.write("abc\x00", "_req.json", "x"));
	});

	it("accepts normal id", async () => {
		await storage.write("normal-id-123", "_req.json", "ok");
		const data = await storage.read("normal-id-123", "_req.json");
		assert.equal(data, "ok");
	});

	it("safeJoin rejects absolute-like escape", () => {
		assert.throws(() => safeJoin(tmpDir, "../escape", ""));
	});

	it("safeJoin accepts simple filename", () => {
		const p = safeJoin(tmpDir, "file", "_req.json");
		assert.ok(p.startsWith(tmpDir + path.sep));
	});
});
