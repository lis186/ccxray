#!/usr/bin/env python3
"""Produce compact, serial evidence from the committed source tree."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
SHA = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
BASE = 'a13a38850cd5f8f51c754025f233af4cc9f31879'
results = {}

def run(name, args, cwd=ROOT, target=SHA):
    with tempfile.TemporaryDirectory(prefix='usage-evidence-') as directory:
        env = dict(os.environ, HOME=directory)
        # The standard preload supplies CCXRAY_HOME. Never inherit service roots.
        for key in ['CCXRAY_HOME', 'LOGS_DIR', 'GIT_CONFIG_GLOBAL', 'NODE_OPTIONS', 'NODE_TEST_REAL_HOME']:
            env.pop(key, None)
        proc = subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True, timeout=1200)
        log = proc.stdout + proc.stderr
        counts = {key: int(re.findall(r'^[#ℹ] ' + key + r' (\d+)$', log, re.M)[-1])
                  for key in ['tests', 'pass', 'fail', 'skipped']}
        result = dict(codeCommit=SHA, testedCommit=target, command='T=$(mktemp -d); HOME=$T ' + shlex.join(args),
                      exit=proc.returncode, **counts)
        results[name] = result
        tail = '\n'.join(log.splitlines()[-18:])
        failures = '\n'.join(line for line in log.splitlines() if '✖' in line or line.startswith('not ok'))
        text = json.dumps(result, indent=2) + '\nFailure names:\n' + (failures or '(none)') + '\nLast lines:\n' + tail + '\n'
        text = text.replace(str(ROOT), '<checkout>').replace(str(cwd), '<checkout>').replace(directory, '<fresh-home>')
        (OUT / (name + '.txt')).write_text(text)
        print(name, counts, 'exit', proc.returncode, flush=True)
        return proc.returncode

heavy = ['node', '--require', './test/helpers/home-guard.js', '--test', '--test-concurrency=1']
files = ['test/usage.test.js', 'test/usage-query.test.js', 'test/usage-unpriced-imported.test.js']
assert run('heavy-final', heavy + files) == 0
for filename in files:
    assert run(Path(filename).stem + '-final', heavy + [filename]) == 0
assert run('unit-final', ['node', 'scripts/run-tests.js', 'unit']) == 0
focused = ['node', '--require', './test/helpers/home-guard.js', '--require', './test/helpers/no-network.js',
           '--experimental-test-isolation=none', '--test', '--test-reporter=tap', '--test-concurrency=1']
for name, filename in [('contract-final', 'usage-contract.test.js'), ('purity-final', 'usage-contract-purity.test.js'), ('group-final', 'usage-group.test.js')]:
    assert run(name, focused + ['test/' + filename]) == 0

# Reproduce the reviewed failures without modifying the current checkout.
with tempfile.TemporaryDirectory(prefix='usage-before-') as directory:
    tree = Path(directory)
    with tarfile.open(fileobj=io.BytesIO(subprocess.check_output(['git', 'archive', BASE], cwd=ROOT))) as archive:
        archive.extractall(tree, filter='data')
    if (ROOT / 'node_modules').exists():
        (tree / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    assert run('heavy-before', heavy + files, tree, BASE) != 0

# CLI read-only fixture: merge complementary metadata, exclude a marker and
# hash every fixture file before/after both successful and empty queries.
with tempfile.TemporaryDirectory(prefix='usage-cli-') as directory:
    home = Path(directory)
    logs = home / '.ccxray/logs'
    logs.mkdir(parents=True)
    rows = [dict(id='proxy', responseId='dummy-response', sessionId='dummy-session', receivedAt=1000,
                 model='dummy-model', agentId='run-demo', usage=dict(input_tokens=10, output_tokens=5), cost=dict(cost=0.01)),
            dict(id='import', responseId='dummy-response', sessionId='dummy-session', receivedAt=1000,
                 model='dummy-model', imported=True, branch='main'),
            dict(id='marker', receivedAt=1000)]
    (logs / 'index.ndjson').write_text(''.join(json.dumps(row) + '\n' for row in rows))
    def hashes():
        return {str(p.relative_to(home)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(home.rglob('*')) if p.is_file()}
    before = hashes()
    env = dict(os.environ, HOME=directory, CCXRAY_HOME=str(home / '.ccxray'), LOGS_DIR=str(logs),
               GIT_CONFIG_GLOBAL=str(home / '.gitconfig'), CCXRAY_EXPORT_DISABLE='1')
    env.pop('NODE_OPTIONS', None)
    probes = []
    for selector in ['run-demo', 'missing']:
        args = ['node', 'server/index.js', 'usage', '--json', '--turns', '--agent-id', selector, '--branch', 'main']
        proc = subprocess.run(args, cwd=ROOT, env=env, text=True, capture_output=True, timeout=20)
        assert proc.returncode == 0, proc.stderr
        data = json.loads(proc.stdout)
        assert data['schemaVersion'] == 1 and data['totals']['turns'] == (1 if selector == 'run-demo' else 0)
        probes.append(dict(command='HOME=<fresh> CCXRAY_HOME=<fresh> LOGS_DIR=<fresh> GIT_CONFIG_GLOBAL=<fresh> CCXRAY_EXPORT_DISABLE=1 ' + shlex.join(args),
                           exit=proc.returncode, schemaVersion=data['schemaVersion'], coverage=data['coverage'],
                           sourceCoverage=data['sourceCoverage'], turns=data['totals']['turns'],
                           excludedMarkerRows=data['excludedMarkerRows']))
    after = hashes()
    assert before == after
    (OUT / 'cli-fixture.json').write_text(json.dumps(dict(codeCommit=SHA, probes=probes, before=before, after=after, unchanged=True), indent=2) + '\n')

ancestry = {commit: subprocess.run(['git', 'merge-base', '--is-ancestor', commit, SHA], cwd=ROOT).returncode
            for commit in ['9b76d46', 'f668bf8']}
assert all(code == 0 for code in ancestry.values())
(OUT / 'integration.txt').write_text(json.dumps(dict(codeCommit=SHA, branch='feat/742-usage-contract',
    localMain=subprocess.check_output(['git', 'rev-parse', 'origin/main'], cwd=ROOT, text=True).strip(),
    ancestorExitCodes=ancestry, remoteRefresh=False), indent=2) + '\n')
(OUT / 'results.json').write_text(json.dumps(dict(codeCommit=SHA, node=subprocess.check_output(['node', '--version'], text=True).strip(), results=results), indent=2) + '\n')
