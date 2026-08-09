import { createRequire } from 'module';
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:5602/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1600);
for (const el of await p.$$('.project-item')) if ((await el.textContent()).includes('side-quest')) { await el.click(); break; }
await p.waitForTimeout(600);
for (const el of await p.$$('.session-item')) if (await el.isVisible()) { await el.click(); break; }
await p.waitForTimeout(1800);
await p.waitForFunction(() => typeof wfState !== 'undefined' && wfState && wfState.lanes.length, { timeout: 8000 });
await p.evaluate(() => {
  const lane = wfState.lanes[0];
  wfState.selectedLane = lane; wfState.selectedTurnId = lane.turns[0].id; wfState.selectionLevel = 'L2';
  wfRenderCurrentSection(); wfDeferRender();
});
await p.waitForTimeout(900);
await p.evaluate(() => {
  const els = Array.from(document.querySelectorAll('#wf-agent-card-panel div, #wf-agent-card-panel span'));
  const t = els.find(e => e.textContent.trim() === 'System' && e.offsetHeight > 0);
  if (t) t.click();
});
await p.waitForTimeout(1600);
const frac = box => ({ x: +(box.x / 1600).toFixed(4), y: +(box.y / 900).toFixed(4), w: +(box.width / 1600).toFixed(4), h: +(box.height / 900).toFixed(4) });
const regions = await p.evaluate(() => {
  const out = {};
  // 1) main lane 的 turn bar(單 turn:寬 rect 群的聯集)
  const svg = document.getElementById('wf-main-svg');
  let u = null;
  for (const r of svg.querySelectorAll('rect')) {
    const b = r.getBoundingClientRect();
    if (b.width > 500 && b.height >= 5 && b.height < 60) {
      if (!u) u = { x: b.x, y: b.y, r: b.x + b.width, b: b.y + b.height };
      else { u.x = Math.min(u.x, b.x); u.y = Math.min(u.y, b.y); u.r = Math.max(u.r, b.x + b.width); u.b = Math.max(u.b, b.y + b.height); }
    }
  }
  out.turnbar = u ? { x: u.x - 12, y: u.y - 14, width: u.r - u.x + 24, height: u.b - u.y + 28 } : null;
  // 2) 左面板 Cost + Tokens 區(第一個 'Cost' 標籤起,到 'Tools' 上緣)
  const panel = document.getElementById('wf-agent-card-panel');
  const leaves = Array.from(panel.querySelectorAll('*')).filter(e => e.children.length === 0 && e.offsetHeight > 0);
  const first = s => leaves.find(e => e.textContent.trim() === s)?.getBoundingClientRect();
  const cost = first('Cost'), tools = first('Tools');
  const pb = panel.getBoundingClientRect();
  out.cost = cost && tools ? { x: pb.x, y: cost.y - 8, width: pb.width, height: tools.y - cost.y + 4 } : null;
  // 3) 右側 SYSTEM 分塊內容區
  const steps = document.getElementById('wf-steps-panel').getBoundingClientRect();
  out.system = { x: steps.x, y: steps.y, width: steps.width, height: Math.min(steps.height, 900 - steps.y - 30) };
  return out;
});
for (const [k, v] of Object.entries(regions)) console.log(k, v ? JSON.stringify(frac(v)) : 'NULL');
await p.screenshot({ path: 'turn1-tax.png' });
await b.close();
