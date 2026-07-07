/* ──────────────────────────────────────────────────────────
   ccxray Git Graph  — zero-dep SVG-based agent workflow viz
   ────────────────────────────────────────────────────────── */

// ── Constants ──
const LANE_COLORS = [
  '#58a6ff', // orchestrator — blue
  '#db6d28', // orange
  '#bc8cff', // purple
  '#f778ba', // pink
  '#d29922', // yellow
  '#3fb950', // green
  '#39d353', // cyan
  '#f85149', // red
  '#79c0ff', // light blue
  '#a5d6ff', // pale blue
];

const MODEL_CLASSES = {
  'claude-opus-4-8':   'opus-4-8',
  'claude-opus-4-6':   'opus-4-6',
  'claude-sonnet-4-6': 'sonnet-4-6',
  'claude-haiku-4-5':  'haiku-4-5',
};

const ROW_HEIGHT = 48;
const NODE_RADIUS = 6;
const LANE_WIDTH = 28;
const LANE_LEFT_PAD = 24;
const CURVE_RADIUS = 14;

// ── State ──
let fixtureData = null;
let currentSession = null;

// ── DOM refs ──
const sessionSelect = document.getElementById('sessionSelect');
const sessionDesc   = document.getElementById('sessionDesc');
const graphContainer = document.getElementById('graphContainer');
const legendBar      = document.getElementById('legendBar');
const tooltipEl      = document.getElementById('tooltip');

// ── Helpers ──
function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function fmtDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60_000) return (ms / 1000).toFixed(1) + 's';
  const m = Math.floor(ms / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(0);
  return m + 'm ' + s + 's';
}

