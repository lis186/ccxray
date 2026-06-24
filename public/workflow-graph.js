// ── Workflow Graph (prototype) ───────────────────────────────────────────────
// Turns a flat list of turn-entries into a swimlane workflow graph that exposes
// the structure a linear timeline flattens away: subagent spawn (fan-out),
// parallel lanes, and fan-in back to the orchestrator.
//
// Isomorphic: runs in the browser (attaches to window) and in Node (module.exports)
// so it can be unit-driven / rendered to a static SVG without a headless browser.
//
// INPUT  — entries: loaded turn objects shaped like the dashboard's allEntries[]:
//   { id, sessionId, receivedAt, elapsed, agent, title, displayNum,
//     isSubagent, sessionInferred, toolCalls:{name:count}, req:{messages:[...]} }
// OUTPUT — { lanes, nodes, edges, t0, t1 }
//
// Edge inference here mirrors what server/store.js already knows (inferParentSession:
// inflight + 30s window). The real integration would read an explicit
// entry.spawnedBy / entry.parentEntryId the server can stamp; the time-window
// inference below is the zero-backend-change fallback.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) Object.assign(root, api);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const SPAWN_WINDOW_MS = 60000; // a subagent's first turn must start within 60s of the spawning Agent call

  function agentToolCount(entry) {
    const tc = entry.toolCalls || {};
    return (tc.Agent || 0) + (tc.Task || 0) + (tc.TaskCreate || 0);
  }

  // Pull the Agent/Task tool_use blocks (with their descriptions) out of a turn's
  // own output. We look at assistant messages and keep spawn calls in order.
  function extractSpawnCalls(entry) {
    const out = [];
    const msgs = (entry.req && entry.req.messages) || [];
    for (const m of msgs) {
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task' || b.name === 'TaskCreate')) {
          const inp = b.input || {};
          out.push({ id: b.id, name: b.name, label: (inp.description || inp.subject || inp.prompt || '').slice(0, 48) });
        }
      }
    }
    // Fallback: we know the count but not the text (summary-only entries).
    if (!out.length && agentToolCount(entry)) {
      for (let i = 0; i < agentToolCount(entry); i++) out.push({ id: null, name: 'Agent', label: '' });
    }
    return out;
  }

  // Per-turn tool chips for display (name + count), skipping spawn tools which
  // are drawn as edges instead.
  function turnToolChips(entry) {
    const tc = entry.toolCalls || {};
    const chips = [];
    for (const k of Object.keys(tc)) {
      if (k === 'Agent' || k === 'Task' || k === 'TaskCreate') continue;
      chips.push(tc[k] > 1 ? k + '×' + tc[k] : k);
    }
    return chips;
  }

  function buildWorkflowGraph(entries, opts) {
    opts = opts || {};
    const list = (entries || []).filter(Boolean).slice().sort((a, b) => (a.receivedAt || 0) - (b.receivedAt || 0));
    if (!list.length) return { lanes: [], nodes: [], edges: [], t0: 0, t1: 0 };

    // 1. Partition into lanes by session. Main (explicit) session leads; each
    //    inferred/subagent session is its own lane, ordered by first activity.
    const bySession = new Map();
    for (const e of list) {
      const sid = e.sessionId || 'unknown';
      if (!bySession.has(sid)) bySession.set(sid, []);
      bySession.get(sid).push(e);
    }

    const laneMeta = [];
    for (const [sid, turns] of bySession) {
      const isSub = turns.some(t => t.isSubagent || t.sessionInferred);
      laneMeta.push({
        sessionId: sid,
        kind: isSub ? 'subagent' : 'main',
        turns,
        t0: turns[0].receivedAt || 0,
        t1: turns[turns.length - 1].receivedAt || 0,
        label: turns.find(t => t.title)?.title || (isSub ? 'subagent' : 'main') ,
      });
    }
    // main lanes first, then subagents by first-activity time
    laneMeta.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'main' ? -1 : 1;
      return a.t0 - b.t0;
    });
    laneMeta.forEach((l, i) => { l.idx = i; });
    const laneBySession = new Map(laneMeta.map(l => [l.sessionId, l]));

    // 2. Nodes — one per turn, on its lane.
    const nodes = [];
    for (const lane of laneMeta) {
      lane.turns.forEach((e, ti) => {
        nodes.push({
          id: e.id,
          laneIdx: lane.idx,
          sessionId: lane.sessionId,
          t: e.receivedAt || 0,
          dur: e.elapsed || 0,
          turnIndexInLane: ti,
          displayNum: e.displayNum || (ti + 1),
          agent: e.agent || 'claude',
          title: e.title || '',
          chips: turnToolChips(e),
          spawns: extractSpawnCalls(e),
          fail: !!e.toolFail,
          kind: lane.kind,
        });
      });
    }
    const nodeById = new Map(nodes.map(n => [n.id, n]));

    // 3. Sequence edges — consecutive turns within a lane.
    const edges = [];
    for (const lane of laneMeta) {
      for (let i = 1; i < lane.turns.length; i++) {
        edges.push({ type: 'seq', from: lane.turns[i - 1].id, to: lane.turns[i].id });
      }
    }

    // 4. Spawn edges (fan-out) — match each subagent lane to the spawning main turn.
    //    A subagent lane is spawned by the latest main turn that (a) issued an
    //    Agent/Task call and (b) started no more than SPAWN_WINDOW_MS before the
    //    subagent's first turn. Each spawn-call slot is consumed once.
    const mainSpawnSlots = [];
    for (const lane of laneMeta) {
      if (lane.kind !== 'main') continue;
      for (const e of lane.turns) {
        for (const s of extractSpawnCalls(e)) {
          mainSpawnSlots.push({ turnId: e.id, t: e.receivedAt || 0, label: s.label, used: false });
        }
      }
    }
    mainSpawnSlots.sort((a, b) => a.t - b.t);

    const subLanes = laneMeta.filter(l => l.kind === 'subagent').sort((a, b) => a.t0 - b.t0);
    for (const sub of subLanes) {
      const firstTurnId = sub.turns[0].id;
      let best = null;
      for (const slot of mainSpawnSlots) {
        if (slot.used) continue;
        if (slot.t > sub.t0) continue;
        if (sub.t0 - slot.t > SPAWN_WINDOW_MS) continue;
        if (!best || slot.t > best.t) best = slot;
      }
      if (best) {
        best.used = true;
        sub.spawnedBy = best.turnId;
        edges.push({ type: 'spawn', from: best.turnId, to: firstTurnId, label: best.label || sub.label });
      }
    }

    // 5. Fan-in edges — a subagent lane's last turn returns into the next main
    //    turn that starts after it (the turn that consumes the tool_result).
    for (const sub of subLanes) {
      const lastTurn = sub.turns[sub.turns.length - 1];
      const lastEnd = (lastTurn.receivedAt || 0) + (lastTurn.elapsed || 0);
      let target = null;
      for (const lane of laneMeta) {
        if (lane.kind !== 'main') continue;
        for (const e of lane.turns) {
          if ((e.receivedAt || 0) >= lastEnd - 1000) { // small slack
            if (!target || (e.receivedAt || 0) < target.t) target = { id: e.id, t: e.receivedAt || 0 };
            break;
          }
        }
      }
      if (target) edges.push({ type: 'fanin', from: lastTurn.id, to: target.id });
    }

    const t0 = Math.min(...nodes.map(n => n.t));
    const t1 = Math.max(...nodes.map(n => n.t + n.dur));
    return { lanes: laneMeta, nodes, edges, nodeById, laneBySession, t0, t1 };
  }

  // ── SVG renderer ───────────────────────────────────────────────────────────
  const C = {
    bg: '#0d1117', surface: '#161b22', border: '#30363d', text: '#e6edf3', dim: '#8b949e',
    accent: '#58a6ff', green: '#3fb950', red: '#f85149', yellow: '#d29922',
    spawn: '#ff8a65', fanin: '#4dd0e1',
  };

  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function renderWorkflowSVG(graph, opts) {
    opts = opts || {};
    const padL = 150;       // lane-label gutter
    const padR = 40, padT = 56, padB = 30;
    const laneH = 92;
    const minBoxW = 96, maxBoxW = 240;
    const pxPerSec = opts.pxPerSec || 36;

    const span = Math.max(1, (graph.t1 - graph.t0) / 1000);
    const plotW = Math.max(620, span * pxPerSec);
    const W = padL + plotW + padR;
    const H = padT + graph.lanes.length * laneH + padB;
    const xOf = t => padL + ((t - graph.t0) / 1000) * pxPerSec;
    const laneY = i => padT + i * laneH + laneH / 2;
    const boxH = 46;

    let s = '';
    s += `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">`;
    s += `<rect width="${W}" height="${H}" fill="${C.bg}"/>`;
    s += `<text x="${padL}" y="26" fill="${C.text}" font-size="15" font-weight="700">Workflow · Swimlane Flow</text>`;
    s += `<text x="${padL}" y="42" fill="${C.dim}" font-size="11">orchestrator + ${graph.lanes.filter(l=>l.kind==='subagent').length} subagent lane(s) · X = time · → spawn · ⇠ fan-in</text>`;

    // lane bands + labels
    graph.lanes.forEach((lane, i) => {
      const y = padT + i * laneH;
      if (i % 2 === 0) s += `<rect x="0" y="${y}" width="${W}" height="${laneH}" fill="#ffffff" opacity="0.015"/>`;
      s += `<line x1="${padL}" y1="${y + laneH}" x2="${W - padR}" y2="${y + laneH}" stroke="${C.border}" stroke-width="1" opacity="0.5"/>`;
      const dotColor = lane.kind === 'main' ? C.accent : C.spawn;
      s += `<circle cx="16" cy="${laneY(i)}" r="4" fill="${dotColor}"/>`;
      const lbl = lane.kind === 'main' ? 'orchestrator' : esc(lane.label || 'subagent');
      s += `<text x="28" y="${laneY(i) - 2}" fill="${C.text}" font-size="11" font-weight="600">${esc(lbl).slice(0,18)}</text>`;
      s += `<text x="28" y="${laneY(i) + 12}" fill="${C.dim}" font-size="9">${lane.kind} · ${lane.turns.length} turn(s)</text>`;
    });

    // time axis ticks (every 5s)
    for (let sec = 0; sec <= span + 0.001; sec += 5) {
      const x = padL + sec * pxPerSec;
      s += `<line x1="${x}" y1="${padT - 8}" x2="${x}" y2="${H - padB}" stroke="${C.border}" stroke-width="1" opacity="0.25"/>`;
      s += `<text x="${x + 3}" y="${padT - 12}" fill="${C.dim}" font-size="9">${sec}s</text>`;
    }

    const boxW = n => Math.max(minBoxW, Math.min(maxBoxW, n.chips.join(' ').length * 6.5 + 64));

    // edges first (under boxes)
    for (const e of graph.edges) {
      const a = graph.nodeById.get(e.from), b = graph.nodeById.get(e.to);
      if (!a || !b) continue;
      const ax = xOf(a.t), ay = laneY(a.laneIdx);
      const bx = xOf(b.t), by = laneY(b.laneIdx);
      if (e.type === 'seq') {
        const ax2 = ax + boxW(a);
        s += `<line x1="${ax2}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${C.dim}" stroke-width="1.5" opacity="0.5"/>`;
      } else if (e.type === 'spawn') {
        const sx = ax + boxW(a) * 0.5, sy = ay + boxH / 2;
        const ty = by - boxH / 2;
        const midY = (sy + ty) / 2;
        s += `<path d="M ${sx} ${sy} C ${sx} ${midY}, ${bx} ${midY}, ${bx} ${ty}" fill="none" stroke="${C.spawn}" stroke-width="2" marker-end="url(#arrowSpawn)"/>`;
        if (e.label) s += `<text x="${(sx+bx)/2}" y="${midY - 3}" fill="${C.spawn}" font-size="9" text-anchor="middle">spawn: ${esc(e.label).slice(0,28)}</text>`;
      } else if (e.type === 'fanin') {
        const sx = ax + boxW(a), sy = ay - boxH / 2;
        const ty = by + boxH / 2;
        const midY = (sy + ty) / 2;
        s += `<path d="M ${sx} ${sy} C ${sx + 30} ${midY}, ${bx} ${midY}, ${bx} ${ty}" fill="none" stroke="${C.fanin}" stroke-width="1.6" stroke-dasharray="4 3" marker-end="url(#arrowFanin)"/>`;
      }
    }

    // arrow markers
    s += `<defs>`;
    s += `<marker id="arrowSpawn" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="${C.spawn}"/></marker>`;
    s += `<marker id="arrowFanin" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="${C.fanin}"/></marker>`;
    s += `</defs>`;

    // boxes
    for (const n of graph.nodes) {
      const x = xOf(n.t), y = laneY(n.laneIdx);
      const w = boxW(n);
      const fill = n.kind === 'main' ? '#16243a' : '#2a1f1a';
      const stroke = n.fail ? C.red : (n.kind === 'main' ? C.accent : C.spawn);
      s += `<rect x="${x}" y="${y - boxH/2}" width="${w}" height="${boxH}" rx="7" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
      s += `<text x="${x + 9}" y="${y - 9}" fill="${C.text}" font-size="11" font-weight="700">#${n.displayNum} <tspan fill="${C.dim}" font-weight="400">${esc(n.agent)}</tspan></text>`;
      const chipText = n.chips.length ? n.chips.join('  ') : (n.title ? esc(n.title).slice(0, 26) : '·');
      s += `<text x="${x + 9}" y="${y + 6}" fill="${C.green}" font-size="9.5">${esc(chipText).slice(0, 34)}</text>`;
      if (n.dur) s += `<text x="${x + 9}" y="${y + 17}" fill="${C.dim}" font-size="8">${(n.dur/1000).toFixed(1)}s</text>`;
      if (n.spawns.length) s += `<text x="${x + w - 8}" y="${y - 9}" fill="${C.spawn}" font-size="9" text-anchor="end">⑂${n.spawns.length}</text>`;
    }

    s += `</svg>`;
    return s;
  }

  return { buildWorkflowGraph, renderWorkflowSVG, _SPAWN_WINDOW_MS: SPAWN_WINDOW_MS };
});
