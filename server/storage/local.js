"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function safeJoin(baseDir, id, suffix) {
	const name = String(id) + String(suffix || "");
	if (
		!name ||
		name.includes("\0") ||
		name.includes("/") ||
		name.includes("\\") ||
		name === "." ||
		name === ".."
	) {
		throw new Error(`invalid storage id: ${JSON.stringify(name)}`);
	}
	const resolved = path.resolve(baseDir, name);
	const baseResolved = path.resolve(baseDir);
	if (
		resolved !== baseResolved &&
		!resolved.startsWith(baseResolved + path.sep)
	) {
		throw new Error(`path traversal blocked: ${JSON.stringify(name)}`);
	}
	return resolved;
}

/**
 * Local filesystem storage adapter.
 * @param {string} logsDir — absolute path to the logs directory
 * @returns {import('./interface').StorageAdapter}
 */
function createLocalStorage(logsDir) {
	const sharedDir = path.join(logsDir, "shared");
	const indexPath = path.join(logsDir, "index.ndjson");

	return {
		async init() {
			await fsp.mkdir(logsDir, { recursive: true, mode: DIR_MODE });
			await fsp.mkdir(sharedDir, { recursive: true, mode: DIR_MODE });
			try {
				await fsp.chmod(logsDir, DIR_MODE);
			} catch {}
			try {
				await fsp.chmod(sharedDir, DIR_MODE);
			} catch {}
		},

		async write(id, suffix, data) {
			await fsp.writeFile(safeJoin(logsDir, id, suffix), data, {
				mode: FILE_MODE,
			});
		},

		async read(id, suffix) {
			return fsp.readFile(safeJoin(logsDir, id, suffix), "utf8");
		},

		async list() {
			return fsp.readdir(logsDir);
		},

		async stat(id, suffix) {
			return fsp.stat(safeJoin(logsDir, id, suffix));
		},

		// ── Index (index.ndjson) ──────────────────────────────────────────

		async appendIndex(line) {
			await fsp.appendFile(indexPath, line, { mode: FILE_MODE });
		},

		async readIndex() {
			try {
				return await fsp.readFile(indexPath, "utf8");
			} catch (e) {
				if (e.code === "ENOENT") return "";
				throw e;
			}
		},

		// ── Shared content-addressed storage (shared/) ───────────────────

		async writeSharedIfAbsent(filename, data) {
			const p = safeJoin(sharedDir, filename, "");
			try {
				await fsp.writeFile(p, data, { flag: "wx", mode: FILE_MODE });
			} catch (e) {
				if (e.code !== "EEXIST") throw e;
			}
		},

		async readShared(filename) {
			return fsp.readFile(safeJoin(sharedDir, filename, ""), "utf8");
		},

		async statShared(filename) {
			try {
				return await fsp.stat(safeJoin(sharedDir, filename, ""));
			} catch {
				return null;
			}
		},

		async listShared() {
			try {
				return await fsp.readdir(sharedDir);
			} catch (e) {
				if (e.code === "ENOENT") return [];
				throw e;
			}
		},
	};
}

module.exports = { createLocalStorage, safeJoin };
