'use strict';

const MODEL_COLORS = {
  'claude-opus-4-6':'#58a6ff','claude-opus-4-8':'#7ee787','claude-fable-5':'#d2a8ff',
  'claude-sonnet-4-6':'#ffa657','claude-haiku-4-5':'#f0883e','claude-haiku-4-5-20251001':'#f0883e',
};
const FAIL_COLOR = '#f85149';
const BORDER = '#30363d', TEXT = '#e6edf3', DIM = '#8b949e';
const LABEL_WIDTH = 240;
const SPARKLINE_H = 16, TURN_ROW_H = 8, LANE_GAP = 4;
const LANE_H = TURN_ROW_H + SPARKLINE_H + LANE_GAP;
const AXIS_H = 18, PAD_TOP = 4, PAD_BOT = 4, MIN_TURN_PX = 1.5;

let fixture = null, currentSession = null, lanes = [];
let sessionTimeMin = 0, sessionTimeMax = 0;
let viewT0 = 0, viewT1 = 0;
let selectedLane = null, selectedTurnId = null;
let starredTurns = new Set(), starredAgents = new Set();
let collapsedWorkflows = new Set(); // workflow names that are collapsed
let workflowMeta = null; // current session's workflow meta

const $projectsList = document.getElementById('projects-list');
const $sessionsList = document.getElementById('sessions-list');
const $mainSvg = document.getElementById('main-svg');
const $svg = document.getElementById('macro-svg');
const $tooltip = document.getElementById('tooltip');
const $zoomLabel = document.getElementById('zoom-label');
const $minimap = document.getElementById('minimap');
const $agentCardHeader = document.getElementById('agent-card-header');
const $agentCardBody = document.getElementById('agent-card-body');
const $stepsHeader = document.getElementById('steps-header');
const $stepsList = document.getElementById('steps-list');

fetch('../../prototype-fixture.json')
  .then(r => r.json())
  .then(data => { fixture = data; init(); })
  .catch(e => { document.body.textContent = 'Failed to load fixture: ' + e; });

function init() {
  // Projects column (placeholder — group sessions by a fake project name)
  const projNames = ['ccxray'];
  $projectsList.innerHTML = projNames.map((p, i) =>
    `<div class="project-item${i === 0 ? ' active' : ''}" data-proj="${p}">
      <div class="proj-name">● ${esc(p)}</div>
      <div class="proj-meta">${fixture.sessions.length} sessions</div>
    </div>`
  ).join('');

  // Sessions column
  renderSessionsList();
  selectSession(fixture.sessions[5]?.id || fixture.sessions[0].id);
}

function renderSessionsList() {
  $sessionsList.innerHTML = fixture.sessions.map(s => {
    const nTurns = s.turns.length;
    const models = [...new Set(s.turns.map(t => t.model))].map(m => shortModel(m)).join(', ');
    return `<div class="session-item" data-sid="${s.id}" onclick="selectSession('${s.id}')">
      <div class="sess-name">${esc(s.label || s.id)}</div>
      <div class="sess-meta">${models} · ${nTurns}t</div>
    </div>`;
  }).join('');
}

window.selectSession = function(id) {
  currentSession = fixture.sessions.find(s => s.id === id);
  if (!currentSession) return;
  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-sid') === id);
  });
  selectedTurnId = null;
  workflowMeta = currentSession.workflowMeta || null;
  // Auto-collapse workflows with > 4 subagent lanes
  collapsedWorkflows.clear();
  buildLanes();
  if (workflowMeta && lanes.length > 5) {
    collapsedWorkflows.add(workflowMeta.name);
  }
  viewT0 = sessionTimeMin; viewT1 = sessionTimeMax;
  selectedLane = lanes[0] || null;
  renderTimeline();
  renderAgentCard();
  renderSteps();
};

window.toggleWorkflowCollapse = function(name) {
  if (collapsedWorkflows.has(name)) collapsedWorkflows.delete(name);
  else collapsedWorkflows.add(name);
  renderTimeline();
};

// ── Lane inference ─────────────────────────────────────────────────────────
function buildLanes() {
  const turns = currentSession.turns;
  if (!turns.length) { lanes = []; return; }
  sessionTimeMin = Infinity; sessionTimeMax = -Infinity;
  for (const t of turns) {
    if (t.receivedAt < sessionTimeMin) sessionTimeMin = t.receivedAt;
    const end = t.receivedAt + (t.elapsed || 0);
    if (end > sessionTimeMax) sessionTimeMax = end;
  }
  const spawnReg = [];
  for (const t of turns) {
    for (const sp of (t.agentSpawns || [])) {
      spawnReg.push({ name: sp.name || sp.subagent_type || 'unnamed', type: sp.subagent_type,
        parentTurnIdx: t.turnIndex, parentTime: t.receivedAt, parentCtxPercent: t.contextPercent });
    }
  }
  const laneMap = new Map();
  const mainLane = { name: 'main', turns: [], model: null, ctxWindow: 0, spawnParent: null };
  laneMap.set('main', mainLane);
  let orchCtx = 0;
  const pending = [...spawnReg];
  for (const t of turns) {
    let sub = false;
    if (pending.length && orchCtx > 20 && t.contextPercent < orchCtx * 0.5 && t.contextPercent < 25) {
      const sp = findBestSpawn(t, pending);
      if (sp) {
        const key = sp.name || `sub-${sp.parentTurnIdx}`;
        if (!laneMap.has(key)) laneMap.set(key, { name: key, turns: [], model: null, ctxWindow: t.contextWindow, spawnParent: sp });
        laneMap.get(key).turns.push(t);
        if (!laneMap.get(key).model) laneMap.get(key).model = t.model;
        sub = true;
      }
    }
    if (!sub) {
      mainLane.turns.push(t);
      if (!mainLane.model) mainLane.model = t.model;
      mainLane.ctxWindow = t.contextWindow;
      if (t.contextPercent > orchCtx * 0.8) orchCtx = Math.max(orchCtx, t.contextPercent);
    }
  }
  lanes = [mainLane];
  for (const [k, l] of laneMap) if (k !== 'main' && l.turns.length) lanes.push(l);
  lanes.sort((a, b) => a.name === 'main' ? -1 : b.name === 'main' ? 1 : a.turns[0].receivedAt - b.turns[0].receivedAt);
  for (const l of lanes) {
    if (!l.turns.length) continue;
    const mc = {};
    for (const t of l.turns) mc[t.model] = (mc[t.model] || 0) + 1;
    l.model = Object.entries(mc).sort((a, b) => b[1] - a[1])[0][0];
    l.ctxWindow = l.turns[0].contextWindow;
  }
}

