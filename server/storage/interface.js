'use strict';

/**
 * Storage adapter interface for ccxray log persistence.
 *
 * Every adapter must implement these methods. The proxy uses `id` (timestamp-based)
 * and `suffix` (_req.json, _res.json, _sse.txt) to identify files.
 *
 * @typedef {Object} StorageAdapter
 * @property {() => Promise<void>} init
 *   Ensure storage backend is ready (create dirs, check credentials, etc.).
 *
 * @property {(id: string, suffix: string, data: string|Buffer) => Promise<void>} write
 *   Write a log artifact. Fire-and-forget callers should .catch() the promise.
 *
 * @property {(id: string, suffix: string) => Promise<string>} read
 *   Read a log artifact as UTF-8 string. Throws if not found.
 *
 * @property {() => Promise<string[]>} list
 *   List all filenames in the log store (e.g. ['2025-03-17T12-00-00-000_req.json', ...]).
 *
 * @property {(id: string, suffix: string) => Promise<{mtimeMs: number}>} stat
 *   Get metadata (at minimum mtimeMs) for a log artifact. Throws if not found.
 *
 * @property {(filename: string) => Promise<void>} deleteFile
 *   Delete a log artifact by full filename (e.g. '2025-03-17T12-00-00-000_req.json').
 *   Must silently succeed if the file does not exist.
 *
 * @property {boolean} supportsDelta
 *   When true, the proxy may write _req.json in delta format (prevId + partial messages)
 *   instead of storing the full messages array every turn. Set false for high-latency or
 *   multi-writer backends (S3) where chain traversal on read would be too costly.
 */

module.exports = {};