function fmtContextWindow(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(0) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

function shortModel(m) {
  return m.replace('claude-', '');
}

function contextBarColor(pct) {
  if (pct > 80) return '#f85149';
  if (pct > 50) return '#d29922';
  return '#3fb950';
}

// ── Lane assignment (subagent inference) ──
function buildLanes(session) {
  const turns = session.turns;
  // Orchestrator = lane 0
  // Detect spawn events and assign lanes to spawned agents
  const lanes = []; // [{name, color, type, spawnTurnIdx, mergeTurnIdx}]
  const turnLaneMap = []; // turnIndex -> laneIndex

  // Lane 0 = orchestrator
  lanes.push({
    name: 'orchestrator',
    color: LANE_COLORS[0],
    type: 'orchestrator',
    contextWindow: null,
  });

  // Track active spawned agent names and their lane indices
  const activeAgents = new Map(); // name -> laneIndex
  // Track which turns are subagent turns based on spawn context drops
  const spawnEvents = []; // {turnIdx, names[], spawnTurnIndex}

  // First pass: find all spawn events
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.agentSpawns.length > 0) {
      const names = t.agentSpawns.map(s => s.name || s.description.slice(0, 20));
      spawnEvents.push({
        turnArrayIdx: i,
        turnIndex: t.turnIndex,
        names,
        spawns: t.agentSpawns,
        receivedAt: t.receivedAt,
      });
    }
  }

  // Second pass: assign lanes
  // Heuristic: after a spawn, any turn with:
  //   1. context dramatically lower than orchestrator baseline (< 15K when orch > 100K)
  //   2. OR receivedAt very close to spawn event time
  //   3. is NOT from the orchestrator's growing context chain
  // is a subagent turn.

  // Find orchestrator context baseline (max context among early turns before spawns)
  let orchBaseline = 0;
  const firstSpawnIdx = spawnEvents.length > 0 ? spawnEvents[0].turnArrayIdx : turns.length;
  for (let i = 0; i < firstSpawnIdx; i++) {
    orchBaseline = Math.max(orchBaseline, turns[i].contextUsed);
  }
  // Also track orchestrator context as it grows
  let orchContextTracker = orchBaseline;

  // Assign lane for each spawn name
  let nextLaneIdx = 1;
  const nameLaneMap = new Map();

  for (const se of spawnEvents) {
    for (let j = 0; j < se.names.length; j++) {
      const name = se.names[j];
      if (!nameLaneMap.has(name)) {
        const colorIdx = nextLaneIdx % LANE_COLORS.length;
        lanes.push({
          name,
          color: LANE_COLORS[colorIdx],
          type: se.spawns[j].subagent_type || 'default',
          contextWindow: null,
          spawnTurnArrayIdx: se.turnArrayIdx,
        });
        nameLaneMap.set(name, nextLaneIdx);
        nextLaneIdx++;
      }
    }
  }

  // Third pass: classify each turn
  // Strategy: Build temporal groups. After a spawn event, subsequent turns
  // that have low context are likely subagent turns. We need to assign them
  // to specific spawned agents.
  //
  // Approach: sort post-spawn turns by receivedAt. Match them to spawn agents
  // based on order and context level.

  const result = []; // {turn, laneIdx, isSpawnPoint, isMergePoint, spawnedLanes[]}

  // Group post-spawn turns into "subagent clusters" by analyzing context drops
  // A turn is a subagent if its contextUsed is much less than orchestrator tracker
  // AND it appears after a spawn

  // Build a set of spawn event timestamps for matching
  const spawnTimeToEvent = new Map();
  for (const se of spawnEvents) {
    spawnTimeToEvent.set(se.receivedAt, se);
  }

  // Track which spawn agents have been "used" (assigned turns)
  const agentTurnCounts = new Map(); // name -> count
  // Track active spawn windows
  let activeSpawns = []; // [{names, receivedAt, baseline}]

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const isSpawnTurn = t.agentSpawns.length > 0;

    // Check if this turn is a subagent
    let assignedLane = 0; // default: orchestrator

    if (!isSpawnTurn) {
      // Check if this looks like a subagent turn
      // Subagent signature: low context relative to orchestrator
      const isLowContext = t.contextUsed < orchContextTracker * 0.5 && orchContextTracker > 50000;

      if (isLowContext && activeSpawns.length > 0) {
        // Find which spawn group this belongs to
        // Use receivedAt proximity and context level matching
        let bestMatch = null;
        let bestDist = Infinity;

        for (const sp of activeSpawns) {
          for (const name of sp.names) {
            const lane = nameLaneMap.get(name);
            const count = agentTurnCounts.get(name) || 0;
            // Prefer agents that haven't been assigned many turns yet
            const dist = Math.abs(t.receivedAt - sp.receivedAt) + count * 100000;
            if (dist < bestDist) {
              bestDist = dist;
              bestMatch = name;
            }
          }
        }

        if (bestMatch) {
          assignedLane = nameLaneMap.get(bestMatch);
          agentTurnCounts.set(bestMatch, (agentTurnCounts.get(bestMatch) || 0) + 1);
        }
      } else {
        // Orchestrator turn — update tracker
        orchContextTracker = Math.max(orchContextTracker, t.contextUsed);
      }
    } else {
      // Spawn turn is always orchestrator
      orchContextTracker = Math.max(orchContextTracker, t.contextUsed);
      // Register new spawn window
      activeSpawns.push({
        names: t.agentSpawns.map(s => s.name || s.description.slice(0, 20)),
        receivedAt: t.receivedAt,
        baseline: orchContextTracker,
      });
    }

    const spawnedLanes = isSpawnTurn
      ? t.agentSpawns.map(s => nameLaneMap.get(s.name || s.description.slice(0, 20)))
      : [];

    result.push({
      turn: t,
      laneIdx: assignedLane,
      isSpawnPoint: isSpawnTurn,
      spawnedLanes,
    });
  }

  // Determine merge points: last turn in each subagent lane
  const lastTurnPerLane = new Map(); // laneIdx -> result array index
  for (let i = 0; i < result.length; i++) {
    if (result[i].laneIdx > 0) {
      lastTurnPerLane.set(result[i].laneIdx, i);
    }
  }

  // Find the orchestrator turn that comes after the last subagent turn in each group
  for (const [laneIdx, lastIdx] of lastTurnPerLane) {
    result[lastIdx].isMergePoint = true;
    // Find next orchestrator turn after this
    for (let j = lastIdx + 1; j < result.length; j++) {
      if (result[j].laneIdx === 0) {
        if (!result[j].mergeFromLanes) result[j].mergeFromLanes = [];
        result[j].mergeFromLanes.push(laneIdx);
        break;
      }
    }
  }

  return { lanes, rows: result, maxLanes: lanes.length };
}

