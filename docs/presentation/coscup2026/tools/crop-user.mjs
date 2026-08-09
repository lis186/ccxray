import { createRequire } from 'module';
import fs from 'fs';
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 2200, height: 1200 } });
const data = 'data:image/jpeg;base64,' + fs.readFileSync('user-upload-39.jpg').toString('base64');
await p.setContent('<img id="i" src="' + data + '" style="display:block">');
await p.waitForSelector('#i');
const boxes = await p.evaluate(() => {
  const img = document.getElementById('i');
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, W, H).data;
  const darkCol = x => { let n = 0; for (let y = 0; y < H; y += 3) { const o = (y * W + x) * 4; if (d[o] + d[o+1] + d[o+2] < 300) n++; } return n / (H / 3) > 0.5; };
  const darkRow = (y, x0, x1) => { let n = 0; for (let x = x0; x < x1; x += 3) { const o = (y * W + x) * 4; if (d[o] + d[o+1] + d[o+2] < 300) n++; } return n / ((x1 - x0) / 3) > 0.5; };
  // 掃出深色欄的連續區段
  const segs = []; let s = null;
  for (let x = 0; x < W; x++) {
    if (darkCol(x)) { if (s === null) s = x; }
    else if (s !== null) { if (x - s > W * 0.2) segs.push([s, x]); s = null; }
  }
  if (s !== null && W - s > W * 0.2) segs.push([s, W]);
  return segs.map(([x0, x1]) => {
    let y0 = 0, y1 = H;
    while (y0 < H && !darkRow(y0, x0, x1)) y0++;
    while (y1 > y0 && !darkRow(y1 - 1, x0, x1)) y1--;
    return { x: x0 + 13, y: y0 + 13, width: x1 - x0 - 26, height: y1 - y0 - 26 };
  });
});
console.log('detected panels:', JSON.stringify(boxes));
if (boxes.length !== 2) { console.log('FAIL: expected 2 panels'); process.exit(1); }
await p.screenshot({ path: 'fanout-good.png', clip: boxes[0] });
await p.screenshot({ path: 'fanout-bad.png', clip: boxes[1] });
console.log('saved fanout-good.png / fanout-bad.png');
await b.close();
