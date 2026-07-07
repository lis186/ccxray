// Context Heatmap Swimlane — Prototype C for ccxray #91
// Zero dependencies. Pure SVG + DOM.

const LANE_HEIGHT = 56;
const LANE_PAD = 4;
const BAR_HEIGHT = 32;
const SPARKLINE_HEIGHT = 8;
const HEADER_HEIGHT = 30; // time axis
const MIN_BAR_W = 28;

const COLORS = [
  { max: 20, color: '#1a365d', label: 'cool' },
  { max: 40, color: '#0d4f4f', label: 'cool' },
  { max: 60, color: '#4a5d23', label: 'warm' },
  { max: 80, color: '#7c4a1a', label: 'warm' },
  { max: 101, color: '#7c1a1a', label: 'hot' },
];

function heatColor(pct) {
  for (const c of COLORS) if (pct < c.max) return c.color;
  return COLORS[COLORS.length - 1].color;
}

function heatClass(pct) {
  if (pct < 40) return 'cool';
  if (pct < 70) return 'warm';
  return 'hot';
}

function shortModel(m) {
  return m.replace('claude-', '').replace(/-/g, ' ');
}

function modelChipClass(m) {
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return '';
}

function fmtTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function fmtDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60);
  return m + 'm ' + Math.round(s % 60) + 's';
}

function fmtCtxWindow(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(0) + 'M';
  return (n / 1000).toFixed(0) + 'K';
}

// --- Agent assignment ---
// Group turns into agents (lanes). Uses cache fingerprinting and context
// clustering to separate orchestrator turns from subagent turns.
//
// Key signals:
// 1. "Fresh cache" pattern: cache_read ≈ 0 with large cache_creation → new agent
// 2. Very low context (<15K) with zero cache → fork subagent
// 3. Distinct cache_read baseline cluster → different agent context
// 4. Different model + low context → likely subagent

