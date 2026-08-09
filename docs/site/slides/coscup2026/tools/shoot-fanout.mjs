import { createRequire } from 'module';
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 2 });
const p = await ctx.newPage();
const shootSession = async (titleFrag, name) => {
  await p.goto('http://127.0.0.1:5604/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1400);
  for (const el of await p.$$('.project-item')) if ((await el.textContent()).includes('data-pipeline')) { await el.click(); break; }
  await p.waitForTimeout(500);
  let found = false;
  for (const el of await p.$$('.session-item')) { const t = await el.textContent(); if (t.includes(titleFrag)) { await el.click(); found = true; break; } }
  console.log(name, 'session found:', found);
  await p.waitForTimeout(1800);
  await p.evaluate(() => wfToggleBirdsEye());
  await p.waitForTimeout(900);
  const canvas = await p.$('#wf-minimap-canvas');
  const box = await canvas.boundingBox();
  console.log(name, 'canvas:', Math.round(box.width) + 'x' + Math.round(box.height));
  await canvas.screenshot({ path: name + '.png' });
};
// 兩個 session 同標題,靠 (retry) 區分;先拍 bad(較新在上)再 good
await shootSession('(retry)', 'fanout-bad');
await shootSession('Migrate pipeline', 'fanout-good');
await b.close();
