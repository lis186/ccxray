// side-quest turn #1 的 Cost Efficiency 區:拍 cost-eff.png + 量測圈選區域
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
  const els = Array.from(document.querySelectorAll('#wf-agent-card-panel span'));
  const t = els.reverse().find(e => e.textContent.trim() === 'Cost' && e.offsetHeight > 0);
  if (t) t.click();
});
await p.waitForTimeout(2500);
const frac = box => ({ x: +(box.x / 1600).toFixed(4), y: +(box.y / 900).toFixed(4), w: +(box.width / 1600).toFixed(4), h: +(box.height / 900).toFixed(4) });
const regions = await p.evaluate(() => {
  const panel = document.getElementById('wf-steps-panel');
  const leaves = Array.from(panel.querySelectorAll('*')).filter(e => e.children.length === 0 && e.offsetHeight > 0);
  const out = { _text: panel.innerText.slice(0, 600) };
  // 1) MCP bar 區:第一個 'MCP: ' 標籤到最後一個可見者(在視窗內)
  const mcpLabels = leaves.filter(e => e.textContent.startsWith('MCP: ') && e.getBoundingClientRect().y < 880);
  if (mcpLabels.length) {
    const first = mcpLabels[0].getBoundingClientRect();
    const last = mcpLabels[mcpLabels.length - 1].closest('div[style*="flex"]').getBoundingClientRect();
    const pb = panel.getBoundingClientRect();
    out.mcpbars = { x: pb.x + 8, y: first.y - 6, width: pb.width - 30, height: Math.min(last.y + last.height, 880) - first.y + 10 };
  }
  // 2) Fixed tax 摘要列
  const tax = leaves.find(e => e.textContent.startsWith('Fixed tax per turn'));
  if (tax) { const b = tax.closest('div').getBoundingClientRect(); out.tax = { x: b.x - 4, y: b.y - 4, width: b.width + 8, height: b.height + 8 }; }
  // 3) ⚠ 警告區(視窗內可見部分)
  const warns = leaves.filter(e => e.textContent.startsWith('⚠') && e.getBoundingClientRect().y < 890);
  if (warns.length) {
    const f = warns[0].getBoundingClientRect(), l = warns[warns.length - 1].getBoundingClientRect();
    out.warns = { x: f.x - 6, y: f.y - 6, width: Math.max(...warns.map(w => w.getBoundingClientRect().width)) + 12, height: Math.min(l.y + l.height, 890) - f.y + 10 };
  }
  out._counts = { mcpLabels: mcpLabels.length, warns: warns.length, taxText: tax ? tax.textContent : null };
  return out;
});
console.log('--- panel head ---\n' + regions._text);
console.log('counts:', JSON.stringify(regions._counts));
// 第一張:上半(user 區塊 + MCP bars)。userblock = 'Custom skills' 列到 'Global CLAUDE.md' 列。
const extra = await p.evaluate(() => {
  const panel = document.getElementById('wf-steps-panel');
  const leaves = Array.from(panel.querySelectorAll('*')).filter(e => e.children.length === 0 && e.offsetHeight > 0);
  const row = s => leaves.find(e => e.textContent.trim() === s)?.closest('div[style*="flex"]')?.getBoundingClientRect();
  const a = row('Custom skills'), z = row('Global CLAUDE.md');
  const pb = panel.getBoundingClientRect();
  return a && z ? { x: pb.x + 8, y: a.y - 6, width: pb.width - 30, height: z.y + z.height - a.y + 12 } : null;
});
if (extra) console.log('userblock', JSON.stringify(frac(extra)));
await p.screenshot({ path: 'cost-eff.png' });
// 第二張:捲到 Fixed tax 摘要 + ⚠ 警告牆
await p.evaluate(() => {
  const panel = document.getElementById('wf-steps-panel');
  const leaves = Array.from(panel.querySelectorAll('*')).filter(e => e.children.length === 0 && e.offsetHeight > 0);
  const all = Array.from(panel.querySelectorAll('div'));
  const tax = all.filter(e => e.textContent.startsWith('Fixed tax per turn')).pop();
  const scroller = (el => { while (el && el.scrollHeight <= el.clientHeight + 4) el = el.parentElement; return el; })(tax);
  scroller.scrollTop += tax.getBoundingClientRect().y - scroller.getBoundingClientRect().y - 60;
});
await p.waitForTimeout(500);
const r2 = await p.evaluate(() => {
  const panel = document.getElementById('wf-steps-panel');
  const leaves = Array.from(panel.querySelectorAll('*')).filter(e => e.children.length === 0 && e.offsetHeight > 0);
  const out = {};
  const tax = Array.from(panel.querySelectorAll('div')).filter(e => e.textContent.startsWith('Fixed tax per turn')).pop();
  if (tax) { const b = tax.getBoundingClientRect(); out.tax = { x: b.x - 4, y: b.y - 4, width: b.width + 8, height: b.height + 8 }; }
  const warns = leaves.filter(e => e.textContent.startsWith('⚠') && e.getBoundingClientRect().y < 890 && e.getBoundingClientRect().y > 0);
  if (warns.length) {
    const f = warns[0].getBoundingClientRect(), l = warns[warns.length - 1].getBoundingClientRect();
    out.warns = { x: f.x - 6, y: f.y - 6, width: Math.max(...warns.map(w => w.getBoundingClientRect().width)) + 12, height: Math.min(l.y + l.height, 890) - f.y + 10 };
  }
  out._n = warns.length; out._taxText = tax ? tax.textContent : null;
  return out;
});
console.log('tax text:', r2._taxText, '| warns visible:', r2._n);
for (const [k, v] of Object.entries(r2)) if (k[0] !== '_') console.log(k, JSON.stringify(frac(v)));
await p.screenshot({ path: 'cost-eff2.png' });
await b.close();