function assignAgents(session) {
  const turns = session.turns.slice().sort((a, b) => a.receivedAt - b.receivedAt);
  if (!turns.length) return [];

  // Collect all spawn events
  const allSpawns = [];
  for (const t of turns) {
    for (const s of (t.agentSpawns || [])) {
      allSpawns.push({ spawn: s, parentTurn: t });
    }
  }

  // Find orchestrator baseline: turns that spawn agents are definitively orchestrator.
  // Their cache_read values define the orchestrator's cache fingerprint.
  const orchCandidates = turns.filter(t => (t.agentSpawns || []).length > 0);
  const orchCacheReads = orchCandidates.map(t => t.usage.cache_read_input_tokens).filter(v => v > 0);
  // Also include turns with high cache_read (>80K) as likely orchestrator
  const highCacheTurns = turns.filter(t => t.usage.cache_read_input_tokens > 80000);
  for (const t of highCacheTurns) {
    if (!orchCacheReads.includes(t.usage.cache_read_input_tokens)) {
      orchCacheReads.push(t.usage.cache_read_input_tokens);
    }
  }

  // Build cache fingerprint clusters
  // Orchestrator turns share similar cache_read values (within 30% of each other)
  const orchBaselines = orchCacheReads.length > 0 ? orchCacheReads : [0];
  const maxOrchCache = Math.max(...orchBaselines);

  function isSubagent(t) {
    const u = t.usage;
    const freshCache = u.cache_read_input_tokens === 0 && u.cache_creation_input_tokens > 5000;
    const veryLowCtx = t.contextUsed < 15000 && u.cache_read_input_tokens === 0;
    // Half-cache pattern: cache_read is roughly half of orchestrator's,
    // indicating a fork with different cache prefix
    const halfCache = maxOrchCache > 0 && u.cache_read_input_tokens > 0
      && u.cache_read_input_tokens < maxOrchCache * 0.6
      && u.cache_creation_input_tokens > u.cache_read_input_tokens * 0.8;
    // Different model with low context
    const diffModelLow = orchCandidates.length > 0
      && t.model !== orchCandidates[0].model
      && t.contextUsed < 50000;

    return freshCache || veryLowCtx || halfCache || diffModelLow;
  }

  // Assign turns: orchestrator vs subagent
  const classified = [];
  const subagentTurns = []; // collect for later grouping

  for (const t of turns) {
    if (isSubagent(t) && allSpawns.length > 0) {
      subagentTurns.push(t);
    } else {
      classified.push({
        turn: t,
        agentKey: 'orchestrator',
        agentName: 'Orchestrator',
        agentType: 'orchestrator',
      });
    }
  }

  // Match subagent turns to spawn events by timing + context similarity
  // Group subagent turns by their cache_read or cache_creation fingerprint
  for (const t of subagentTurns) {
    let bestSpawn = null;
    let bestScore = -Infinity;

    for (const { spawn, parentTurn } of allSpawns) {
      const timeDist = t.receivedAt - parentTurn.receivedAt;
      if (timeDist < -5000) continue; // started before spawn (unlikely)
      if (timeDist > 600000) continue; // too far after

      // Score: prefer closest in time, penalize very distant
      let score = 1000 - Math.min(timeDist / 1000, 1000);

      // Bonus: if there are other subagent turns already matched to this spawn
      // with similar cache fingerprint, boost
      if (score > bestScore) {
        bestScore = score;
        bestSpawn = spawn;
      }
    }

    if (bestSpawn) {
      const key = bestSpawn.name || bestSpawn.description;
      classified.push({
        turn: t,
        agentKey: 'sub:' + key,
        agentName: bestSpawn.name || bestSpawn.description,
        agentType: bestSpawn.subagent_type || 'default',
      });
    } else {
      // No matching spawn — treat as orchestrator
      classified.push({
        turn: t,
        agentKey: 'orchestrator',
        agentName: 'Orchestrator',
        agentType: 'orchestrator',
      });
    }
  }

  // Build agent objects
  const agents = new Map();
  for (const c of classified) {
    if (!agents.has(c.agentKey)) {
      agents.set(c.agentKey, {
        key: c.agentKey,
        name: c.agentName,
        type: c.agentType,
        model: c.turn.model,
        ctxWindow: c.turn.contextWindow,
        turns: [],
        peakPct: 0,
      });
    }
    const agent = agents.get(c.agentKey);
    agent.turns.push(c.turn);
    agent.peakPct = Math.max(agent.peakPct, c.turn.contextPercent);
  }

  // Sort: orchestrator first, then by first turn time
  const result = Array.from(agents.values());
  result.sort((a, b) => {
    if (a.key === 'orchestrator') return -1;
    if (b.key === 'orchestrator') return 1;
    return a.turns[0].receivedAt - b.turns[0].receivedAt;
  });

  return result;
}

// --- Spawn connectors ---
function findSpawnConnectors(agents, session) {
  const connectors = [];
  const turns = session.turns;

  for (const t of turns) {
    if (!t.agentSpawns || t.agentSpawns.length === 0) continue;
    // Find which agent lane the parent turn is in
    let parentAgent = null;
    for (const a of agents) {
      if (a.turns.some(at => at.id === t.id)) { parentAgent = a; break; }
    }
    if (!parentAgent) continue;

    for (const spawn of t.agentSpawns) {
      const spawnKey = 'sub:' + (spawn.name || spawn.description);
      const childAgent = agents.find(a => a.key === spawnKey);
      if (childAgent) {
        connectors.push({
          parentAgent,
          childAgent,
          parentTurn: t,
          spawnName: spawn.name || spawn.description,
          spawnType: spawn.subagent_type || 'default',
        });
      }
    }
  }
  return connectors;
}

// --- Render ---
let fixtureData = null;
let currentSession = null;

