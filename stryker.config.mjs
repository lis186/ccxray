// Mutation testing, scoped to the wire parsers and pricing. See docs/mutation-testing.md.
// Runner: @stryker-mutator/tap-runner, because the suite is node:test (not vitest/jest).
// Each test file is one Stryker "test", so perTest coverage selects related files only.
import os from 'node:os';
import path from 'node:path';
const testFiles = [
  'test/wire-parsers-anthropic.test.js',
  'test/wire-parsers-anthropic-edges.test.js',
  'test/wire-parsers-build-entry.test.js',
  'test/wire-parsers-openai.test.js',
  'test/wire-parsers-openai-edges.test.js',
  'test/grok-wire.test.js',
  'test/openai-tool-fail.test.js',
  'test/turn-tool-calls.test.js',
  'test/cache-ttl-split.test.js',
  'test/session-branch.test.js',
  'test/sysprompt-ux.test.js',
  'test/rebuild-index.test.js',
  // pricing.js + default-rates.js
  'test/pricing.test.js',
  'test/pricing-edges.test.js',
  'test/pricing-context-cache.test.js',
  'test/pricing-single-source.test.js',
  'test/default-rates.test.js',
  'test/default-rates-edges.test.js',
  'test/usage-normalizer.test.js',
  'test/usage-unpriced-imported.test.js',
  'test/cost-worker-grok.test.js',
  'test/importer.test.js',
  'test/config.test.js',
];

// The price cache is package-relative (outside CCXRAY_HOME isolation). Point every
// test process at a path that does not exist, so no run reads or writes a real
// pricing-cache.json; tests that need a cache set CCXRAY_PRICING_CACHE themselves.
process.env.CCXRAY_PRICING_CACHE = path.join(os.tmpdir(), `ccxray-stryker-no-cache-${process.pid}`, 'pricing-cache.json');

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  mutate: ['server/wire-parsers/**/*.js', 'server/pricing.js', 'server/default-rates.js'],
  testRunner: 'tap',
  tap: {
    testFiles,
    // home-guard keeps every run off the real ~/.ccxray (docs/testing.md).
    // no-network fails any non-loopback connection (a pricing mutant can reach for LiteLLM).
    nodeArgs: ['--require', './test/helpers/home-guard.js', '--require', './test/helpers/no-network.js', '--test-reporter=tap', '-r', '{{hookFile}}', '{{testFile}}'],
    // Killing a bailed file skips home-guard's exit cleanup and leaks temp homes.
    forceBail: false,
  },
  coverageAnalysis: 'perTest',
  concurrency: 2,
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always',
};
