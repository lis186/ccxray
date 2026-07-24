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
 * @property {() => AsyncIterable<string>} readIndexLines
 *   Stream index.ndjson line-by-line (blank lines skipped). Unlike readIndex(),
 *   never materializes the whole file into one string, so it is safe past Node's
 *   ~512MB single-string limit (#345). Missing index → empty iteration.
 *
 * @property {(id: string, suffix: string) => Promise<{mtimeMs: number}>} stat
 *   Get metadata (at minimum mtimeMs) for a log artifact. Throws if not found.
 *
 * @property {(filename: string) => Promise<void>} deleteFile
 *   Delete a log artifact by full filename (e.g. '2025-03-17T12-00-00-000_req.json').
 *   Must silently succeed if the file does not exist.
 *
 * @property {(content: string) => Promise<void>} writeIndex
 *   Atomically replace the entire index.ndjson with `content`. Used by pruneLogs
 *   (#344) to drop index lines whose _req/_res files were pruned. Must be atomic
 *   (tmp + rename) so a concurrent reader never sees a half-written index.
 *
 * @property {boolean} supportsDelta
 *   When true, the proxy may write _req.json in delta format (prevId + partial messages)
 *   instead of storing the full messages array every turn. Set false for high-latency or
 *   multi-writer backends (S3) where chain traversal on read would be too costly.
 *
 * @property {string} location
 *   Human-readable destination for the startup banner (e.g. '/home/u/.ccxray/logs'
 *   for local, 's3://bucket/logs/' for S3). Display-only; not used for I/O.
 */

module.exports = {};