async function init() {
  try {
    const resp = await fetch('../../prototype-fixture.json');
    fixtureData = await resp.json();
  } catch (e) {
    document.getElementById('svgArea').innerHTML =
      '<div class="empty-state">Failed to load fixture data. Ensure prototype-fixture.json exists at repo root.</div>';
    return;
  }

  const picker = document.getElementById('sessionPicker');
  fixtureData.sessions.forEach((s, i) => {
    const btn = document.createElement('button');
    btn.className = 'session-tab' + (i === 0 ? ' active' : '');
    btn.textContent = s.label;
    btn.title = s.description;
    btn.onclick = () => selectSession(i);
    picker.appendChild(btn);
  });

  selectSession(0);
}

function selectSession(idx) {
  currentSession = fixtureData.sessions[idx];
  document.querySelectorAll('.session-tab').forEach((b, i) => {
    b.classList.toggle('active', i === idx);
  });
  render();
}

function render() {
  const session = currentSession;
  if (!session) return;

  const agents = assignAgents(session);
  const connectors = findSpawnConnectors(agents, session);

  renderSummary(session, agents);
  renderLaneHeaders(agents);
  renderSVG(agents, connectors, session);
}

function renderSummary(session, agents) {
  const bar = document.getElementById('summaryBar');
  const allTurns = session.turns;
  const peakPct = Math.max(...allTurns.map(t => t.contextPercent));
  const minT = Math.min(...allTurns.map(t => t.receivedAt));
  const maxT = Math.max(...allTurns.map(t => t.receivedAt + t.elapsed));
  const duration = maxT - minT;
  const models = [...new Set(allTurns.map(t => t.model))];
  const subagentCount = agents.filter(a => a.key !== 'orchestrator').length;

  bar.innerHTML = `
    <div class="summary-item">
      <span class="tt-label">Agents:</span>
      <span class="value">${subagentCount + 1}</span>
    </div>
    <div class="summary-item">
      <span class="tt-label">Peak context:</span>
      <span class="value ${heatClass(peakPct)}">${peakPct.toFixed(1)}%</span>
    </div>
    <div class="summary-item">
      <span class="tt-label">Duration:</span>
      <span class="value">${fmtDuration(duration)}</span>
    </div>
    <div class="summary-item">
      <span class="tt-label">Models:</span>
      ${models.map(m => `<span class="model-chip ${modelChipClass(m)}">${shortModel(m)}</span>`).join(' ')}
    </div>
  `;
}

function renderLaneHeaders(agents) {
  const container = document.getElementById('laneHeaders');
  // Time axis header placeholder
  let html = `<div class="lane-header" style="height:${HEADER_HEIGHT}px;border-bottom:1px solid #30363d;">
    <span class="agent-meta" style="font-size:10px;">Time axis</span>
  </div>`;

  for (const agent of agents) {
    const peakColor = heatColor(agent.peakPct);
    const peakLabel = agent.peakPct.toFixed(1) + '%';
    html += `<div class="lane-header" style="height:${LANE_HEIGHT}px;">
      <div class="agent-name">
        ${agent.name}
        <span class="type-badge ${agent.type}">${agent.type}</span>
      </div>
      <div class="agent-meta">
        <span class="model-chip ${modelChipClass(agent.model)}">${shortModel(agent.model)}</span>
        <span>${fmtCtxWindow(agent.ctxWindow)} ctx</span>
        <span class="peak-badge" style="background:${peakColor}33;color:${peakColor}">Peak ${peakLabel}</span>
      </div>
    </div>`;
  }
  container.innerHTML = html;
}

