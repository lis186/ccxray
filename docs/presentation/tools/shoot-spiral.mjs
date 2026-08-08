import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs';
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const HOME = process.cwd() + '/spiral-home';
const all = JSON.parse(fs.readFileSync(HOME + '/all-lines.json', 'utf8'));
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 2 });
const p = await ctx.newPage();
let clip = null;
for (let k = 1; k <= all.length; k++) {
  fs.writeFileSync(HOME + '/logs/index.ndjson', all.slice(0, k).map(l => JSON.stringify(l)).join('\n') + '\n');
  const srv = spawn('node', ['/home/user/ccxray/server/index.js', '--port', '5603', '--no-browser'],
    { env: { ...process.env, CCXRAY_HOME: HOME, HOME: process.cwd() + '/fake-home', CCXRAY_PLAN: 'max5x' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:5603/', { signal: AbortSignal.timeout(400) }); if (r.ok) break; } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  await p.goto('http://127.0.0.1:5603/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(900);
  for (const el of await p.$$('.project-item')) if ((await el.textContent()).includes('api-server')) { await el.click(); break; }
  await p.waitForTimeout(400);
  const sess = await p.$$('.session-item'); if (sess[0]) await sess[0].click();
  await p.waitForTimeout(1100);
  if (!clip) {
    const ov = await (await p.$('#wf-overview')).boundingBox();
    const lanes = await (await p.$('#wf-lanes-section')).boundingBox();
    clip = { x: ov.x, y: ov.y, width: 1600 - ov.x - 4, height: lanes.y + lanes.height - ov.y };
    console.log('clip:', JSON.stringify(clip));
  }
  await p.screenshot({ path: 'spiral-' + String(k).padStart(2, '0') + '.png', clip });
  srv.kill();
  await new Promise(r => setTimeout(r, 250));
  process.stdout.write(k + ' ');
}
console.log('\nframes done');
await b.close();