// ── SVG graph rendering ──
function renderGraph(session) {
  const { lanes, rows, maxLanes } = buildLanes(session);
  const graphWidth = LANE_LEFT_PAD + maxLanes * LANE_WIDTH + 20;

  // Update CSS variable for graph column width
  document.documentElement.style.setProperty('--graph-col-width', graphWidth + 'px');

  // Render legend
  renderLegend(lanes);

  // Clear
  graphContainer.innerHTML = '';

  // Build SVG for graph lines
  const totalHeight = rows.length * ROW_HEIGHT;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', graphWidth);
  svg.setAttribute('height', totalHeight);
  svg.style.position = 'absolute';
  svg.style.left = '0';
  svg.style.top = '0';
  svg.style.pointerEvents = 'none';

  // Track which lanes are "active" at each row
  const laneActiveRanges = new Map(); // laneIdx -> {startRow, endRow}

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const lane = r.laneIdx;

    if (!laneActiveRanges.has(lane)) {
      laneActiveRanges.set(lane, { startRow: i, endRow: i });
    } else {
      laneActiveRanges.get(lane).endRow = i;
    }

    // Spawned lanes start at this row
    if (r.spawnedLanes) {
      for (const sl of r.spawnedLanes) {
        if (!laneActiveRanges.has(sl)) {
          laneActiveRanges.set(sl, { startRow: i, endRow: i });
        }
      }
    }
  }

  // Draw vertical lane lines
  for (const [laneIdx, range] of laneActiveRanges) {
    const lane = lanes[laneIdx];
    const x = laneX(laneIdx);
    const y1 = range.startRow * ROW_HEIGHT + ROW_HEIGHT / 2;
    const y2 = range.endRow * ROW_HEIGHT + ROW_HEIGHT / 2;

    if (y2 > y1) {
      const line = svgEl('line', {
        x1: x, y1, x2: x, y2,
        stroke: lane.color,
        'stroke-width': 2,
        'stroke-opacity': 0.5,
      });
      svg.appendChild(line);
    }
  }

  // Draw branch curves (spawn)
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.isSpawnPoint && r.spawnedLanes) {
      const fromX = laneX(r.laneIdx);
      const fromY = i * ROW_HEIGHT + ROW_HEIGHT / 2;

      for (const targetLane of r.spawnedLanes) {
        const toX = laneX(targetLane);
        const toY = (i + 1) * ROW_HEIGHT + ROW_HEIGHT / 2;

        // Find the first actual turn in the target lane
        let firstTargetRow = -1;
        for (let j = i + 1; j < rows.length; j++) {
          if (rows[j].laneIdx === targetLane) {
            firstTargetRow = j;
            break;
          }
        }

        if (firstTargetRow === -1) {
          // No turns found for this lane — draw a short stub
          const stubY = toY;
          const path = svgEl('path', {
            d: branchPath(fromX, fromY, toX, stubY),
            fill: 'none',
            stroke: lanes[targetLane].color,
            'stroke-width': 2,
            'stroke-opacity': 0.7,
          });
          svg.appendChild(path);
        } else {
          const actualToY = firstTargetRow * ROW_HEIGHT + ROW_HEIGHT / 2;
          const path = svgEl('path', {
            d: branchPath(fromX, fromY, toX, actualToY),
            fill: 'none',
            stroke: lanes[targetLane].color,
            'stroke-width': 2,
            'stroke-opacity': 0.7,
          });
          svg.appendChild(path);
        }
      }
    }
  }

  // Draw merge curves
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.mergeFromLanes) {
      const toX = laneX(r.laneIdx);
      const toY = i * ROW_HEIGHT + ROW_HEIGHT / 2;

      for (const fromLane of r.mergeFromLanes) {
        const fromX = laneX(fromLane);
        // Find the last turn in that lane
        let lastRow = i - 1;
        for (let j = i - 1; j >= 0; j--) {
          if (rows[j].laneIdx === fromLane) {
            lastRow = j;
            break;
          }
        }
        const fromY = lastRow * ROW_HEIGHT + ROW_HEIGHT / 2;

        const path = svgEl('path', {
          d: mergePath(fromX, fromY, toX, toY),
          fill: 'none',
          stroke: lanes[fromLane].color,
          'stroke-width': 2,
          'stroke-opacity': 0.7,
        });
        svg.appendChild(path);
      }
    }
  }

  // Draw nodes
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const lane = lanes[r.laneIdx];
    const cx = laneX(r.laneIdx);
    const cy = i * ROW_HEIGHT + ROW_HEIGHT / 2;

    // Outer glow for spawn points
    if (r.isSpawnPoint) {
      const glow = svgEl('circle', {
        cx, cy, r: NODE_RADIUS + 4,
        fill: 'none',
        stroke: lane.color,
        'stroke-width': 1.5,
        'stroke-opacity': 0.3,
      });
      svg.appendChild(glow);
    }

    // Node circle
    const node = svgEl('circle', {
      cx, cy, r: NODE_RADIUS,
      fill: r.isSpawnPoint ? lane.color : '#0d1117',
      stroke: lane.color,
      'stroke-width': 2,
    });
    svg.appendChild(node);

    // Merge indicator: small diamond on merge points
    if (r.isMergePoint) {
      const diamond = svgEl('polygon', {
        points: `${cx},${cy - 4} ${cx + 4},${cy} ${cx},${cy + 4} ${cx - 4},${cy}`,
        fill: lane.color,
        stroke: '#0d1117',
        'stroke-width': 1,
      });
      svg.appendChild(diamond);
    }

    // Turn number label
    const label = svgEl('text', {
      x: cx,
      y: cy - NODE_RADIUS - 5,
      fill: lane.color,
      'font-size': '9',
      'font-weight': '600',
      'text-anchor': 'middle',
      'font-family': '-apple-system, BlinkMacSystemFont, sans-serif',
    });
    label.textContent = '#' + r.turn.turnIndex;
    svg.appendChild(label);
  }

  // Create the rows container (wraps SVG + row divs)
  const rowsWrapper = document.createElement('div');
  rowsWrapper.style.position = 'relative';
  rowsWrapper.style.minHeight = totalHeight + 'px';

  // SVG goes into graph cell overlay
  const svgOverlay = document.createElement('div');
  svgOverlay.style.position = 'absolute';
  svgOverlay.style.left = '0';
  svgOverlay.style.top = '0';
  svgOverlay.style.width = graphWidth + 'px';
  svgOverlay.style.height = totalHeight + 'px';
  svgOverlay.style.pointerEvents = 'none';
  svgOverlay.style.zIndex = '2';
  svgOverlay.appendChild(svg);

  rowsWrapper.appendChild(svgOverlay);

  // Build row elements
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const t = r.turn;
    const lane = lanes[r.laneIdx];
    const row = document.createElement('div');
    row.className = 'graph-row';
    row.style.height = ROW_HEIGHT + 'px';

    // Graph cell (empty — SVG overlay handles it)
    const graphCell = document.createElement('div');
    graphCell.className = 'cell graph-cell';
    row.appendChild(graphCell);

    // Description cell
    const descCell = document.createElement('div');
    descCell.className = 'cell desc-cell';

    // Agent badge (if subagent)
    if (r.laneIdx > 0) {
      const badge = document.createElement('span');
      badge.className = 'agent-badge';
      badge.style.background = hexToRgba(lane.color, 0.12);
      badge.style.color = lane.color;
      badge.innerHTML = `<span class="dot" style="background:${lane.color}"></span>${lane.name}`;
      descCell.appendChild(badge);
    }

    // Tool chips
    const toolEntries = Object.entries(t.toolCalls || {});
    for (const [toolName, count] of toolEntries) {
      if (toolName === 'Agent') continue; // shown as spawn instead
      const chip = document.createElement('span');
      chip.className = 'tool-chip';
      chip.textContent = count > 1 ? `${toolName} x${count}` : toolName;
      descCell.appendChild(chip);
    }

    // Spawn chips
    if (r.isSpawnPoint) {
      for (const spawn of t.agentSpawns) {
        const chip = document.createElement('span');
        chip.className = 'tool-chip spawn';
        const name = spawn.name || spawn.description.slice(0, 20);
        chip.textContent = name;
        chip.title = spawn.description;
        descCell.appendChild(chip);
      }
    }

    // If no tools and no spawns, show a dim indicator
    if (toolEntries.length === 0 && !r.isSpawnPoint) {
      if (r.isMergePoint) {
        const chip = document.createElement('span');
        chip.className = 'tool-chip';
        chip.style.background = 'rgba(63,185,80,0.12)';
        chip.style.color = '#3fb950';
        chip.textContent = 'complete';
        descCell.appendChild(chip);
      } else {
        const dim = document.createElement('span');
        dim.style.color = '#8b949e';
        dim.style.fontSize = '12px';
        dim.textContent = 'response';
        descCell.appendChild(dim);
      }
    }

    row.appendChild(descCell);

    // Model cell
    const modelCell = document.createElement('div');
    modelCell.className = 'cell';
    const modelBadge = document.createElement('span');
    const mClass = MODEL_CLASSES[t.model] || '';
    modelBadge.className = 'model-badge ' + mClass;
    modelBadge.textContent = shortModel(t.model);
    modelCell.appendChild(modelBadge);
    row.appendChild(modelCell);

    // Context cell
    const ctxCell = document.createElement('div');
    ctxCell.className = 'cell context-cell';

    const ctxText = document.createElement('span');
    ctxText.className = 'context-text';
    ctxText.textContent = `${t.contextPercent.toFixed(1)}% (${fmtTokens(t.contextUsed)})`;
    ctxCell.appendChild(ctxText);

    const barOuter = document.createElement('div');
    barOuter.className = 'context-bar-outer';
    const barInner = document.createElement('div');
    barInner.className = 'context-bar-inner';
    barInner.style.width = Math.min(t.contextPercent, 100) + '%';
    barInner.style.background = contextBarColor(t.contextPercent);
    barOuter.appendChild(barInner);
    ctxCell.appendChild(barOuter);

    row.appendChild(ctxCell);

    // Duration cell
    const durCell = document.createElement('div');
    durCell.className = 'cell duration-cell';
    durCell.textContent = fmtDuration(t.elapsed);
    row.appendChild(durCell);

    // Hover tooltip
    row.addEventListener('mouseenter', (e) => showTooltip(e, t, lane));
    row.addEventListener('mousemove', positionTooltip);
    row.addEventListener('mouseleave', hideTooltip);

    rowsWrapper.appendChild(row);
  }

  graphContainer.appendChild(rowsWrapper);
}

