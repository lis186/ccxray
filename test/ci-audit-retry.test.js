'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const windowsSkip = process.platform === 'win32' && 'bash audit script runs on ubuntu CI only';
const bashProbe = windowsSkip ? null : spawnSync('bash', ['--version'], { timeout: 20000 });
const timeoutProbe = windowsSkip || bashProbe.error?.code === 'ENOENT' ? null : spawnSync('bash', ['-c', 'command -v timeout'], { env: process.env, timeout: 20000 });
const skip = windowsSkip || (bashProbe.error?.code === 'ENOENT' && 'bash is not installed') ||
  (timeoutProbe && timeoutProbe.status !== 0 && 'timeout command is not installed');
const success = { output: 'found 0 vulnerabilities', status: 0 };
const serviceError = {
  output: 'npm warn audit 503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick - Service Unavailable\n' +
    'npm error audit endpoint returned an error',
  status: 1,
};
const report = '# npm audit report\nexample-package\nSeverity: high\n1 high severity vulnerability';
const cases = [
  {
    name: 'retries two registry 503 failures before success',
    steps: [serviceError, serviceError, success], attempts: 3, status: 0,
  },
  {
    name: 'fails after three persistent registry 503 failures',
    steps: [serviceError], attempts: 3, status: 1,
    stderr: /failed after 3 attempts/,
  },
  {
    name: 'fails immediately and preserves a real advisory report',
    steps: [{ output: report, status: 1 }], attempts: 1, status: 1,
    visible: report,
  },
  {
    name: 'does not retry network-like words in an advisory report',
    steps: [{
      output: '# npm audit report\nnetwork-ETIMEDOUT\nSeverity: high\nHTTP/1.1 500 network advisory\n1 high severity vulnerability',
      status: 1,
    }], attempts: 1, status: 1,
  },
  {
    name: 'does not treat a vulnerability count of 503 as a service error',
    steps: [{ output: '503 vulnerabilities (503 high)', status: 1 }], attempts: 1, status: 1,
  },
  {
    name: 'does not retry a bulk endpoint warning followed by a real report',
    steps: [{
      output: 'npm warn audit 503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk\n' + report,
      status: 1,
    }], attempts: 1, status: 1,
  },
  {
    name: 'retries a connection reset before success',
    steps: [{
      output: 'npm error code ECONNRESET\nnpm error network request to https://registry.npmjs.org/-/npm/v1/security/audits/quick failed',
      status: 1,
    }, success], attempts: 2, status: 0,
  },
  {
    name: 'succeeds on the first clean audit',
    steps: [success], attempts: 1, status: 0,
  },
];

function shellQuote(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

describe('ci-audit-retry.sh', { skip }, () => {
  for (const scenario of cases) {
    it(scenario.name, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-ci-audit-'));
      try {
        const counter = path.join(dir, 'attempts');
        const fake = path.join(dir, 'fake-audit.sh');
        fs.writeFileSync(counter, '');
        const branches = scenario.steps.map((step, index) =>
          `  ${index === scenario.steps.length - 1 ? '*' : index + 1})\n` +
          `    printf '%s\\n' ${shellQuote(step.output)}\n    exit ${step.status}\n    ;;`
        ).join('\n');
        fs.writeFileSync(fake, '#!/usr/bin/env bash\nset -eu\n' +
          'attempt=1\nwhile IFS= read -r line; do attempt=$((attempt + 1)); done < "$AUDIT_TEST_COUNTER"\n' +
          'printf "%s\\n" "$attempt" >> "$AUDIT_TEST_COUNTER"\n' +
          `case "$attempt" in\n${branches}\nesac\n`);

        const result = spawnSync('bash', ['scripts/ci-audit-retry.sh'], {
          cwd: root,
          env: {
            ...process.env,
            NPM_AUDIT_CMD: `bash ${shellQuote(fake)}`,
            AUDIT_RETRY_WAITS: '0 0',
            AUDIT_TEST_COUNTER: counter,
          },
          encoding: 'utf8',
          timeout: 20000,
        });
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        assert.equal(result.status, scenario.status, result.stdout + result.stderr);
        const attempts = fs.readFileSync(counter, 'utf8').trim().split('\n');
        assert.deepEqual(attempts, Array.from({ length: scenario.attempts }, (_, i) => String(i + 1)));
        const lastStep = scenario.steps[Math.min(attempts.length, scenario.steps.length) - 1];
        assert.equal(result.status, lastStep.status, 'must preserve the last audit exit code');
        if (scenario.stderr) assert.match(result.stderr, scenario.stderr);
        if (scenario.visible) assert.ok((result.stdout + result.stderr).includes(scenario.visible));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
