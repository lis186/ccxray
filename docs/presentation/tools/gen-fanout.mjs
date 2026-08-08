// 多 subagent 長任務 × 模型選擇對照:
//   GOOD:fable-5[1m] 指揮(1M 綽綽有餘)+ sonnet 子代理各給一小塊 → 全綠
//   BAD :全上 200K(sonnet)——window 不足,子代理 ctx 45→95%、失敗率飆高、
//        重試更多回合 → 紅黃一片、更久、更貴
// 費率同 server/default-rates.js;成本由 token 計算。
import fs from 'fs';
const HOME = process.argv[2];
const LOGS = HOME + '/logs';
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(LOGS + '/shared', { recursive: true });
for (const f of ['sys_f3a9c1.json', 'sys_99baaf.json', 'tools_7d2e88.json'])
  fs.copyFileSync('ccxray-smoke/logs/shared/' + f, LOGS + '/shared/' + f);

const RATES = {
  'claude-fable-5':    { input: 10, output: 50, cache_create: 12.50, cache_read: 1.00 },
  'claude-sonnet-4-6': { input: 3,  output: 15, cache_create: 3.75,  cache_read: 0.30 },
};
const price = (m, u) => (u.input_tokens * RATES[m].input + u.output_tokens * RATES[m].output +
  u.cache_creation_input_tokens * RATES[m].cache_create + u.cache_read_input_tokens * RATES[m].cache_read) / 1e6;
const pad = n => String(n).padStart(2, '0');
const mkId = t => { const d = new Date(t); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth()+1) + '-' + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + '-' + pad(d.getUTCMinutes()) + '-' + pad(d.getUTCSeconds()) + '-' + String(d.getUTCMilliseconds()).padStart(3,'0'); };
const mkTs = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
const CWD = '/home/justin/dev/data-pipeline';
const lines = [];
let ridSeq = 0;
const push = (o) => {
  const id = mkId(o.t);
  const rid = 'msg_01F' + String(ridSeq++).padStart(3, '0');
  fs.writeFileSync(LOGS + '/' + id + '_req.json', JSON.stringify({ model: o.model, max_tokens: 16000, messages: [{ role: 'user', content: o.brief }], sysHash: o.sysHash, toolsHash: '7d2e88' }));
  const c = price(o.model, o.usage);
  lines.push({
    id, ts: mkTs(o.t), sessionId: o.sid, provider: 'anthropic', agent: 'claude',
    model: o.model, msgCount: o.msgCount, toolCount: 8,
    toolCalls: o.tools, turnToolCalls: o.tools,
    isSubagent: o.sub, sessionInferred: false, cwd: CWD,
    receivedAt: o.t, elapsed: o.elapsed.toFixed(1),
    usage: o.usage, cost: { cost: Math.round(c * 10000) / 10000 },
    maxContext: o.maxContext, ...(o.beta1m ? { beta1m: true } : {}),
    stopReason: 'end_turn', title: o.title, status: 200, toolFail: !!o.fail,
    sysHash: o.sysHash, toolsHash: '7d2e88', coreHash: o.coreHash, agentKey: o.agentKey, agentLabel: o.agentLabel,
    convId: o.convId, responseId: rid, isSSE: true,
  });
  return c;
};
// 決定性偽隨機
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const ri = (a, b) => Math.round(a + rnd() * (b - a));

