'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * Local filesystem storage adapter.
 * @param {string} logsDir — absolute path to the logs directory
 * @returns {import('./interface').StorageAdapter}
 */
function createLocalStorage(logsDir) {
  const sharedDir = path.join(logsDir, 'shared');
  const indexPath = path.join(logsDir, 'index.ndjson');

  return {
    supportsDelta: true,

    async init() {
      await fsp.mkdir(logsDir, { recursive: true });
      await fsp.mkdir(sharedDir, { recursive: true });
    },

    async write(id, suffix, data) {
      await fsp.writeFile(path.join(logsDir, id + suffix), data);
    },

    async read(id, suffix) {
      return fsp.readFile(path.join(logsDir, id + suffix), 'utf8');
    },

    async list() {
      return fsp.readdir(logsDir);
    },

    async stat(id, suffix) {
      return fsp.stat(path.join(logsDir, id + suffix));
    },

    async deleteFile(filename) {
      try {
        await fsp.unlink(path.join(logsDir, filename));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    },

    // ── Index (index.ndjson) ──────────────────────────────────────────

    async appendIndex(line) {
      await fsp.appendFile(indexPath, line);
    },

    async readIndex() {
      try {
        return await fsp.readFile(indexPath, 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return '';
        throw e;
      }
    },

    // ── Shared content-addressed storage (shared/) ───────────────────

    async writeSharedIfAbsent(filename, data) {
      const p = path.join(sharedDir, filename);
      try {
        await fsp.writeFile(p, data, { flag: 'wx' });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    },

    async readShared(filename) {
      return fsp.readFile(path.join(sharedDir, filename), 'utf8');
    },

    async statShared(filename) {
      try {
        return await fsp.stat(path.join(sharedDir, filename));
      } catch { return null; }
    },

    async listShared() {
      try {
        return await fsp.readdir(sharedDir);
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
    },
  };
}

module.exports = { createLocalStorage };
