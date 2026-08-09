// localhost 轉發 platform.claude.com:Chromium 打不通 egress proxy 的 CONNECT,
// 但 Node fetch 可以——所以本機開一個 relay,讓真實頁面在真瀏覽器裡渲染。
// 以 NODE_USE_ENV_PROXY=1 執行(Node >= 22.21 的 fetch 才會讀 HTTPS_PROXY)
import http from 'http';
const UP = 'https://platform.claude.com';
http.createServer(async (req, res) => {
  try {
    const r = await fetch(UP + req.url, { headers: { 'user-agent': req.headers['user-agent'] || 'Mozilla/5.0', accept: req.headers.accept || '*/*' } });
    const buf = Buffer.from(await r.arrayBuffer());
    const h = {};
    for (const [k, v] of r.headers) {
      if (['content-encoding', 'content-length', 'content-security-policy', 'strict-transport-security', 'transfer-encoding', 'connection'].includes(k)) continue;
      h[k] = v;
    }
    h['content-length'] = buf.length;
    res.writeHead(r.status, h);
    res.end(buf);
  } catch (e) {
    res.writeHead(502); res.end(String(e));
  }
}).listen(8899, '127.0.0.1', () => console.log('relay on 8899'));
