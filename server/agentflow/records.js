'use strict';

// Dispatch and completion records (docs/agentflow-integration.md, agentflow
// concepts and E3). Records are read here; whether they bind a run is E2/E3's
// job. A record that does not validate is still returned, marked, because E1
// discovers its clone regardless.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const RUNNER_CLONE = /^(.*\/agentflow-external-runner-[^/]+\/clone)(?:\/|$)/u;

function list(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function absPath(v) { return typeof v === 'string' && v.startsWith('/') ? v.replace(/\/+$/u, '') : null; }

function parseTime(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/u.exec(v.trim());
  if (m) {
    const [y, mo, d, h, mi, s, sign, oh, om] = m.slice(1).map((x, i) => i === 6 ? x : Number(x));
    return Date.UTC(y, mo - 1, d, h, mi, s) - (sign === '-' ? -1 : 1) * (oh * 60 + om) * 60000;
  }
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

function commandArgs(r) {
  const c = r.command || (r.result && r.result.command);
  if (!c) return [];
  if (typeof c === 'string') return c.split(/\s+/u);
  return [c.executable, ...(Array.isArray(c.args) ? c.args : [])].filter(x => typeof x === 'string');
}

// Requested model and effort when the record does not state them: the
// recorded command line (claude --model/--effort, codex -m/-c model_reasoning_effort).
function requestedFromArgs(args) {
  let model = null, effort = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i], next = args[i + 1];
    if ((a === '--model' || a === '-m') && next) model = next;
    else if (a.startsWith('--model=')) model = a.slice(8);
    else if (a === '--effort' && next) effort = next;
    else if (a.startsWith('--effort=')) effort = a.slice(9);
    const re = /model_reasoning_effort=["']?([a-z]+)/u.exec(a);
    if (re) effort = re[1];
  }
  return { model, effort };
}

function cloneOf(r) {
  const res = r.result && typeof r.result === 'object' ? r.result : {};
  const direct = absPath(r.clone) || absPath(r.clone && r.clone.root) || absPath(r.clone_root) || absPath(r.working_directory)
    || absPath(res.clone && res.clone.root) || absPath(res.working_directory);
  if (direct) return direct;
  for (const v of [r.result_file_path, r.result_file && r.result_file.path, r.declared_result_file && r.declared_result_file.path]) {
    const m = typeof v === 'string' && RUNNER_CLONE.exec(v);
    if (m) return m[1];
  }
  return null;
}

// `<ws>/artifacts/<A-NNN-slug>/[dispatch/]<stage>-dispatch.json`, and the same
// under each feature stream's `<ws>/features/<key>/artifacts/`.
function readDispatchRecords(workspace) {
  const out = [];
  const scan = (artifacts, scope) => {
    for (const askDir of list(artifacts)) {
      const am = /^(A-\d+)(?:-|$)/u.exec(askDir.name);
      if (!askDir.isDirectory() || !am) continue;
      const dirs = [path.join(artifacts, askDir.name), path.join(artifacts, askDir.name, 'dispatch')];
      for (const dir of dirs) {
        for (const f of list(dir)) {
          if (!f.isFile() || !f.name.endsWith('-dispatch.json')) continue;
          const file = path.join(dir, f.name);
          const r = readJson(file);
          if (!r || typeof r !== 'object') { out.push({ file, scope, ask: am[1], unreadable: true }); continue; }
          const fromArgs = requestedFromArgs(commandArgs(r));
          out.push({
            file, scope, ask: am[1],
            stage: typeof r.stage === 'string' ? r.stage : f.name.slice(0, -'-dispatch.json'.length),
            model: typeof r.model === 'string' ? r.model : fromArgs.model,
            effort: typeof r.effort === 'string' ? r.effort : fromArgs.effort,
            started: parseTime(r.started),
            finished: parseTime(r.finished),
            clone: cloneOf(r),
          });
        }
      }
    }
  };
  scan(path.join(workspace, 'artifacts'), 'workspace');
  for (const k of list(path.join(workspace, 'features'))) {
    if (k.isDirectory()) scan(path.join(workspace, 'features', k.name, 'artifacts'), `features/${k.name}`);
  }
  return out;
}

// Upstream agentflow's reply_digest (completion-record.js), unchanged: the Reply
// without its heading and stamp, up to a Questions section, trailing `---` dropped.
function replyDigest(reply) {
  const body = reply.replace(/\r\n/gu, '\n').replace(/^\s*#{1,2} (?:← )?Reply \/[^\n]*\n/u, '').replace(/^\s*\* _[^\n]+_\n/u, '');
  const lines = [];
  let fence;
  for (const line of body.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (!fence && /^## \[?Questions\b/iu.test(line)) break;
    if (!fence && marker) fence = { char: marker[1][0], length: marker[1].length };
    else if (fence && marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    lines.push(line);
  }
  return sha256(lines.join('\n').trim().replace(/\n---\s*$/u, '').trim());
}

// The notebook a completion namespace names: '' for `<ws>/devlog.md`,
// `features/<k>` for the stream notebook, `notebooks/<sha256(path)[:16]>` else.
function notebookForNamespace(ns, wsRel, notebooks) {
  if (ns === '') return notebooks.find(n => n.rel === `${wsRel}/devlog.md`) || null;
  const f = /^features\/([a-z0-9][a-z0-9-]*)$/u.exec(ns);
  if (f) return notebooks.find(n => n.rel === `${wsRel}/features/${f[1]}/${f[1]}.devlog.md`) || null;
  const h = /^notebooks\/([a-f0-9]{16})$/u.exec(ns);
  if (h) return notebooks.find(n => sha256(n.rel).slice(0, 16) === h[1]) || null;
  return null;
}

// Completion records under `<ws>/.tmp/<namespace>/<A-NNN>/completion.json`.
// notebooks: [{ rel (repository-relative POSIX path), asks: [{ id, replyText }] }].
function readCompletionRecords(workspace, root, notebooks) {
  const wsRel = path.relative(root, workspace).split(path.sep).join('/');
  const tmp = path.join(workspace, '.tmp');
  const out = [];
  const walk = (dir, rel) => {
    for (const d of list(dir)) {
      if (!d.isDirectory()) continue;
      const sub = path.join(dir, d.name), subRel = rel ? `${rel}/${d.name}` : d.name;
      if (/^A-\d+$/u.test(d.name) && fs.existsSync(path.join(sub, 'completion.json'))) out.push(readOne(sub, rel, d.name));
      else walk(sub, subRel);
    }
  };
  const readOne = (dir, ns, ask) => {
    const file = path.join(dir, 'completion.json');
    const bytes = fs.readFileSync(file);
    const rec = (() => { try { return JSON.parse(bytes.toString('utf8')); } catch { return null; } })();
    const ref = readJson(path.join(dir, 'completion.ref.json'));
    const nb = notebookForNamespace(ns, wsRel, notebooks);
    const metadata = rec && typeof rec.metadata_text === 'string' ? rec.metadata_text : '';
    const clones = [...new Set([...metadata.matchAll(/"clone"\s*:\s*"(\/[^"]+)"/gu)].map(m => m[1].replace(/\/+$/u, '')))];
    let reason = null;
    if (!rec) reason = 'unreadable record';
    else if (!nb) reason = 'namespace names no notebook';
    else if (rec.notebook !== nb.rel || rec.ask !== ask) reason = 'record does not match its location';
    else if (!ref || ref.sha256 !== sha256(bytes)) reason = 'record digest mismatch';
    else {
      const a = nb.asks.find(x => x.id === ask);
      if (!a || !a.replyText) reason = 'no Reply for the Ask';
      else if (ref.reply_sha256 !== replyDigest(a.replyText)) reason = 'Reply digest mismatch';
    }
    return { file, ask, notebook: nb ? nb.rel : null, clones, valid: reason == null, reason };
  };
  walk(tmp, '');
  return out;
}

module.exports = { parseTime, requestedFromArgs, readDispatchRecords, replyDigest, notebookForNamespace, readCompletionRecords };