function renderSVG(agents, connectors, session) {
  const area = document.getElementById('svgArea');
  const allTurns = session.turns;
  const minT = Math.min(...allTurns.map(t => t.receivedAt));
  const maxT = Math.max(...allTurns.map(t => t.receivedAt + t.elapsed));
  const span = Math.max(maxT - minT, 1000);

  // SVG width: scale to content. More turns or longer sessions = wider.
  const turnCount = allTurns.length;
  const svgWidth = Math.max(900, Math.min(3600, turnCount * 56 + 100));
  const svgHeight = HEADER_HEIGHT + agents.length * LANE_HEIGHT;

  const xScale = (t) => ((t - minT) / span) * (svgWidth - 40) + 20;
  const barW = (elapsed) => Math.max(MIN_BAR_W, (elapsed / span) * (svgWidth - 40));

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" style="display:block;">`;
  svg += `<defs>
    <filter id="glow"><feGaussianBlur stdDeviation="2" result="g"/><feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>`;

  // --- Time axis ---
  svg += renderTimeAxis(minT, maxT, svgWidth, HEADER_HEIGHT, xScale);

  // --- Lane backgrounds ---
  agents.forEach((agent, i) => {
    const y = HEADER_HEIGHT + i * LANE_HEIGHT;
    const bg = i % 2 === 0 ? '#161b22' : '#1c2128';
    svg += `<rect x="0" y="${y}" width="${svgWidth}" height="${LANE_HEIGHT}" fill="${bg}"/>`;
    // Lane separator
    svg += `<line x1="0" y1="${y + LANE_HEIGHT}" x2="${svgWidth}" y2="${y + LANE_HEIGHT}" stroke="#21262d" stroke-width="1"/>`;
  });

  // --- Spawn connectors (behind bars) ---
  for (const conn of connectors) {
    const parentIdx = agents.indexOf(conn.parentAgent);
    const childIdx = agents.indexOf(conn.childAgent);
    if (parentIdx < 0 || childIdx < 0) continue;

    const px = xScale(conn.parentTurn.receivedAt + conn.parentTurn.elapsed / 2);
    const py = HEADER_HEIGHT + parentIdx * LANE_HEIGHT + LANE_HEIGHT / 2;
    const childFirstTurn = conn.childAgent.turns[0];
    const cx = xScale(childFirstTurn.receivedAt);
    const cy = HEADER_HEIGHT + childIdx * LANE_HEIGHT + LANE_HEIGHT / 2;

    const midX = (px + cx) / 2;
    const isDashed = conn.spawnType === 'fork' ? '' : 'stroke-dasharray="4 3"';
    svg += `<path d="M${px},${py} C${midX},${py} ${midX},${cy} ${cx},${cy}"
      fill="none" stroke="#58a6ff44" stroke-width="1.5" ${isDashed}/>`;
    // Small dot at child end
    svg += `<circle cx="${cx}" cy="${cy}" r="2.5" fill="#58a6ff66"/>`;
  }

  // --- Turn bars + sparklines ---
  agents.forEach((agent, laneIdx) => {
    const laneY = HEADER_HEIGHT + laneIdx * LANE_HEIGHT;
    const barY = laneY + LANE_PAD;
    const sparkY = laneY + LANE_PAD + BAR_HEIGHT + 2;

    // Sort turns by time
    const sorted = agent.turns.slice().sort((a, b) => a.receivedAt - b.receivedAt);

    // Compute bar positions with overlap avoidance (needed before sparkline)
    const barPositions = [];
    let rightEdge = -Infinity;
    sorted.forEach((t, i) => {
      let x = xScale(t.receivedAt);
      const w = Math.max(MIN_BAR_W, barW(t.elapsed));
      // Push right if overlapping previous bar
      if (x < rightEdge + 2) x = rightEdge + 2;
      rightEdge = x + w;
      barPositions.push({ x, w });
    });

    // Sparkline path (uses bar center positions for visual alignment)
    if (sorted.length > 1) {
      let sparkPath = '';
      sorted.forEach((t, i) => {
        const cx = barPositions[i].x + barPositions[i].w / 2;
        const pct = Math.min(t.contextPercent, 100);
        const sy = sparkY + SPARKLINE_HEIGHT - (pct / 100) * SPARKLINE_HEIGHT;
        sparkPath += (i === 0 ? 'M' : 'L') + cx.toFixed(1) + ',' + sy.toFixed(1);
      });
      svg += `<path d="${sparkPath}" fill="none" stroke="#8b949e55" stroke-width="1.5"/>`;
      sorted.forEach((t, i) => {
        const cx = barPositions[i].x + barPositions[i].w / 2;
        const pct = Math.min(t.contextPercent, 100);
        const sy = sparkY + SPARKLINE_HEIGHT - (pct / 100) * SPARKLINE_HEIGHT;
        svg += `<circle cx="${cx.toFixed(1)}" cy="${sy.toFixed(1)}" r="1.5" fill="${heatColor(pct)}"/>`;
      });
    }

    // Bars
    sorted.forEach((t, i) => {
      const { x, w } = barPositions[i];
      const color = heatColor(t.contextPercent);
      const rx = 4;

      // Compaction marker: context drops >30% from previous turn in same lane
      let compaction = false;
      if (i > 0) {
        const prevPct = sorted[i - 1].contextPercent;
        if (prevPct - t.contextPercent > 30) compaction = true;
      }

      // Bar
      svg += `<rect class="turn-bar" x="${x.toFixed(1)}" y="${barY}" width="${w.toFixed(1)}" height="${BAR_HEIGHT}"
        rx="${rx}" fill="${color}" stroke="${color}" stroke-width="0.5" opacity="0.85"
        data-turn-id="${t.id}" style="cursor:pointer"/>`;

      // Model badge (tiny, top-right)
      const modelLabel = shortModel(t.model).split(' ').map(w => w[0]).join('');
      svg += `<text x="${(x + w - 3).toFixed(1)}" y="${barY + 10}" fill="#e6edf380" font-size="8"
        text-anchor="end" font-family="monospace" pointer-events="none">${modelLabel}</text>`;

      // Context % in center
      svg += `<text x="${(x + w / 2).toFixed(1)}" y="${barY + BAR_HEIGHT / 2 + 1}" fill="#e6edf3cc"
        font-size="10" text-anchor="middle" dominant-baseline="middle" font-weight="600"
        pointer-events="none">${t.contextPercent.toFixed(1)}%</text>`;

      // Tool chips (bottom of bar)
      const tools = Object.keys(t.toolCalls || {});
      if (tools.length > 0 && w > 36) {
        const toolStr = tools.map(k => {
          const n = t.toolCalls[k];
          const short = k.length > 6 ? k.slice(0, 5) : k;
          return n > 1 ? short + '×' + n : short;
        }).join(' ');
        svg += `<text x="${(x + w / 2).toFixed(1)}" y="${barY + BAR_HEIGHT - 4}" fill="#8b949e99"
          font-size="7" text-anchor="middle" pointer-events="none">${escXml(toolStr)}</text>`;
      }

      // Compaction marker
      if (compaction) {
        svg += `<text x="${(x + 2).toFixed(1)}" y="${barY + 10}" fill="#d29922" font-size="11"
          pointer-events="none">&#x27F2;</text>`;
      }

      // Spawn indicator (agent icon)
      if ((t.agentSpawns || []).length > 0) {
        const count = t.agentSpawns.length;
        svg += `<text x="${(x + 3).toFixed(1)}" y="${barY + BAR_HEIGHT - 4}" fill="#58a6ffcc"
          font-size="9" pointer-events="none">${count}&#xD7;spawn</text>`;
      }
    });
  });

  svg += '</svg>';
  area.innerHTML = svg;

  // Attach hover events
  area.querySelectorAll('.turn-bar').forEach(el => {
    el.addEventListener('mouseenter', onTurnHover);
    el.addEventListener('mousemove', onTurnMove);
    el.addEventListener('mouseleave', onTurnLeave);
  });
}

