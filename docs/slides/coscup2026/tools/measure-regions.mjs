import { createRequire } from 'module';
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:5602/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);
for (const el of await p.$$('.project-item')) if ((await el.textContent()).includes('ccxray')) { await el.click(); break; }
await p.waitForTimeout(500);
for (const el of await p.$$('.session-item')) if (await el.isVisible()) { await el.click(); break; }
await p.waitForTimeout(2200);
const frac = async sel => {
  const box = await (await p.$(sel)).boundingBox();
  return { x: +(box.x / 1600).toFixed(4), y: +(box.y / 900).toFixed(4), w: +(box.width / 1600).toFixed(4), h: +(box.height / 900).toFixed(4) };
};
const top = await frac('#topbar');
const projs = await (await p.$('#col-projects')).boundingBox();
const sess = await (await p.$('#col-sessions')).boundingBox();
const colsUnion = { x: projs.x, y: projs.y, w: sess.x + sess.width - projs.x, h: Math.max(projs.height, sess.height) };
// 卡片實際內容高(到卡片底,不含空欄)
const colBottom = await p.evaluate(() => {
  let max = 0;
  for (const c of document.querySelectorAll('#col-projects *, #col-sessions *')) {
    const r = c.getBoundingClientRect();
    if (r.height > 0 && r.bottom < 880 && r.bottom > max) max = r.bottom;
  }
  return max;
});
const cols = { x: +(colsUnion.x / 1600).toFixed(4), y: +(colsUnion.y / 900).toFixed(4), w: +(colsUnion.w / 1600).toFixed(4), h: +((colBottom - colsUnion.y + 12) / 900).toFixed(4) };
const steps = await frac('#wf-steps-panel');
console.log(JSON.stringify({ top, cols, steps }, null, 1));
// 同步重拍最新的完整畫面當底圖
await p.screenshot({ path: 'full-session.png' });
await b.close();
