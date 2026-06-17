#!/usr/bin/env bash
# browser-harness e2e for `ccxray rebuild-index` (GitHub #48).
#
# Proves the full self-heal path through the REAL browser-harness tool (CDP/Chrome,
# per CLAUDE.md), not headless puppeteer: seed log files with NO index → rebuild →
# start the dashboard → drive browser-harness to assert the recovered turns render.
#
# Not part of `npm test` (browser-harness + Chrome are environment-specific). Run
# manually:  bash test/rebuild-index.browser-harness.e2e.sh
#
# Self-contained: launches a dedicated remote-debugging Chrome on a throwaway
# profile (BU_CDP_URL) so it never needs the manual "Allow remote debugging"
# dialog, and cleans up server + Chrome + temp dirs on exit.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT=5614
CDP_PORT=9334
HOME_DIR="$(mktemp -d /tmp/ccxray-bh-e2e.XXXXXX)"
PROFILE="$(mktemp -d /tmp/ccxray-bh-profile.XXXXXX)"
SHOT="$REPO/reason/260617-index-rebuild-resilience/evidence/browser-harness-after-rebuild.png"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SERVER_PID=""; CHROME_PID=""

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null || true
  sleep 1  # let Chrome finish writing its profile before we remove it
  rm -rf "$HOME_DIR" "$PROFILE" 2>/dev/null || true
}
trap cleanup EXIT

echo "1. seed log files (anchor + delta), NO index — the data-loss state"
mkdir -p "$HOME_DIR/logs/shared"
node -e '
const fs=require("fs"),p=require("path");
const L=process.argv[1], cwd=process.argv[2];
fs.writeFileSync(p.join(L,"shared","sys_bh.json"),JSON.stringify([{type:"text",text:"You are Claude Code."},{type:"text",text:"Env\nPrimary working directory: "+cwd+"\n"}]));
const res=()=>JSON.stringify([{type:"message_start",message:{usage:{input_tokens:250,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},{type:"message_delta",delta:{stop_reason:"end_turn"},usage:{output_tokens:70}}]);
fs.writeFileSync(p.join(L,"2026-06-14T09-00-00-000_req.json"),JSON.stringify({model:"claude-sonnet-4-6",max_tokens:8096,sysHash:"bh",messages:[{role:"user",content:"rebuild index from logs"}],metadata:{session_id:"BH-DEMO"}}));
fs.writeFileSync(p.join(L,"2026-06-14T09-00-00-000_res.json"),res());
fs.writeFileSync(p.join(L,"2026-06-14T09-01-00-000_req.json"),JSON.stringify({model:"claude-sonnet-4-6",max_tokens:8096,sysHash:"bh",prevId:"2026-06-14T09-00-00-000",msgOffset:1,messages:[{role:"assistant",content:"ok"},{role:"user",content:"verify with browser-harness"}],metadata:{session_id:"BH-DEMO"}}));
fs.writeFileSync(p.join(L,"2026-06-14T09-01-00-000_res.json"),res());
' "$HOME_DIR/logs" "$REPO"
[ ! -f "$HOME_DIR/logs/index.ndjson" ] || { echo "FAIL: index should not exist yet"; exit 1; }

echo "2. rebuild-index --apply (real CLI)"
CCXRAY_HOME="$HOME_DIR" node "$REPO/server/index.js" rebuild-index --apply 2>/dev/null | grep -v Warning
[ -f "$HOME_DIR/logs/index.ndjson" ] || { echo "FAIL: index not rebuilt"; exit 1; }

echo "3. launch dedicated remote-debugging Chrome (throwaway profile, no Allow dialog)"
"$CHROME" --remote-debugging-port=$CDP_PORT --user-data-dir="$PROFILE" --headless=new \
  --no-first-run --no-default-browser-check about:blank >/dev/null 2>&1 &
CHROME_PID=$!
export BU_CDP_URL="http://127.0.0.1:$CDP_PORT"
for i in $(seq 1 40); do curl -s --max-time 1 "$BU_CDP_URL/json/version" >/dev/null 2>&1 && break; sleep 0.25; done
browser-harness --reload >/dev/null 2>&1 || true

echo "4. start ccxray dashboard on :$PORT"
CCXRAY_HOME="$HOME_DIR" node "$REPO/server/index.js" --port $PORT --no-browser >/dev/null 2>&1 &
SERVER_PID=$!
for i in $(seq 1 60); do curl -s --max-time 1 "http://localhost:$PORT/_api/health" >/dev/null 2>&1 && break; sleep 0.25; done

echo "5. drive browser-harness: navigate, wait for the recovered turn, assert, screenshot"
browser-harness -c "
ensure_real_tab()
goto_url('http://localhost:$PORT/?p=ccxray&s=BH-DEMO')
wait_for_load()
wait_for_element('.turn-item[data-session-id=\"BH-DEMO\"]', timeout=20)
counts = js('JSON.stringify({turns:document.querySelectorAll(\".turn-item\").length,project:(document.querySelector(\".project-item.selected .pi-label\")||{}).textContent||\"\",turnText:(document.querySelector(\".turn-item[data-session-id=\x27BH-DEMO\x27]\")||{}).innerText||\"\"})')
import json
d = json.loads(counts)
assert d['turns'] == 2, 'expected 2 recovered turns, got %r' % d['turns']
assert d['project'] == 'ccxray', 'expected project ccxray, got %r' % d['project']
assert 'rebuild index from logs' in d['turnText'], 'recovered title missing: %r' % d['turnText']
capture_screenshot('$SHOT', full=True)
print('BROWSER-HARNESS E2E PASS:', counts)
"
echo "OK — browser-harness e2e passed; screenshot at $SHOT"