function renderTimeAxis(minT, maxT, width, height, xScale) {
  let svg = '';
  const span = maxT - minT;
  // Pick tick interval
  let interval;
  if (span < 30000) interval = 5000;
  else if (span < 120000) interval = 15000;
  else if (span < 600000) interval = 60000;
  else interval = 300000;

  const firstTick = Math.ceil(minT / interval) * interval;
  for (let t = firstTick; t <= maxT; t += interval) {
    const x = xScale(t);
    const d = new Date(t);
    const label = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    svg += `<line x1="${x}" y1="${height - 2}" x2="${x}" y2="${height}" stroke="#30363d" stroke-width="1"/>`;
    svg += `<text x="${x}" y="${height - 6}" fill="#8b949e" font-size="9" text-anchor="middle">${label}</text>`;
  }
  // Axis line
  svg += `<line x1="20" y1="${height - 1}" x2="${width - 20}" y2="${height - 1}" stroke="#30363d" stroke-width="1"/>`;
  return svg;
}

function escXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Tooltip ---
function findTurnById(id) {
  if (!currentSession) return null;
  return currentSession.turns.find(t => t.id === id) || null;
}

function onTurnHover(e) {
  const id = e.target.getAttribute('data-turn-id');
  const turn = findTurnById(id);
  if (!turn) return;
  showTooltip(turn, e);
}