// ── SVG helpers ──
function laneX(laneIdx) {
  return LANE_LEFT_PAD + laneIdx * LANE_WIDTH;
}

function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

function branchPath(x1, y1, x2, y2) {
  // Smooth cubic bezier from parent to child lane
  // Goes down first then curves right
  const midY = y1 + Math.min(CURVE_RADIUS, (y2 - y1) / 2);
  if (x2 === x1) {
    return `M ${x1} ${y1} L ${x2} ${y2}`;
  }
  // Smooth S-curve: down from parent, curve to child lane, then down
  const cy1 = y1 + CURVE_RADIUS;
  const cy2 = y2 - CURVE_RADIUS;
  if (y2 - y1 < CURVE_RADIUS * 3) {
    // Short distance: simple quadratic
    return `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;
  }
  return `M ${x1} ${y1} L ${x1} ${cy1} C ${x1} ${cy1 + CURVE_RADIUS}, ${x2} ${cy2 - CURVE_RADIUS}, ${x2} ${cy2} L ${x2} ${y2}`;
}

function mergePath(x1, y1, x2, y2) {
  // Mirror of branch: from child lane back to parent
  if (x1 === x2) {
    return `M ${x1} ${y1} L ${x2} ${y2}`;
  }
  const cy1 = y1 + CURVE_RADIUS;
  const cy2 = y2 - CURVE_RADIUS;
  if (y2 - y1 < CURVE_RADIUS * 3) {
    return `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;
  }
  return `M ${x1} ${y1} L ${x1} ${cy1} C ${x1} ${cy1 + CURVE_RADIUS}, ${x2} ${cy2 - CURVE_RADIUS}, ${x2} ${cy2} L ${x2} ${y2}`;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Legend ──
function renderLegend(lanes) {
  legendBar.innerHTML = '';

  for (const lane of lanes) {
    const item = document.createElement('div');
    item.className = 'legend-item';

    if (lane.type === 'orchestrator') {
      const swatch = document.createElement('span');
      swatch.className = 'legend-swatch';
      swatch.style.background = lane.color;
      item.appendChild(swatch);
      const label = document.createElement('span');
      label.textContent = 'orchestrator';
      item.appendChild(label);
    } else {
      const dot = document.createElement('span');
      dot.className = 'legend-dot';
      dot.style.background = lane.color;
      item.appendChild(dot);
      const label = document.createElement('span');
      const typeLabel = lane.type === 'fork' ? 'fork' : lane.type === 'default' ? 'agent' : lane.type;
      label.textContent = `${lane.name} (${typeLabel})`;
      item.appendChild(label);
    }

    legendBar.appendChild(item);
  }
}

// ── Tooltip ──
function showTooltip(e, turn, lane) {
  const u = turn.usage;
  const totalInput = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;

  let html = '';
  html += `<div style="font-weight:600;margin-bottom:4px;color:${lane.color}">Turn #${turn.turnIndex}</div>`;
  html += `<div class="tt-divider"></div>`;
  html += `<div class="tt-row"><span class="tt-label">Model</span><span class="tt-val">${turn.model}</span></div>`;
  html += `<div class="tt-row"><span class="tt-label">Context window</span><span class="tt-val">${fmtContextWindow(turn.contextWindow)}</span></div>`;
  html += `<div class="tt-row"><span class="tt-label">Context used</span><span class="tt-val">${fmtTokens(turn.contextUsed)} (${turn.contextPercent.toFixed(1)}%)</span></div>`;
  html += `<div class="tt-divider"></div>`;
  html += `<div style="font-weight:500;font-size:11px;color:#8b949e;margin-bottom:2px">Token Breakdown</div>`;
  html += `<div class="tt-row"><span class="tt-label">Input (new)</span><span class="tt-val">${fmtTokens(u.input_tokens)}</span></div>`;
  html += `<div class="tt-row"><span class="tt-label">Cache read</span><span class="tt-val">${fmtTokens(u.cache_read_input_tokens)}</span></div>`;
  html += `<div class="tt-row"><span class="tt-label">Cache creation</span><span class="tt-val">${fmtTokens(u.cache_creation_input_tokens)}</span></div>`;
  html += `<div class="tt-row"><span class="tt-label">Output</span><span class="tt-val">${fmtTokens(u.output_tokens)}</span></div>`;
  html += `<div class="tt-row" style="font-weight:500"><span class="tt-label">Total input</span><span class="tt-val">${fmtTokens(totalInput)}</span></div>`;
  html += `<div class="tt-divider"></div>`;
  html += `<div class="tt-row"><span class="tt-label">Duration</span><span class="tt-val">${fmtDuration(turn.elapsed)}</span></div>`;

  const tools = Object.entries(turn.toolCalls || {});
  if (tools.length > 0) {
    html += `<div class="tt-row"><span class="tt-label">Tools</span><span class="tt-val">${tools.map(([n, c]) => c > 1 ? `${n} x${c}` : n).join(', ')}</span></div>`;
  }

  if (turn.agentSpawns.length > 0) {
    html += `<div class="tt-divider"></div>`;
    html += `<div style="font-weight:500;font-size:11px;color:#db6d28;margin-bottom:2px">Spawned Agents</div>`;
    for (const s of turn.agentSpawns) {
      const name = s.name || '(unnamed)';
      html += `<div class="tt-row"><span class="tt-label">${name}</span><span class="tt-val" style="color:#8b949e">${s.subagent_type}</span></div>`;
      if (s.description) {
        html += `<div style="color:#8b949e;font-size:11px;margin-left:4px">${s.description}</div>`;
      }
    }
  }

  tooltipEl.innerHTML = html;
  tooltipEl.style.display = 'block';
  positionTooltip(e);
}

function positionTooltip(e) {
  const tt = tooltipEl;
  const pad = 12;
  let x = e.clientX + pad;
  let y = e.clientY + pad;

  // Keep within viewport
  const rect = tt.getBoundingClientRect();
  if (x + rect.width > window.innerWidth - pad) {
    x = e.clientX - rect.width - pad;
  }
  if (y + rect.height > window.innerHeight - pad) {
    y = e.clientY - rect.height - pad;
  }

  tt.style.left = x + 'px';
  tt.style.top = y + 'px';
}

function hideTooltip() {
  tooltipEl.style.display = 'none';
}

// ── Session switching ──
function loadSession(sessionId) {
  const session = fixtureData.sessions.find(s => s.id === sessionId);
  if (!session) return;
  currentSession = session;
  sessionDesc.textContent = session.description;
  renderGraph(session);
}

// ── Init ──
async function init() {
  try {
    const resp = await fetch('../../prototype-fixture.json');
    fixtureData = await resp.json();
  } catch (err) {
    graphContainer.innerHTML = `<div style="padding:40px;color:#f85149">Failed to load fixture data: ${err.message}</div>`;
    return;
  }

  // Populate session selector
  for (const s of fixtureData.sessions) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.label} (${s.turns.length} turns)`;
    sessionSelect.appendChild(opt);
  }

  sessionSelect.addEventListener('change', () => {
    loadSession(sessionSelect.value);
  });

  // Load first session
  loadSession(fixtureData.sessions[0].id);
}

init();
