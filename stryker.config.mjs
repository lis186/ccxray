// Mutation-testing pilot, scoped to the wire parsers. See docs/mutation-testing.md.
// Runner: @stryker-mutator/tap-runner, because the suite is node:test (not vitest/jest).
// Each test file is one Stryker "test", so perTest coverage selects related files only.
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
];

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  mutate: ['server/wire-parsers/**/*.js'],
  testRunner: 'tap',
  tap: {
    testFiles,
    // home-guard keeps every run off the real ~/.ccxray (docs/testing.md).
    nodeArgs: ['--require', './test/helpers/home-guard.js', '--test-reporter=tap', '-r', '{{hookFile}}', '{{testFile}}'],
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