function buildSession({ sid, title, start, mainModel, mainWin, mainBeta, mainTurns, mainCtx0, mainCtx1,
                        waves, subModel, subTurns, subCtx0, subCtx1, subElapsed, failFrom, spanMin }) {
  let cost = 0, fails = 0, subTurnCount = 0;
  // main lane:回合平均鋪滿 span
  const mainGap = (spanMin * 60000) / mainTurns;
  for (let k = 0; k < mainTurns; k++) {
    const ctx = Math.round(mainCtx0 + (mainCtx1 - mainCtx0) * (k / (mainTurns - 1)));
    const read = k === 0 ? 0 : Math.round(mainCtx0 + (mainCtx1 - mainCtx0) * ((k - 1) / (mainTurns - 1)));
    const inT = k === 0 ? 6200 : ri(30, 80);
    const usage = { input_tokens: inT, output_tokens: ri(400, 1100), cache_creation_input_tokens: Math.max(0, ctx - read - inT), cache_read_input_tokens: read };
    cost += push({ t: start + k * mainGap, sid, model: mainModel, maxContext: mainWin, beta1m: mainBeta,
      usage, msgCount: 1 + k * 2, elapsed: ri(10, 24), tools: { Task: ri(1, 3), Read: 1 },
      sub: false, title, brief: title + ' — orchestrator turn ' + k,
      sysHash: 'f3a9c1', coreHash: 'aa11bb', agentKey: 'orchestrator', agentLabel: 'Claude Code', convId: 'a0a0' + sid.slice(0, 4) });
  }
  // subagent 波次
  let li = 0;
  waves.forEach(([atMin, n]) => {
    for (let a = 0; a < n; a++, li++) {
      const conv = 'f' + String(li).padStart(3, '0') + sid.slice(0, 4);
      let t = start + atMin * 60000 + a * ri(6, 18) * 1000;
      const turns = ri(subTurns[0], subTurns[1]);
      for (let k = 0; k < turns; k++, subTurnCount++) {
        const frac = turns === 1 ? 1 : k / (turns - 1);
        const ctx = Math.round(subCtx0 + (subCtx1 - subCtx0) * frac) + ri(-3000, 3000);
        const read = k === 0 ? 0 : Math.round(subCtx0 + (subCtx1 - subCtx0) * ((k - 1) / Math.max(1, turns - 1)));
        const inT = k === 0 ? ri(2500, 4500) : ri(25, 70);
        const fail = frac >= failFrom && rnd() < 0.62;
        if (fail) fails++;
        const usage = { input_tokens: inT, output_tokens: ri(250, 700), cache_creation_input_tokens: Math.max(0, ctx - read - inT), cache_read_input_tokens: read };
        cost += push({ t, sid, model: subModel, maxContext: 200000,
          usage, msgCount: 1 + k * 2, elapsed: ri(subElapsed[0], subElapsed[1]), tools: fail ? { Bash: 2, Edit: 1 } : { Read: 2, Grep: 1 },
          sub: true, fail, title, brief: title + ' — chunk ' + li,
          sysHash: '99baaf', coreHash: 'dd44ee', agentKey: 'explore', agentLabel: 'Explore', convId: conv });
        t += (ri(subElapsed[0], subElapsed[1]) + ri(5, 16)) * 1000;
      }
    }
  });
  return { cost, fails, subTurnCount, lanes: li };
}

const now = Date.now();
const G = buildSession({
  sid: 'feedface-1111-2222-3333-444455556666', title: 'Migrate pipeline to v2 schema',
  start: now - 100 * 60000, mainModel: 'claude-fable-5', mainWin: 1000000, mainBeta: true,
  mainTurns: 10, mainCtx0: 120000, mainCtx1: 260000,
  waves: [[2, 4], [9, 4], [17, 3], [25, 3]], subModel: 'claude-sonnet-4-6',
  subTurns: [4, 5], subCtx0: 14000, subCtx1: 62000, subElapsed: [5, 14], failFrom: 99, spanMin: 34,
});
const B = buildSession({
  sid: 'baadf00d-7777-8888-9999-000011112222', title: 'Migrate pipeline to v2 schema (retry)',
  start: now - 60 * 60000, mainModel: 'claude-sonnet-4-6', mainWin: 200000, mainBeta: false,
  mainTurns: 14, mainCtx0: 50000, mainCtx1: 150000,
  waves: [[2, 5], [12, 5], [24, 5], [38, 5]], subModel: 'claude-sonnet-4-6',
  subTurns: [6, 8], subCtx0: 90000, subCtx1: 190000, subElapsed: [20, 75], failFrom: 0.35, spanMin: 56,
});
lines.sort((a, b) => a.receivedAt - b.receivedAt);
fs.writeFileSync(LOGS + '/index.ndjson', lines.map(l => JSON.stringify(l)).join('\n') + '\n');
console.log('GOOD: span 34m, lanes', G.lanes, ', cost $' + G.cost.toFixed(2), ', subFails', G.fails + '/' + G.subTurnCount);
console.log('BAD : span 56m, lanes', B.lanes, ', cost $' + B.cost.toFixed(2), ', subFails', B.fails + '/' + B.subTurnCount, '=', Math.round(B.fails / B.subTurnCount * 100) + '%');
