'use strict';

/**
 * S3/R2 storage adapter skeleton.
 *
 * Requires: @aws-sdk/client-s3 (or compatible R2 endpoint).
 * Configure via environment variables:
 *   S3_BUCKET, S3_REGION, S3_ENDPOINT (for R2/MinIO), S3_PREFIX
 *
 * @param {Object} opts
 * @param {string} opts.bucket
 * @param {string} [opts.region='auto']
 * @param {string} [opts.endpoint]
 * @param {string} [opts.prefix='logs/']
 * @returns {import('./interface').StorageAdapter}
 */
function createS3Storage(opts) {
  const { bucket, region = 'auto', endpoint, prefix = 'logs/' } = opts;

  // Lazy-load SDK to avoid hard dependency
  let s3;
  function getClient() {
    if (s3) return s3;
    const { S3Client } = require('@aws-sdk/client-s3');
    s3 = new S3Client({
      region,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
    return s3;
  }

  function key(id, suffix) {
    return prefix + id + suffix;
  }

  return {
    supportsDelta: false,

    async init() {
      // Verify bucket access
      const { HeadBucketCommand } = require('@aws-sdk/client-s3');
      await getClient().send(new HeadBucketCommand({ Bucket: bucket }));
    },

    async write(id, suffix, data) {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      await getClient().send(new PutObjectCommand({
        Bucket: bucket,
        Key: key(id, suffix),
        Body: data,
        ContentType: suffix.endsWith('.json') ? 'application/json' : 'text/plain',
      }));
    },

    async read(id, suffix) {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      const res = await getClient().send(new GetObjectCommand({
        Bucket: bucket,
        Key: key(id, suffix),
      }));
      return res.Body.transformToString('utf-8');
    },

    async list() {
      const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
      const files = [];
      let token;
      do {
        const res = await getClient().send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }));
        for (const obj of (res.Contents || [])) {
          files.push(obj.Key.slice(prefix.length));
        }
        token = res.IsTruncated ? res.NextContinuationToken : null;
      } while (token);
      return files;
    },

    async stat(id, suffix) {
      const { HeadObjectCommand } = require('@aws-sdk/client-s3');
      const res = await getClient().send(new HeadObjectCommand({
        Bucket: bucket,
        Key: key(id, suffix),
      }));
      return { mtimeMs: res.LastModified ? res.LastModified.getTime() : Date.now() };
    },

    async deleteFile(filename) {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      try {
        await getClient().send(new DeleteObjectCommand({
          Bucket: bucket,
          Key: prefix + filename,
        }));
      } catch (e) {
        if (e?.$metadata?.httpStatusCode !== 404 && e?.name !== 'NoSuchKey') throw e;
      }
    },
  };
}

module.exports = { createS3Storage };
