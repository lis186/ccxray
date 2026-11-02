#!/usr/bin/env python3
"""Reproduce scenario mutations in an isolated archive of a committed tree."""
import difflib
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
SHA = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
OUT = Path(os.environ.get('EVIDENCE_OUT', str(Path(__file__).resolve().parent)))
OUT.mkdir(parents=True, exist_ok=True)

def clean(text, scratch):
    return text.replace(str(ROOT), '<checkout>').replace(str(scratch), '<fixture>')

def execute(tree, scratch, name, pattern, filename):
    home = Path(tempfile.mkdtemp(dir=scratch))
    env = dict(os.environ, HOME=str(home), CCXRAY_HOME=str(home / '.ccxray'),
               LOGS_DIR=str(home / '.ccxray/logs'), GIT_CONFIG_GLOBAL=str(home / '.gitconfig'),
               CCXRAY_EXPORT_DISABLE='1', CCXRAY_NETWORK_GUARD_ENFORCE='1')
    env.pop('NODE_OPTIONS', None)
    cmd = ['node', '--require', './test/helpers/home-guard.js', '--require', './test/helpers/no-network.js',
           '--experimental-test-isolation=none', '--test', '--test-reporter=tap', '--test-concurrency=1',
           '--test-name-pattern=' + pattern, filename]
    result = subprocess.run(cmd, cwd=tree, env=env, text=True, capture_output=True, timeout=40)
    log = result.stdout + result.stderr
    (OUT / (name + '.txt')).write_text('Code commit: ' + SHA + '\nCommand: HOME=<fresh> CCXRAY_HOME=<fresh> LOGS_DIR=<fresh> GIT_CONFIG_GLOBAL=<fresh> CCXRAY_EXPORT_DISABLE=1 CCXRAY_NETWORK_GUARD_ENFORCE=1 ' + shlex.join(cmd) + '\nExit: ' + str(result.returncode) + '\n' + clean('\n'.join(log.splitlines()[-70:]) + '\n', scratch))
    fail = re.search(r'^# fail (\d+)$', log, re.M)
    passed = re.search(r'^# pass (\d+)$', log, re.M)
    assert fail and passed, log
    return {'exit': result.returncode, 'pass': int(passed[1]), 'fail': int(fail[1])}

with tempfile.TemporaryDirectory(prefix='usage-contract-proof-') as directory:
    scratch = Path(directory)
    tree = scratch / 'tree'
    tree.mkdir()
    archive = subprocess.check_output(['git', 'archive', SHA], cwd=ROOT)
    with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
        bundle.extractall(tree, filter='data')
    if (ROOT / 'node_modules').exists():
        (tree / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    query = 'server/usage-query.js'
    usage = 'server/usage.js'
    docs = 'docs/usage-query-contract.md'
    mutations = [
        (1, query, '    schemaVersion: 1,', '', 'remove-schema-version'),
        (2, query, "? 'observed' : 'not-observed'", "? 'observed' : 'observed'", 'invent-source-observation'),
        (3, docs, '"schemaVersion": {"const": 1}', '"schemaVersion": {"const": 99}', 'document-wrong-version'),
        (4, usage, 'async function run(argv) {', "async function run(argv) {\n  fs.appendFileSync(require('path').join(require('os').homedir(), 'sentinel'), 'changed');", 'write-during-query'),
        (5, query, '    if (branchSet && !branchSet.has(e.branch ?? null)) return false;', '    if (e.sources?.length === 2) return false;\n    if (branchSet && !branchSet.has(e.branch ?? null)) return false;', 'discard-merged-response'),
        (5, query, 'return Number.isFinite(n) && e.receivedAt != null ? n : null;', 'return Number.isFinite(n) ? n : null;', 'admit-undated-row'),
        (5, query, 'reasoning: evidence.length ? evidence.reduce((sum, n) => sum + n, 0) : null', 'reasoning: evidence.length ? evidence.reduce((sum, n) => sum + n, 0) : 0', 'invent-zero-reasoning'),
        (5, usage, '  const contract = (args.json || args.by)', '  if (!entries.length && args.by) { process.exitCode = 1; return; }\n  const contract = (args.json || args.by)', 'reject-empty-group'),
    ]
    mutations.extend([
        (3, 'docs/usage.md', '`coverage`, `sourceCoverage`,', '`coverage`,', 'omit-reference-source-coverage'),
        (None, query, '    models: Object.create(null),', '    models: {},', 'unsafe-model-counter'),
        (None, query, '  out.models = Object.fromEntries(Object.entries(out.models));', '', 'leak-counter-prototype'),
        (None, usage, "t.reasoning ?? 'unknown'", 't.reasoning', 'print-null-reasoning'),
    ])
    regression_tests = {
        'unsafe-model-counter': ('returns plain counting objects', 'test/usage-query.test.js'),
        'leak-counter-prototype': ('returns plain counting objects', 'test/usage-query.test.js'),
        'print-null-reasoning': ('parses grouped JSON', 'test/usage-group.test.js'),
    }
    results = []
    for scenario, filename, old, new, label in mutations:
        target = tree / filename
        original = target.read_text()
        assert original.count(old) == 1, (label, original.count(old))
        changed = original.replace(old, new)
        base = ('scenario-' + str(scenario) + '-' if scenario else 'regression-') + label
        diff = ''.join(difflib.unified_diff(original.splitlines(True), changed.splitlines(True), fromfile='a/' + filename, tofile='b/' + filename))
        (OUT / (base + '.patch')).write_text('# Code commit: ' + SHA + '\n' + diff)
        test = 'test/usage-contract-purity.test.js' if scenario == 4 else 'test/usage-contract.test.js'
        pattern, test = regression_tests.get(label, ('^Scenario ' + str(scenario) + ':', test))
        try:
            target.write_text(changed)
            red = execute(tree, scratch, base + '-red', pattern, test)
            assert red['fail'] > 0, (base, red)
        finally:
            target.write_text(original)
        assert target.read_text() == original
        green = execute(tree, scratch, base + '-green', pattern, test)
        assert green['fail'] == 0 and green['pass'] == 1, (base, green)
        results.append(dict(scenario=scenario, mutation=label, red=red, green=green))
    (OUT / 'break-proof.json').write_text(json.dumps(dict(codeCommit=SHA, results=results), indent=2) + '\n')
    print(json.dumps(results, indent=2))
