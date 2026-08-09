// 拍官方 pricing 頁(經 localhost relay 的真實頁面)+ 量測 price tour 區域
import { createRequire } from 'module';
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:8899/docs/en/about-claude/pricing', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(6000);
// 捲到主表:表頭貼近視窗上緣下方一點,讓頁面標題也入鏡
await p.evaluate(() => {
  const t = document.querySelector('table');
  const y = t.getBoundingClientRect().y + scrollY;
  scrollTo(0, Math.max(0, y - 150));
});
await p.waitForTimeout(800);
const frac = box => ({ x: +(box.x / 1600).toFixed(4), y: +(box.y / 900).toFixed(4), w: +(box.width / 1600).toFixed(4), h: +(box.height / 900).toFixed(4) });
const regions = await p.evaluate(() => {
  const t = document.querySelector('table');
  const ths = Array.from(t.querySelectorAll('thead th'));
  const rows = Array.from(t.querySelectorAll('tbody tr'));
  const fable = rows.find(r => r.textContent.includes('Fable 5'));
  const cells = Array.from(fable.querySelectorAll('td,th'));
  const th1h = ths.find(e => e.textContent.includes('1h Cache'));
  const thHit = ths.find(e => e.textContent.includes('Cache Hits'));
  const td1h = cells[3].getBoundingClientRect();
  const tdHit = cells[4].getBoundingClientRect();
  const rb = fable.getBoundingClientRect();
  const h1 = th1h.getBoundingClientRect(), h2 = thHit.getBoundingClientRect();
  const uni = list => {
    let u = null;
    for (const b of list) {
      if (!u) u = { x: b.x, y: b.y, r: b.x + b.width, b: b.y + b.height };
      else { u.x = Math.min(u.x, b.x); u.y = Math.min(u.y, b.y); u.r = Math.max(u.r, b.x + b.width); u.b = Math.max(u.b, b.y + b.height); }
    }
    return { x: u.x - 6, y: u.y - 6, width: u.r - u.x + 12, height: u.b - u.y + 12 };
  };
  return {
    fablerow: { x: rb.x - 6, y: rb.y - 6, width: rb.width + 12, height: rb.height + 12 },
    cachecols: uni([h1, h2, td1h, tdHit]),
    _check: { row: fable.textContent.trim().slice(0, 90), td1h: cells[3].textContent, tdHit: cells[4].textContent },
  };
});
console.log('check:', JSON.stringify(regions._check));
for (const [k, v] of Object.entries(regions)) if (k[0] !== '_') console.log(k, JSON.stringify(frac(v)));
await p.screenshot({ path: 'pricing-table.png' });
await b.close();
