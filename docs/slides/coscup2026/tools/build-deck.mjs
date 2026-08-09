// 把截圖以 base64 內嵌進 deck-template.html,輸出 ../index.html。
// 截圖 PNG(crop-*.png / full-session.png 等)須放在執行時的工作目錄。
import fs from 'fs';
import path from 'path';
const here = path.dirname(new URL(import.meta.url).pathname);
let html = fs.readFileSync(path.join(here, 'deck-template.html'), 'utf8');
html = html.replace(/\{\{IMG:([a-z0-9-]+)\}\}/g, (_, name) =>
  'data:image/png;base64,' + fs.readFileSync(name + '.png').toString('base64'));
fs.writeFileSync(path.join(here, '..', 'index.html'), html);
console.log('deck bytes:', html.length);