function findBestSpawn(turn, pending) {
  let best = null, bs = Infinity;
  for (const sp of pending) {
    if (turn.receivedAt < sp.parentTime) continue;
    const d = turn.receivedAt - sp.parentTime;
    if (d > 120000) continue;
    if (d < bs) { bs = d; best = sp; }
  }
  return best;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function modelColor(m) { return MODEL_COLORS[m] || Object.entries(MODEL_COLORS).find(([k]) => m.startsWith(k))?.[1] || DIM; }
function shortModel(m) { return m.replace('claude-', '').replace('-20251001', ''); }
function fmtDur(ms) { return ms < 1000 ? Math.round(ms) + 'ms' : ms < 60000 ? (ms / 1000).toFixed(1) + 's' : ms < 3600000 ? (ms / 60000).toFixed(1) + 'm' : (ms / 3600000).toFixed(1) + 'h'; }
function fmtMin(ms, base) {
  const s = (ms - base) / 1000;
  if (s < 60) return Math.round(s) + 's';
  if (s < 3600) return (s / 60).toFixed(s < 600 ? 1 : 0) + 'm';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h + 'h' + (m ? m + 'm' : '');
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function findTurn(id) { for (const l of lanes) for (const t of l.turns) if (t.id === id) return t; return null; }
function findLane(tid) { for (const l of lanes) for (const t of l.turns) if (t.id === tid) return l; return null; }

// ── Timeline rendering ────────────────────────────────────────────────────
function getVisibleLanes() {
  // If a workflow is collapsed, replace subagent lanes with a single summary row
  if (!workflowMeta || !collapsedWorkflows.has(workflowMeta.name)) return lanes;

  const mainLane = lanes[0];
  const subLanes = lanes.slice(1);
  if (!subLanes.length) return lanes;

  // Build a collapsed summary lane
  const allSubTurns = subLanes.flatMap(l => l.turns);
  const subModels = [...new Set(subLanes.map(l => l.model))].map(m => shortModel(m)).join('+');
  const collapsedLane = {
    name: `▸ wf: ${workflowMeta.name}`,
    model: subLanes[0]?.model || mainLane.model,
    ctxWindow: subLanes[0]?.ctxWindow || mainLane.ctxWindow,
    turns: allSubTurns.sort((a, b) => a.receivedAt - b.receivedAt),
    spawnParent: null,
    isCollapsedWorkflow: true,
    workflowName: workflowMeta.name,
    subLaneCount: subLanes.length,
    subTurnCount: allSubTurns.length,
    phases: workflowMeta.phases,
  };
  return [mainLane, collapsedLane];
}

// ponytail: two-SVG split — main lane sticky, sub-lanes scroll
function renderLaneSvg(lane, li, W, chartW, x, tRange, visLanes) {
  const ly = 0, trY = 0, spY = TURN_ROW_H;
  const color = modelColor(lane.model);
  const isSel = selectedLane?.name === lane.name;
  const isStarred = starredAgents.has(lane.name);
  let svg = '';

  if (isSel) {
    svg += `<rect x="0" y="0" width="3" height="${LANE_H - LANE_GAP}" fill="#58a6ff" rx="1"/>`;
    svg += `<rect x="0" y="0" width="${W}" height="${LANE_H - LANE_GAP}" fill="#58a6ff" opacity="0.04"/>`;
  }

  if (lane.isCollapsedWorkflow) {
    svg += `<rect x="0" y="0" width="${W}" height="${LANE_H - LANE_GAP}" fill="transparent" class="lane-bg" data-lane="${li}" style="cursor:pointer" onclick="toggleWorkflowCollapse('${esc(lane.workflowName)}')"/>`;
    svg += `<text x="8" y="${7}" class="lane-label wf-toggle" onclick="toggleWorkflowCollapse('${esc(lane.workflowName)}')">${esc(lane.name)}</text>`;
    const meta = `${lane.subLaneCount} agents · ${lane.subTurnCount}t · ${(lane.phases || []).join(' → ')}`;
    svg += `<text x="8" y="${spY + 10}" class="lane-label-dim">${esc(meta)}</text>`;
  } else {
    svg += `<rect x="0" y="0" width="${W}" height="${LANE_H - LANE_GAP}" fill="transparent" class="lane-bg" data-lane="${li}" style="cursor:pointer"/>`;
    const prefix = isSel ? '▶ ' : '';
    const starMark = isStarred ? ' ★' : '';
    let namePrefix = prefix;
    if (workflowMeta && !collapsedWorkflows.has(workflowMeta.name) && lane.name !== 'main' && lanes.length > 2) {
      namePrefix = li === 1 ? '▾ ' + prefix : '  ' + prefix;
    }
    svg += `<text x="8" y="${7}" class="lane-label">${esc(namePrefix + lane.name + starMark)}</text>`;
    svg += `<text x="8" y="${spY + 10}" class="lane-label-dim">${esc(shortModel(lane.model))}  ${Math.round((lane.ctxWindow || 0) / 1000)}K</text>`;
  }

  for (const t of lane.turns) {
    const tend = t.receivedAt + (t.elapsed || 0);
    if (tend < viewT0 || t.receivedAt > viewT1) continue;
    const tx = Math.max(LABEL_WIDTH, x(t.receivedAt));
    const tw = Math.max(MIN_TURN_PX, x(tend) - tx);
    const tc = t.failed ? FAIL_COLOR : modelColor(t.model);
    const isTSel = selectedTurnId === t.id;
    svg += `<rect x="${tx}" y="${trY}" width="${tw}" height="${TURN_ROW_H}" fill="${tc}" opacity="${isTSel ? 1 : 0.85}"${isTSel ? ` stroke="${TEXT}" stroke-width="1"` : ''} data-turn-id="${t.id}" data-lane="${li}" class="turn-bar" style="cursor:pointer"/>`;
    if (starredTurns.has(t.id)) svg += `<text x="${tx + tw/2}" y="${trY - 1}" fill="#d29922" font-size="6" text-anchor="middle">▲</text>`;
  }

  const vis = lane.turns.filter(t => t.receivedAt >= viewT0 - tRange * 0.05 && t.receivedAt <= viewT1 + tRange * 0.05);
  if (vis.length > 1) {
    const pts = vis.map(t => ({ x: Math.max(LABEL_WIDTH, Math.min(W - 12, x(t.receivedAt))), y: spY + SPARKLINE_H - (t.contextPercent / 100) * SPARKLINE_H }));
    let d = `M${pts[0].x},${spY + SPARKLINE_H}`;
    for (const p of pts) d += ` L${p.x},${p.y}`;
    d += ` L${pts[pts.length - 1].x},${spY + SPARKLINE_H} Z`;
    svg += `<path d="${d}" fill="${color}" opacity="0.15"/>`;
    let ld = `M${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) ld += ` L${pts[i].x},${pts[i].y}`;
    svg += `<path d="${ld}" fill="none" stroke="${color}" stroke-width="0.8" opacity="0.6"/>`;
  } else if (vis.length === 1) {
    svg += `<circle cx="${x(vis[0].receivedAt)}" cy="${spY + SPARKLINE_H - (vis[0].contextPercent / 100) * SPARKLINE_H}" r="1.5" fill="${color}" opacity="0.6"/>`;
  }
  return svg;
}

function renderTimeline() {
  if (!lanes.length) { $mainSvg.innerHTML = ''; $svg.innerHTML = ''; return; }
  const visLanes = getVisibleLanes();
  const W = $mainSvg.parentElement.parentElement.clientWidth;
  const chartW = W - LABEL_WIDTH - 12;
  const tRange = viewT1 - viewT0 || 1;
  const x = t => LABEL_WIDTH + ((t - viewT0) / tRange) * chartW;
  const isZoomed = viewT0 > sessionTimeMin + 100 || viewT1 < sessionTimeMax - 100;
  $zoomLabel.textContent = isZoomed ? `${fmtMin(viewT0, sessionTimeMin)} – ${fmtMin(viewT1, sessionTimeMin)}` : '';

  // Main SVG: time axis + main lane (sticky)
  const mainH = PAD_TOP + AXIS_H + LANE_H;
  $mainSvg.setAttribute('width', W); $mainSvg.setAttribute('height', mainH);
  $mainSvg.setAttribute('viewBox', `0 0 ${W} ${mainH}`);
  let mainSvg = '';
  const nTicks = Math.max(2, Math.min(12, Math.ceil(tRange / 1000 / 5)));
  const tickStep = tRange / nTicks;
  for (let i = 0; i <= nTicks; i++) {
    const t = viewT0 + i * tickStep;
    mainSvg += `<text x="${x(t)}" y="${PAD_TOP + 12}" class="time-axis" text-anchor="middle">${fmtMin(t, sessionTimeMin)}</text>`;
  }
  const mainLaneY = PAD_TOP + AXIS_H;
  mainSvg += `<g transform="translate(0,${mainLaneY})">${renderLaneSvg(visLanes[0], 0, W, chartW, x, tRange, visLanes)}</g>`;
  $mainSvg.innerHTML = mainSvg;

  // Sub SVG: remaining lanes (scrollable)
  const subLanes = visLanes.slice(1);
  if (subLanes.length) {
    const subH = subLanes.length * LANE_H + PAD_BOT;
    $svg.setAttribute('width', W); $svg.setAttribute('height', subH);
    $svg.setAttribute('viewBox', `0 0 ${W} ${subH}`);
    let subSvg = '';
    const spawnLines = [];
    for (let si = 0; si < subLanes.length; si++) {
      const lane = subLanes[si];
      const li = si + 1; // global lane index
      subSvg += `<g transform="translate(0,${si * LANE_H})">${renderLaneSvg(lane, li, W, chartW, x, tRange, visLanes)}</g>`;
      if (lane.spawnParent && !lane.isCollapsedWorkflow) {
        const pt = visLanes[0].turns.find(t => t.turnIndex === lane.spawnParent.parentTurnIdx);
        if (pt && lane.turns.length) spawnLines.push({ x1: x(pt.receivedAt), y1: 0, x2: x(lane.turns[0].receivedAt), y2: si * LANE_H });
      }
    }
    for (const c of spawnLines) subSvg += `<line x1="${c.x1}" y1="${c.y1}" x2="${c.x2}" y2="${c.y2}" class="spawn-line"/>`;
    $svg.innerHTML = subSvg;
    $svg.style.display = '';
  } else {
    $svg.innerHTML = '';
    $svg.style.display = 'none';
  }

  setupInteractions(W, chartW, tRange, visLanes);
  renderMinimap();
}

// ── Overview bar (full-width, dynamic sizing) ─────────────────────────────
function renderMinimap() {
  if (!lanes.length) return;
  const MW = $minimap.clientWidth, MH = $minimap.clientHeight;
  if (!MW || !MH) return;
  const totalRange = sessionTimeMax - sessionTimeMin || 1;
  $minimap.width = MW * 2; $minimap.height = MH * 2;
  const ctx = $minimap.getContext('2d'); ctx.scale(2, 2);
  const x = t => ((t - sessionTimeMin) / totalRange) * MW;
  ctx.fillStyle = '#161b22'; ctx.fillRect(0, 0, MW, MH);
  const barH = Math.max(2, Math.min(6, (MH - 4) / lanes.length - 1));
  const laneStep = barH + 1;
  const startY = Math.max(1, (MH - lanes.length * laneStep) / 2);
  for (let li = 0; li < lanes.length; li++) {
    const ly = startY + li * laneStep, color = modelColor(lanes[li].model);
    const isSel = selectedLane?.name === lanes[li].name;
    for (const t of lanes[li].turns) {
      ctx.fillStyle = color; ctx.globalAlpha = isSel ? 0.9 : 0.5;
      ctx.fillRect(x(t.receivedAt), ly, Math.max(0.5, (t.elapsed / totalRange) * MW), barH);
    }
  }
  ctx.globalAlpha = 1;
  // Scale labels: 0, mid, end
  ctx.font = '8px SF Mono,Menlo,monospace'; ctx.fillStyle = '#484f58'; ctx.globalAlpha = 0.7;
  ctx.fillText('0', 2, MH - 2);
  const endLabel = fmtDur(totalRange);
  ctx.fillText(endLabel, MW - ctx.measureText(endLabel).width - 2, MH - 2);
  if (MW > 200) { const midLabel = fmtDur(totalRange / 2); ctx.fillText(midLabel, MW / 2 - ctx.measureText(midLabel).width / 2, MH - 2); }
  ctx.globalAlpha = 1;
  const isZoomed = viewT0 > sessionTimeMin + 100 || viewT1 < sessionTimeMax - 100;
  if (isZoomed) {
    const vx = x(viewT0), vw = Math.max(2, x(viewT1) - vx);
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, 0, vx, MH); ctx.fillRect(vx + vw, 0, MW - vx - vw, MH);
    ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 1.5; ctx.strokeRect(vx + 0.5, 0.5, vw, MH - 1);
    // Viewport duration label — right-bottom with background pill
    const vpLabel = fmtDur(viewT1 - viewT0);
    ctx.font = '8px SF Mono,Menlo,monospace';
    const lw = ctx.measureText(vpLabel).width;
    const lx = vx + vw - lw - 1, ly = MH - 10;
    ctx.fillStyle = '#58a6ff'; ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.roundRect(lx - 3, ly - 1, lw + 6, 11, 2); ctx.fill();
    ctx.fillStyle = '#0d1117'; ctx.globalAlpha = 1;
    ctx.fillText(vpLabel, lx, ly + 8);
    ctx.globalAlpha = 1;
  }
  // ponytail: 3 modes — brush-to-zoom (not zoomed), edge resize (on edges), pan (middle)
  const EDGE_PX = 6;
  $minimap.style.cursor = isZoomed ? 'grab' : 'crosshair';
  $minimap.onmousemove = isZoomed ? (e) => {
    const rect = $minimap.getBoundingClientRect();
    const vx = x(viewT0), vw = x(viewT1) - vx;
    const mx = (e.clientX - rect.left) / rect.width * MW;
    if (Math.abs(mx - vx) < EDGE_PX || Math.abs(mx - (vx + vw)) < EDGE_PX) $minimap.style.cursor = 'col-resize';
    else if (mx > vx && mx < vx + vw) $minimap.style.cursor = 'grab';
    else $minimap.style.cursor = 'crosshair';
  } : null;

  $minimap.onmousedown = (e) => {
    e.stopPropagation();
    const rect = $minimap.getBoundingClientRect();
    const pxToTime = (cx) => sessionTimeMin + ((cx - rect.left) / rect.width) * totalRange;
    const clickTime = pxToTime(e.clientX);

    if (isZoomed) {
      const vx = x(viewT0), vw = x(viewT1) - vx;
      const mx = (e.clientX - rect.left) / rect.width * MW;
      const onLeft = Math.abs(mx - vx) < EDGE_PX;
      const onRight = Math.abs(mx - (vx + vw)) < EDGE_PX;

      if (onLeft || onRight) {
        // Edge resize: drag left or right boundary
        document.body.classList.add('dragging');
        const onMove = (ev) => {
          const t = Math.max(sessionTimeMin, Math.min(sessionTimeMax, pxToTime(ev.clientX)));
          if (onLeft) { viewT0 = Math.min(t, viewT1 - 2000); }
          else { viewT1 = Math.max(t, viewT0 + 2000); }
          renderTimeline();
        };
        const onUp = () => { document.body.classList.remove('dragging'); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
        window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
        return;
      }
      if (mx > vx && mx < vx + vw) {
        // Pan: drag viewport middle
        const span = viewT1 - viewT0, mmStartX = e.clientX, mmStartT0 = viewT0;
        document.body.classList.add('dragging');
        const onMove = (ev) => {
          const dt = ((ev.clientX - mmStartX) / rect.width) * totalRange;
          let t0 = mmStartT0 + dt, t1 = mmStartT0 + dt + span;
          if (t0 < sessionTimeMin) { t0 = sessionTimeMin; t1 = sessionTimeMin + span; }
          if (t1 > sessionTimeMax) { t1 = sessionTimeMax; t0 = sessionTimeMax - span; }
          viewT0 = t0; viewT1 = t1; renderTimeline();
        };
        const onUp = () => { document.body.classList.remove('dragging'); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
        window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
        return;
      }
    }

    // Brush-to-zoom: drag to select range (works when not zoomed, or clicking outside viewport)
    const brushStart = clickTime;
    let brushEnd = brushStart;
    document.body.classList.add('dragging');
    $minimap.style.cursor = 'crosshair';
    const onMove = (ev) => {
      brushEnd = Math.max(sessionTimeMin, Math.min(sessionTimeMax, pxToTime(ev.clientX)));
      // Preview: draw brush selection
      const bx0 = x(Math.min(brushStart, brushEnd)), bx1 = x(Math.max(brushStart, brushEnd));
      renderMinimap(); // redraw base (leaves 2x scale on ctx)
      const c2 = $minimap.getContext('2d');
      c2.fillStyle = 'rgba(88, 166, 255, 0.15)';
      c2.fillRect(bx0, 0, bx1 - bx0, MH);
      c2.strokeStyle = '#58a6ff'; c2.lineWidth = 1;
      c2.strokeRect(bx0 + 0.5, 0.5, bx1 - bx0 - 1, MH - 1);
    };
    const onUp = () => {
      document.body.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
      const t0 = Math.min(brushStart, brushEnd), t1 = Math.max(brushStart, brushEnd);
      if (t1 - t0 > 1000) { viewT0 = t0; viewT1 = t1; }
      renderTimeline();
    };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
  };
}

function zoomBy(factor) {
  const mid = (viewT0 + viewT1) / 2, span = viewT1 - viewT0, ns = span * factor;
  if (ns >= (sessionTimeMax - sessionTimeMin) * 1.1) { viewT0 = sessionTimeMin; viewT1 = sessionTimeMax; }
  else if (ns < 2000) return;
  else { viewT0 = Math.max(sessionTimeMin, mid - ns / 2); viewT1 = Math.min(sessionTimeMax, mid + ns / 2); }
  renderTimeline();
}
document.getElementById('zoom-in-btn').onclick = () => zoomBy(0.5);
document.getElementById('zoom-out-btn').onclick = () => zoomBy(2);
document.getElementById('zoom-reset-btn').onclick = () => { viewT0 = sessionTimeMin; viewT1 = sessionTimeMax; renderTimeline(); };

// ── Interactions ──────────────────────────────────────────────────────────
function setupInteractions(W, chartW, tRange, visibleLanes) {
  const vLanes = visibleLanes || lanes;
  function pxToTime(px) { return viewT0 + ((px - LABEL_WIDTH) / chartW) * (viewT1 - viewT0); }

  // Shared handlers applied to both main-svg and macro-svg
  function attachSvgHandlers(svgEl) {
    svgEl.onmousedown = (e) => {
      const r = svgEl.getBoundingClientRect(), mx = e.clientX - r.left;
      if (mx < LABEL_WIDTH) {
        const target = document.elementFromPoint(e.clientX, e.clientY);
        if (target?.classList?.contains('lane-bg')) {
          const li = parseInt(target.getAttribute('data-lane'));
          const curLanes = getVisibleLanes();
          if (li >= 0 && li < curLanes.length) {
            if (curLanes[li].isCollapsedWorkflow) { toggleWorkflowCollapse(curLanes[li].workflowName); return; }
            selectedLane = curLanes[li]; selectedTurnId = null; renderTimeline(); renderAgentCard(); renderSteps();
          }
        }
        return;
      }
      const startX = e.clientX, startY = e.clientY, startT0 = viewT0, startT1 = viewT1;
      const startScroll = document.getElementById('timeline-section').scrollTop;
      const cW = chartW;
      let moved = false;
      document.body.classList.add('dragging');
      const onMove = (ev) => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
        const span = startT1 - startT0, dt = -(dx / cW) * span;
        let t0 = startT0 + dt, t1 = startT1 + dt;
        if (t0 < sessionTimeMin) { t0 = sessionTimeMin; t1 = sessionTimeMin + span; }
        if (t1 > sessionTimeMax) { t1 = sessionTimeMax; t0 = sessionTimeMax - span; }
        viewT0 = t0; viewT1 = t1;
        document.getElementById('timeline-section').scrollTop = startScroll - dy;
        renderTimeline(); syncStepsHighlight();
      };
      const onUp = (ev) => {
        document.body.classList.remove('dragging');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (moved) return;
        const target = document.elementFromPoint(ev.clientX, ev.clientY);
        if (target?.classList?.contains('turn-bar')) {
          const tid = target.getAttribute('data-turn-id'), lane = findLane(tid);
          if (lane) { selectedLane = lane; selectedTurnId = tid; renderTimeline(); renderAgentCard(); renderSteps(tid); }
        } else if (target?.classList?.contains('lane-bg')) {
          const li = parseInt(target.getAttribute('data-lane'));
          const curLanes = getVisibleLanes();
          if (li >= 0 && li < curLanes.length && curLanes[li]) {
            if (curLanes[li].isCollapsedWorkflow) { toggleWorkflowCollapse(curLanes[li].workflowName); return; }
            selectedLane = curLanes[li]; selectedTurnId = null; renderTimeline(); renderAgentCard(); renderSteps();
          }
        }
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };
    svgEl.onmousemove = (e) => {
      if (document.body.classList.contains('dragging')) return;
      const target = e.target;
      if (target.classList.contains('turn-bar')) {
        showTooltip(e, findTurn(target.getAttribute('data-turn-id'))); svgEl.style.cursor = 'pointer';
      } else {
        $tooltip.style.display = 'none';
        svgEl.style.cursor = (e.clientX - svgEl.getBoundingClientRect().left) >= LABEL_WIDTH ? 'grab' : 'pointer';
      }
    };
    svgEl.onmouseleave = () => { $tooltip.style.display = 'none'; };
    svgEl.ondblclick = () => { viewT0 = sessionTimeMin; viewT1 = sessionTimeMax; renderTimeline(); syncStepsToView(); };
    svgEl.onwheel = (e) => {
      const r = svgEl.getBoundingClientRect(), mx = e.clientX - r.left;
      if (mx < LABEL_WIDTH) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const cursor = pxToTime(mx), factor = e.deltaY > 0 ? 1.3 : 0.7, span = viewT1 - viewT0, ratio = (cursor - viewT0) / span, ns = span * factor;
        if (ns >= (sessionTimeMax - sessionTimeMin) * 1.1) { viewT0 = sessionTimeMin; viewT1 = sessionTimeMax; }
        else if (ns < 2000) return;
        else { viewT0 = Math.max(sessionTimeMin, cursor - ns * ratio); viewT1 = Math.min(sessionTimeMax, cursor + ns * (1 - ratio)); }
        renderTimeline(); syncStepsToView();
        return;
      }
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const span = viewT1 - viewT0, dt = (e.deltaX / chartW) * span;
        let t0 = viewT0 + dt, t1 = viewT1 + dt;
        if (t0 < sessionTimeMin) { t0 = sessionTimeMin; t1 = t0 + span; }
        if (t1 > sessionTimeMax) { t1 = sessionTimeMax; t0 = t1 - span; }
        viewT0 = t0; viewT1 = t1;
        renderTimeline(); syncStepsHighlight();
        return;
      }
    };
  }
  attachSvgHandlers($mainSvg);
  attachSvgHandlers($svg);
}

function showTooltip(e, t) {
  if (!t) return;
  const tools = t.toolCalls && Object.keys(t.toolCalls).length ? Object.entries(t.toolCalls).map(([k, v]) => `${k}${v > 1 ? '×' + v : ''}`).join(', ') : 'none';
  $tooltip.innerHTML = [`<b>turn ${t.turnIndex}</b>`, `model: ${shortModel(t.model)}`,
    `context: ${t.contextPercent.toFixed(1)}%  (${Math.round(t.contextUsed / 1000)}K / ${Math.round(t.contextWindow / 1000)}K)`,
    `elapsed: ${fmtDur(t.elapsed)}`, `tools: ${tools}`,
    t.agentSpawns?.length ? `spawns: ${t.agentSpawns.map(s => s.name || s.subagent_type).join(', ')}` : ''
  ].filter(Boolean).join('\n');
  $tooltip.style.display = 'block';
  const tx = e.clientX + 12, ty = e.clientY + 12;
  $tooltip.style.left = (tx + $tooltip.offsetWidth > window.innerWidth ? tx - $tooltip.offsetWidth - 24 : tx) + 'px';
  $tooltip.style.top = (ty + $tooltip.offsetHeight > window.innerHeight ? ty - $tooltip.offsetHeight - 24 : ty) + 'px';
}

// ── Agent Card ────────────────────────────────────────────────────────────
function renderAgentCard() {
  if (!selectedLane) { $agentCardHeader.innerHTML = ''; $agentCardBody.innerHTML = ''; return; }
  const lane = selectedLane, turns = lane.turns, color = modelColor(lane.model);
  const totalDur = turns.length ? turns[turns.length - 1].receivedAt + (turns[turns.length - 1].elapsed || 0) - turns[0].receivedAt : 0;
  const totalSpawns = turns.reduce((s, t) => s + (t.agentSpawns?.length || 0), 0);
  // ponytail: normalize to lane's window so model switches don't distort %
  const laneWin = lane.ctxWindow || (turns.length ? turns[0].contextWindow : 1) || 1;
  const peakCtx = Math.max(...turns.map(t => (t.contextUsed / laneWin) * 100));
  const lastCtx = turns.length ? (turns[turns.length - 1].contextUsed / laneWin) * 100 : 0;
  const typeLabel = lane.spawnParent ? lane.spawnParent.type || 'subagent' : 'orchestrator';
  const isStarred = starredAgents.has(lane.name);

  document.getElementById('agent-card').style.borderLeft = `2px solid ${color}`;
  $agentCardHeader.innerHTML = `
    <span class="ac-star" onclick="toggleAgentStar('${esc(lane.name)}')">${isStarred ? '★' : '☆'}</span>
    <div class="ac-name">${esc(lane.name)} <span class="ac-model" style="background:${color}22;color:${color}">${shortModel(lane.model)}</span></div>
    <div class="ac-meta">${turns.length} turns · ${fmtDur(totalDur)} · ${typeLabel}</div>`;

  const toolTotals = {};
  let totalIn = 0, totalCacheR = 0, totalOut = 0;
  for (const t of turns) {
    for (const [k, v] of Object.entries(t.toolCalls || {})) toolTotals[k] = (toolTotals[k] || 0) + v;
    totalIn += t.usage?.input_tokens || 0;
    totalCacheR += t.usage?.cache_read_input_tokens || 0;
    totalOut += t.usage?.output_tokens || 0;
  }
  const topTools = Object.entries(toolTotals).sort((a, b) => b[1] - a[1]).slice(0, 6);

  const perTurnCache = turns.map(t => {
    const u = t.usage || {};
    const tot = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    return tot > 0 ? ((u.cache_read_input_tokens || 0) / tot) * 100 : 0;
  });
  const avgCache = perTurnCache.length ? perTurnCache.reduce((a, b) => a + b, 0) / perTurnCache.length : 0;
  const perTurnCost = turns.map(t => {
    const u = t.usage || {};
    return ((u.input_tokens || 0) * 3 + (u.cache_read_input_tokens || 0) * 0.3 + (u.cache_creation_input_tokens || 0) * 3.75 + (u.output_tokens || 0) * 15) / 1e6;
  });
  const totalCost = perTurnCost.reduce((a, b) => a + b, 0);
  const peakWarn = peakCtx >= 83.5 ? ' <span class="ac-warn">⚠ compacted</span>' : '';

  lane._perTurnCache = perTurnCache;
  lane._perTurnCost = perTurnCost;

  $agentCardBody.innerHTML = `
    <div class="ac-section">
      <div class="ac-label">context</div>
      <div class="ac-value">${lastCtx.toFixed(1)}% <span class="ac-dim">(${Math.round((turns[turns.length - 1]?.contextUsed || 0) / 1000)}K / ${Math.round((lane.ctxWindow || 0) / 1000)}K)</span></div>
      <div class="ac-dim">peak ${peakCtx.toFixed(1)}%${peakWarn}</div>
      <canvas class="minimap-canvas" id="ctx-minimap"></canvas>
    </div>
    <div class="ac-section">
      <div class="ac-label">cache</div>
      <div class="ac-dim">${avgCache.toFixed(1)}% hit</div>
      <canvas class="sparkline-inline" id="cache-spark"></canvas>
    </div>
    <div class="ac-section">
      <div class="ac-label">cost</div>
      <div class="ac-dim">$${totalCost.toFixed(3)} <span class="ac-dim">avg $${(turns.length ? totalCost / turns.length : 0).toFixed(4)}/turn</span></div>
      <canvas class="sparkline-inline" id="cost-spark"></canvas>
    </div>
    <div class="ac-section">
      <div class="ac-nav-item" style="border-top:1px solid #1c2128"><span><span class="ac-nav-dot" style="background:#d29922"></span>Timeline</span> <span><span class="ac-nav-badge">${turns.length} steps</span> <span class="ac-nav-chevron">›</span></span></div>
    </div>
    <div class="ac-section">
      <div class="ac-label">context</div>
      <div class="ac-nav-item"><span><span class="ac-nav-dot" style="background:#58a6ff"></span>System</span> <span><span class="ac-nav-badge">tok</span> <span class="ac-nav-chevron">›</span></span></div>
      <div class="ac-nav-item"><span><span class="ac-nav-dot" style="background:#3fb950"></span>Core</span> <span><span class="ac-nav-badge">tools</span> <span class="ac-nav-chevron">›</span></span></div>
      <div class="ac-nav-item"><span><span class="ac-nav-dot" style="background:#3fb950"></span>MCP</span> <span><span class="ac-nav-badge">tools</span> <span class="ac-nav-chevron">›</span></span></div>
      <div class="ac-nav-item"><span><span class="ac-nav-dot" style="background:#d2a8ff"></span>Skills</span> <span class="ac-nav-chevron">›</span></div>
    </div>
    <div class="ac-section">
      <div class="ac-label">analysis</div>
      <div class="ac-nav-item"><span>💰 Cost Efficiency</span> <span class="ac-nav-chevron">›</span></div>
    </div>
    <div class="ac-section">
      <div class="ac-label">raw</div>
      <div class="ac-nav-item"><span>Request</span> <span class="ac-nav-chevron">›</span></div>
      <div class="ac-nav-item"><span>Events</span> <span class="ac-nav-chevron">›</span></div>
    </div>
    <div class="ac-section">
      <div class="ac-label">tools</div>
      ${topTools.map(([n, c]) => `<div class="ac-dim">${esc(n)} <span class="ac-value">${c}</span></div>`).join('')}
    </div>
    <div class="ac-section">
      <div class="ac-label">tokens</div>
      <div class="ac-dim">input <span class="ac-value">${Math.round(totalIn / 1000)}K</span></div>
      <div class="ac-dim">cache <span class="ac-value">${Math.round(totalCacheR / 1000)}K</span></div>
      <div class="ac-dim">output <span class="ac-value">${Math.round(totalOut / 1000)}K</span></div>
    </div>
    ${totalSpawns ? `<div class="ac-section"><div class="ac-label">spawns</div><div class="ac-value">${totalSpawns}</div></div>` : ''}
    ${lane.name !== 'main' ? '<button class="ac-back-btn" onclick="selectMain()">← main</button>' : ''}`;

  requestAnimationFrame(() => drawAllSummaryCharts(lane));
}

// ── Timeline Steps ────────────────────────────────────────────────────────
function renderSteps(scrollTo) {
  if (!selectedLane) {
    $stepsHeader.innerHTML = ''; $stepsList.innerHTML = '<div class="agent-empty">select a lane</div>';
    return;
  }
  const lane = selectedLane, turns = lane.turns, color = modelColor(lane.model);
  $stepsHeader.innerHTML = `<span>TIMELINE</span> · <span class="sh-agent" style="color:${color}">● ${esc(lane.name)}</span> · ${turns.length} steps`;

  // ponytail: per-turn cache rate for coloring ctx%
  const perTurnCache = lane._perTurnCache || turns.map(t => {
    const u = t.usage || {};
    const tot = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    return tot > 0 ? ((u.cache_read_input_tokens || 0) / tot) * 100 : 0;
  });

  let html = '';
  for (let idx = 0; idx < turns.length; idx++) {
    const t = turns[idx];
    // Idle separator: gap > 5 min between turns
    if (idx > 0) {
      const idle = t.receivedAt - (turns[idx - 1].receivedAt + (turns[idx - 1].elapsed || 0));
      if (idle > IDLE_THRESHOLD) {
        html += `<div class="step-idle-sep" title="${fmtDur(idle)} idle">`;
        html += `<span class="step-idle-line"></span>`;
        html += `<span class="step-idle-label">⏸ ${fmtDur(idle)}</span>`;
        html += `<span class="step-idle-line"></span>`;
        html += `</div>`;
      }
    }
    const isSel = selectedTurnId === t.id;
    const tools = Object.entries(t.toolCalls || {});
    const spawns = t.agentSpawns || [];
    const isStarred = starredTurns.has(t.id);
    const cacheRate = perTurnCache[idx] || 0;
    const ctxColor = cacheRate >= 50 ? '#8b949e' : '#d29922';
    const mc = modelColor(t.model);

    // Turn header row (always shown)
    html += `<div class="step-row${isSel ? ' selected' : ''}" id="step-${t.id}" data-tid="${t.id}">`;
    html += `<span class="step-star${isStarred ? ' starred' : ''}" onclick="event.stopPropagation();toggleTurnStar('${t.id}')">${isStarred ? '★' : '☆'}</span>`;
    html += `<span class="step-num">#${t.turnIndex}</span>`;
    html += `<span class="step-type"><span class="step-type-badge" style="color:${mc};border-color:${mc}44">${shortModel(t.model)}</span></span>`;
    html += `<span class="step-content">`;

    if (!tools.length && !spawns.length) {
      // Thinking / text only turn
      html += `<span class="tool-result">🧠 thinking${t.elapsed > 5000 ? ' ' + fmtDur(t.elapsed) : ''}</span>`;
    } else {
      // Tool group with brackets (matches production ccxray style)
      const allCalls = [...tools.map(([n, c]) => ({name: n, count: c, type: 'tool'})), ...spawns.map(s => ({name: 'Agent', count: 1, type: 'spawn', label: s.name || s.subagent_type}))];
      const multi = allCalls.length > 1;
      html += `<span class="step-tools">`;
      for (let ci = 0; ci < allCalls.length; ci++) {
        const c = allCalls[ci];
        const bracket = multi ? (ci === 0 ? '┌' : ci === allCalls.length - 1 ? '└' : '│') : '';
        html += `<span class="step-tool-line">`;
        if (bracket) html += `<span class="step-bracket">${bracket}</span>`;
        if (c.type === 'spawn') {
          html += `<span class="spawn-badge">⑂ ${esc(c.label)}</span>`;
        } else {
          html += `<span class="tool-name">${esc(c.name)}</span>`;
          if (c.count > 1) html += `<span class="tool-count">×${c.count}</span>`;
        }
        html += `</span>`;
      }
      html += `</span>`;
    }
    html += `</span>`;
    html += `<span class="step-ctx" style="color:${ctxColor}">${t.contextPercent.toFixed(1)}%</span>`;
    html += `<span class="step-duration">${fmtDur(t.elapsed)}</span>`;
    html += `</div>`;
  }
  $stepsList.innerHTML = html;

  $stepsList.querySelectorAll('.step-row').forEach(row => {
    row.onclick = () => {
      const tid = row.getAttribute('data-tid');
      selectedTurnId = tid; renderTimeline(); renderAgentCard(); renderSteps(tid);
    };
  });

  if (scrollTo) {
    const el = document.getElementById('step-' + scrollTo);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Sync: highlight steps in the visible time range
  syncStepsHighlight();

  // Steps scroll → update minimap indicator
  const stepsContainer = document.getElementById('timeline-steps');
  if (stepsContainer) {
    stepsContainer.onscroll = debounce(() => updateMinimapFromSteps(), 100);
  }
}

function syncStepsToView() {
  // Called after timeline zoom/pan — scroll steps to first visible turn
  if (!selectedLane) return;
  const turns = selectedLane.turns;
  const firstVisible = turns.find(t => t.receivedAt >= viewT0 && t.receivedAt <= viewT1);
  if (firstVisible) {
    const el = document.getElementById('step-' + firstVisible.id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  syncStepsHighlight();
}

function syncStepsHighlight() {
  // Add/remove .in-view class on step rows based on timeline's visible time range
  if (!selectedLane) return;
  const isZoomed = viewT0 > sessionTimeMin + 100 || viewT1 < sessionTimeMax - 100;
  document.querySelectorAll('.step-row').forEach(row => {
    const tid = row.getAttribute('data-tid');
    const turn = findTurn(tid);
    if (!turn) { row.classList.remove('in-view'); return; }
    const inRange = isZoomed && turn.receivedAt >= viewT0 && turn.receivedAt <= viewT1;
    row.classList.toggle('in-view', inRange);
  });
}

function updateMinimapFromSteps() {
  // Find which turns are currently visible in the steps scroll viewport
  const container = document.getElementById('timeline-steps');
  if (!container || !selectedLane) return;
  const rect = container.getBoundingClientRect();
  const rows = container.querySelectorAll('.step-row');
  let firstVisibleTurn = null, lastVisibleTurn = null;
  for (const row of rows) {
    const rr = row.getBoundingClientRect();
    if (rr.bottom > rect.top && rr.top < rect.bottom) {
      const tid = row.getAttribute('data-tid');
      const turn = findTurn(tid);
      if (turn) {
        if (!firstVisibleTurn) firstVisibleTurn = turn;
        lastVisibleTurn = turn;
      }
    }
  }
  // Update minimap with steps viewport indicator
  if (firstVisibleTurn && lastVisibleTurn && selectedLane.turns.length > 1) {
    selectedLane._stepsViewRange = {
      startIdx: selectedLane.turns.indexOf(firstVisibleTurn),
      endIdx: selectedLane.turns.indexOf(lastVisibleTurn),
    };
    requestAnimationFrame(() => drawAllSummaryCharts(selectedLane));
  }
}

let _debounceTimers = {};
function debounce(fn, ms) {
  const key = fn.toString().slice(0, 50);
  return () => { clearTimeout(_debounceTimers[key]); _debounceTimers[key] = setTimeout(fn, ms); };
}

// ── Star toggles ──────────────────────────────────────────────────────────
window.toggleTurnStar = function(tid) {
  if (starredTurns.has(tid)) starredTurns.delete(tid); else starredTurns.add(tid);
  renderTimeline(); renderSteps(selectedTurnId);
};
window.toggleAgentStar = function(name) {
  if (starredAgents.has(name)) starredAgents.delete(name); else starredAgents.add(name);
  renderTimeline(); renderAgentCard();
};

// ── Summary charts (context minimap + cache + cost sparklines) ────────────
// ponytail: X = turn-index (dense) + idle gap markers for cache-drop visibility
const IDLE_THRESHOLD = 5 * 60 * 1000; // 5 min — matches Anthropic prompt cache TTL
const GAP_PX = 6;

function computeChartLayout(turns, canvasW) {
  const gaps = [];
  for (let i = 0; i < turns.length - 1; i++) {
    const idle = turns[i + 1].receivedAt - (turns[i].receivedAt + (turns[i].elapsed || 0));
    if (idle > IDLE_THRESHOLD) gaps.push({ after: i, dur: idle });
  }
  const usableW = canvasW - gaps.length * GAP_PX;
  const bw = Math.max(0.5, usableW / turns.length);
  const pos = []; // {x} per turn
  const gapPos = []; // {x, dur} per gap
  let cx = 0, gi = 0;
  for (let i = 0; i < turns.length; i++) {
    pos.push(cx);
    cx += bw;
    if (gi < gaps.length && gaps[gi].after === i) {
      gapPos.push({ x: cx, dur: gaps[gi].dur });
      cx += GAP_PX;
      gi++;
    }
  }
  return { pos, gapPos, bw };
}

function drawAllSummaryCharts(lane) {
  const turns = lane.turns;
  if (!turns.length) return;
  const cacheData = lane._perTurnCache || [], costData = lane._perTurnCost || [];
  const selIdx = selectedTurnId ? turns.findIndex(t => t.id === selectedTurnId) : -1;

  // Shared helpers using layout
  function attachClick(canvas, layout) {
    canvas.onclick = (e) => {
      const rect = canvas.getBoundingClientRect(), cx = (e.clientX - rect.left) / rect.width * canvas.clientWidth;
      let best = 0, bestD = Infinity;
      for (let i = 0; i < turns.length; i++) {
        const d = Math.abs(layout.pos[i] + layout.bw / 2 - cx);
        if (d < bestD) { bestD = d; best = i; }
      }
      selectedTurnId = turns[best].id; renderTimeline(); renderAgentCard(); renderSteps(turns[best].id);
    };
  }
  function drawCursor(c, layout, h, idx) {
    if (idx < 0 || !layout.pos[idx]) return;
    const cx = layout.pos[idx] + layout.bw / 2;
    c.beginPath(); c.moveTo(cx, 0); c.lineTo(cx, h);
    c.strokeStyle = '#58a6ff'; c.lineWidth = 1; c.stroke();
  }
  function drawGaps(c, layout, h) {
    for (const g of layout.gapPos) {
      c.fillStyle = '#d29922'; c.globalAlpha = 0.3;
      c.fillRect(g.x, 0, GAP_PX, h);
      c.setLineDash([2, 2]);
      c.strokeStyle = '#d29922'; c.lineWidth = 0.5; c.globalAlpha = 0.6;
      c.beginPath(); c.moveTo(g.x + GAP_PX / 2, 0); c.lineTo(g.x + GAP_PX / 2, h); c.stroke();
      c.setLineDash([]);
      c.globalAlpha = 1;
    }
  }
  function drawStepsViewRange(c, layout, h) {
    const vr = lane._stepsViewRange;
    if (!vr || vr.startIdx < 0 || !layout.pos[vr.startIdx]) return;
    const x1 = layout.pos[vr.startIdx], x2 = layout.pos[vr.endIdx] + layout.bw;
    c.fillStyle = 'rgba(88, 166, 255, 0.06)';
    c.fillRect(x1, 0, Math.max(2, x2 - x1), h);
    c.strokeStyle = 'rgba(88, 166, 255, 0.3)';
    c.lineWidth = 0.5;
    c.strokeRect(x1, 0, Math.max(2, x2 - x1), h);
  }

  // Context bar chart with 3 zones
  const ctxCanvas = document.getElementById('ctx-minimap');
  if (ctxCanvas) {
    const w = ctxCanvas.clientWidth, h = ctxCanvas.clientHeight;
    if (w && h) {
      const layout = computeChartLayout(turns, w);
      ctxCanvas.width = w * 2; ctxCanvas.height = h * 2;
      const c = ctxCanvas.getContext('2d'); c.scale(2, 2);
      c.fillStyle = '#21262d'; c.fillRect(0, 0, w, h);
      const y40 = h - (40 / 100) * h, y83 = h - (83.5 / 100) * h;
      c.fillStyle = 'rgba(63, 185, 80, 0.06)'; c.fillRect(0, y40, w, h - y40);
      c.fillStyle = 'rgba(210, 153, 34, 0.06)'; c.fillRect(0, y83, w, y40 - y83);
      c.fillStyle = 'rgba(248, 81, 73, 0.06)'; c.fillRect(0, 0, w, y83);
      [{y:y40,color:'#3fb950',label:'40%'},{y:y83,color:'#f85149',label:'83.5%'}].forEach(th => {
        c.beginPath(); c.setLineDash([3,2]); c.moveTo(0, th.y); c.lineTo(w, th.y);
        c.strokeStyle = th.color; c.lineWidth = 0.5; c.globalAlpha = 0.5; c.stroke();
        c.setLineDash([]); c.globalAlpha = 0.4; c.font = '7px SF Mono,Menlo,monospace'; c.fillStyle = th.color;
        c.fillText(th.label, w - c.measureText(th.label).width - 1, th.y - 1); c.globalAlpha = 1;
      });
      const laneWin = lane.ctxWindow || turns[0].contextWindow || 1;
      for (let i = 0; i < turns.length; i++) {
        const pct = (turns[i].contextUsed / laneWin) * 100;
        const bh = Math.max(0.5, (pct / 100) * h);
        c.fillStyle = pct <= 40 ? '#3fb950' : pct <= 83.5 ? '#d29922' : '#f85149';
        c.globalAlpha = 0.8;
        c.fillRect(layout.pos[i], h - bh, Math.max(0.5, layout.bw), bh);
      }
      c.globalAlpha = 1;
      drawGaps(c, layout, h); drawStepsViewRange(c, layout, h); drawCursor(c, layout, h, selIdx); attachClick(ctxCanvas, layout);
    }
  }
  const cacheCanvas = document.getElementById('cache-spark');
  if (cacheCanvas && cacheData.length) {
    const w = cacheCanvas.clientWidth, h = cacheCanvas.clientHeight;
    if (w && h) {
      const layout = computeChartLayout(turns, w);
      cacheCanvas.width = w * 2; cacheCanvas.height = h * 2;
      const c = cacheCanvas.getContext('2d'); c.scale(2, 2);
      for (let i = 0; i < cacheData.length; i++) {
        c.fillStyle = cacheData[i] < 50 ? '#d29922' : '#3fb950'; c.globalAlpha = 0.7;
        const bh = Math.max(0.5, (cacheData[i] / 100) * (h - 1));
        c.fillRect(layout.pos[i], h - bh, Math.max(0.5, layout.bw), bh);
      }
      c.globalAlpha = 1;
      drawGaps(c, layout, h); drawStepsViewRange(c, layout, h); drawCursor(c, layout, h, selIdx); attachClick(cacheCanvas, layout);
    }
  }
  const costCanvas = document.getElementById('cost-spark');
  if (costCanvas && costData.length) {
    const w = costCanvas.clientWidth, h = costCanvas.clientHeight;
    if (w && h) {
      const layout = computeChartLayout(turns, w);
      costCanvas.width = w * 2; costCanvas.height = h * 2;
      const c = costCanvas.getContext('2d'); c.scale(2, 2);
      const maxCost = Math.max(...costData) || 1;
      for (let i = 0; i < costData.length; i++) {
        c.fillStyle = '#ffa657'; c.globalAlpha = 0.7;
        const bh = Math.max(0.5, (costData[i] / maxCost) * (h - 1));
        c.fillRect(layout.pos[i], h - bh, Math.max(0.5, layout.bw), bh);
      }
      c.globalAlpha = 1;
      drawGaps(c, layout, h); drawStepsViewRange(c, layout, h); drawCursor(c, layout, h, selIdx); attachClick(costCanvas, layout);
    }
  }
}

window.selectMain = () => { selectedLane = lanes[0] || null; selectedTurnId = null; renderTimeline(); renderAgentCard(); renderSteps(); };
window.addEventListener('resize', () => renderTimeline());

// ── Resize handle: drag to adjust timeline vs detail split ───────────────
(function() {
  const handle = document.getElementById('resize-handle');
  const section = document.getElementById('timeline-section');
  if (!handle || !section) return;
  // ponytail: min = main lane visible (header ~50px), max = leave 150px for detail
  const MIN_H = 60, MIN_DETAIL = 150;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY, startH = section.offsetHeight;
    document.body.classList.add('dragging');
    const onMove = (ev) => {
      const dy = ev.clientY - startY;
      const maxH = window.innerHeight - section.getBoundingClientRect().top - MIN_DETAIL;
      const newH = Math.max(MIN_H, Math.min(maxH, startH + dy));
      section.style.maxHeight = newH + 'px';
    };
    const onUp = () => {
      document.body.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
})();
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const isZoomed = viewT0 > sessionTimeMin + 100 || viewT1 < sessionTimeMax - 100;
    if (isZoomed) { viewT0 = sessionTimeMin; viewT1 = sessionTimeMax; renderTimeline(); }
    else window.selectMain();
  }
  if (!selectedLane) return;
  const turns = selectedLane.turns;
  const curIdx = selectedTurnId ? turns.findIndex(t => t.id === selectedTurnId) : -1;
  if (e.key === 'ArrowDown' || e.key === 'j') {
    e.preventDefault(); const next = Math.min(turns.length - 1, curIdx + 1);
    selectedTurnId = turns[next].id; renderTimeline(); renderAgentCard(); renderSteps(selectedTurnId);
  }
  if (e.key === 'ArrowUp' || e.key === 'k') {
    e.preventDefault(); const prev = Math.max(0, curIdx - 1);
    selectedTurnId = turns[prev].id; renderTimeline(); renderAgentCard(); renderSteps(selectedTurnId);
  }
  if (e.key === 'f') {
    if (selectedTurnId) { toggleTurnStar(selectedTurnId); }
  }
  if (e.key === 'n') {
    const starred = turns.filter(t => starredTurns.has(t.id));
    if (starred.length) {
      const after = starred.find(t => turns.indexOf(t) > curIdx) || starred[0];
      selectedTurnId = after.id; renderTimeline(); renderAgentCard(); renderSteps(selectedTurnId);
    }
  }
});