function onTurnMove(e) {
  positionTooltip(e);
}

function onTurnLeave() {
  document.getElementById('tooltip').style.display = 'none';
}

function showTooltip(t, e) {
  const tt = document.getElementById('tooltip');
  const u = t.usage;
  tt.innerHTML = `
    <div class="tt-row"><span class="tt-label">Turn</span><span class="tt-value">#${t.turnIndex}</span></div>
    <div class="tt-row"><span class="tt-label">Model</span><span class="tt-value">${shortModel(t.model)}</span></div>
    <div class="tt-row"><span class="tt-label">Context window</span><span class="tt-value">${fmtCtxWindow(t.contextWindow)}</span></div>
    <div class="tt-row"><span class="tt-label">Context used</span><span class="tt-value" style="color:${heatColor(t.contextPercent)}">${fmtTokens(t.contextUsed)} (${t.contextPercent.toFixed(1)}%)</span></div>
    <div class="tt-divider"></div>
    <div class="tt-row"><span class="tt-label">Input tokens</span><span class="tt-value">${fmtTokens(u.input_tokens)}</span></div>
    <div class="tt-row"><span class="tt-label">Cache read</span><span class="tt-value">${fmtTokens(u.cache_read_input_tokens)}</span></div>
    <div class="tt-row"><span class="tt-label">Cache creation</span><span class="tt-value">${fmtTokens(u.cache_creation_input_tokens)}</span></div>
    <div class="tt-row"><span class="tt-label">Output tokens</span><span class="tt-value">${fmtTokens(u.output_tokens)}</span></div>
    <div class="tt-divider"></div>
    <div class="tt-row"><span class="tt-label">Elapsed</span><span class="tt-value">${fmtDuration(t.elapsed)}</span></div>
    <div class="tt-row"><span class="tt-label">Tools</span><span class="tt-value">${Object.keys(t.toolCalls || {}).length > 0 ? Object.entries(t.toolCalls).map(([k,v]) => k + (v > 1 ? ' x' + v : '')).join(', ') : 'none'}</span></div>
    ${(t.agentSpawns || []).length > 0 ? `<div class="tt-divider"></div><div class="tt-row"><span class="tt-label">Spawns</span><span class="tt-value">${t.agentSpawns.map(s => (s.name || '(anon)') + ' [' + (s.subagent_type || 'default') + ']').join(', ')}</span></div>` : ''}
  `;
  tt.style.display = 'block';
  positionTooltip(e);
}

function positionTooltip(e) {
  const tt = document.getElementById('tooltip');
  const pad = 12;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  const rect = tt.getBoundingClientRect();
  if (x + rect.width > window.innerWidth - pad) x = e.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - pad) y = e.clientY - rect.height - pad;
  tt.style.left = x + 'px';
  tt.style.top = y + 'px';
}

init();
