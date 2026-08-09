// 量測 cost tour 的三個區域(專案欄成本、session 卡成本、turn Cost 面板)
// 並拍 cost-tour.png:ccxray 專案 → a1b2c3d4 session → 點 main lane 最後一個 turn。
import { createRequire } from 'module';
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:5602/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1600);
for (const el of await p.$$('.project-item')) if ((await el.textContent()).includes('ccxray')) { await el.click(); break; }
await p.waitForTimeout(600);
for (const el of await p.$$('.session-item')) if ((await el.textContent()).includes('a1b2c3d4')) { await el.click(); break; }
await p.waitForTimeout(1800);
await p.waitForFunction(() => typeof wfState !== 'undefined' && wfState && wfState.lanes.length, { timeout: 8000 });
await p.evaluate(() => {
  const lane = wfState.lanes[0];
  wfState.selectedLane = lane; wfState.selectedTurnId = lane.turns[lane.turns.length - 1].id; wfState.selectionLevel = 'L2';
  wfRenderCurrentSection(); wfDeferRender();
});
await p.waitForTimeout(1200);
const frac = box => ({ x: +(box.x / 1600).toFixed(4), y: +(box.y / 900).toFixed(4), w: +(box.width / 1600).toFixed(4), h: +(box.height / 900).toFixed(4) });
const regions = await p.evaluate(() => {
  const out = {};
  const union = els => {
    let u = null;
    for (const el of els) {
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      if (!u) u = { x: b.x, y: b.y, r: b.x + b.width, b: b.y + b.height };
      else { u.x = Math.min(u.x, b.x); u.y = Math.min(u.y, b.y); u.r = Math.max(u.r, b.x + b.width); u.b = Math.max(u.b, b.y + b.height); }
    }
    return u ? { x: u.x - 6, y: u.y - 6, width: u.r - u.x + 12, height: u.b - u.y + 12 } : null;
  };
  out.projects = union(document.querySelectorAll('.project-item'));
  out.sessions = union(document.querySelectorAll('.session-item'));
  // turn Cost 面板:'Cost' 標籤起到 'Tools' 上緣(同 measure-tax)
  const panel = document.getElementById('wf-agent-card-panel');
  const leaves = Array.from(panel.querySelectorAll('*')).filter(e => e.children.length === 0 && e.offsetHeight > 0);
  const first = s => leaves.find(e => e.textContent.trim() === s)?.getBoundingClientRect();
  const cost = first('Cost'), tools = first('Tools');
  const pb = panel.getBoundingClientRect();
  out.turncost = cost && tools ? { x: pb.x, y: cost.y - 8, width: pb.width, height: tools.y - cost.y + 4 } : null;
  // 選中 turn 的面板抬頭 + 單 turn 成本(供文案對數字)
  out._panelText = panel.innerText.slice(0, 400);
  return out;
});
for (const [k, v] of Object.entries(regions)) {
  if (k === '_panelText') { console.log('--- panel text ---\n' + v); continue; }
  console.log(k, v ? JSON.stringify(frac(v)) : 'NULL');
}
await p.screenshot({ path: 'cost-tour.png' });
await b.close();
