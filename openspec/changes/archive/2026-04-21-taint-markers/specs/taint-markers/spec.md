## ADDED Requirements

### Requirement: Tool source classification
系統 SHALL 根據 tool_use 的 `name` 與 `input` 將每個 tool call 分類為以下來源之一：`local`、`local:sensitive`、`network`。

分類規則：
- **network**：tool name 屬於已知網路工具清單（`WebFetch`、`WebSearch`、`mcp__*__fetch`、`mcp__*__search` 等前綴/後綴匹配）
- **local:sensitive**：tool name 屬於本地工具，且 `input` 的 JSON 字串包含已知敏感路徑（`~/.ssh/`、`.env`、`/etc/passwd`、`/etc/shadow`、`/etc/sudoers`、`id_rsa`、`id_ed25519`、`id_ecdsa`、`authorized_keys`、`known_hosts`）
- **local**：其餘所有 tool call

#### Scenario: Network tool classification
- **WHEN** tool_use name 為 `WebFetch`
- **THEN** `classifyToolSource` 回傳 `'network'`

#### Scenario: Local sensitive classification
- **WHEN** tool_use name 為 `Read`，input 包含 `~/.ssh/id_rsa`
- **THEN** `classifyToolSource` 回傳 `'local:sensitive'`

#### Scenario: Plain local classification
- **WHEN** tool_use name 為 `Read`，input 為 `/tmp/foo.txt`
- **THEN** `classifyToolSource` 回傳 `'local'`

#### Scenario: Unknown tool defaults to local
- **WHEN** tool_use name 不在任何已知清單中
- **THEN** `classifyToolSource` 回傳 `'local'`（保守預設）

---

### Requirement: Tool source stored in entry summary
系統 SHALL 在 entry summary 中加入 `toolSources` 物件，key 為 tool_use `id`，value 為來源分類字串。`toolSources` 在 `sse-broadcast.js` 計算，並在 `restore.js` 的歷史載入路徑中同樣計算。

#### Scenario: Summary includes toolSources
- **WHEN** entry 包含至少一個 tool_use
- **THEN** entry summary 的 `toolSources` 包含該 tool_use id 對應的來源字串

#### Scenario: Empty toolSources for no tool calls
- **WHEN** entry 不含任何 tool_use
- **THEN** entry summary 的 `toolSources` 為空物件 `{}`

---

### Requirement: Timeline badge display
系統 SHALL 在 dashboard timeline 的 tool call row 右側顯示對應的來源 badge。

Badge 規格：
- `local`：灰色文字，無背景，顯示 `[local]`
- `local:sensitive`：橘色背景，顯示 `[local:sensitive]`
- `network`：藍色背景，顯示 `[network]`

#### Scenario: Network badge shown
- **WHEN** 用戶點開含有 `WebFetch` tool call 的 turn
- **THEN** 該 tool call row 顯示藍色 `[network]` badge

#### Scenario: Sensitive badge shown
- **WHEN** tool call 為 `Read`，input 含 `.env` 路徑
- **THEN** 該 tool call row 顯示橘色 `[local:sensitive]` badge

#### Scenario: No badge for plain local
- **WHEN** tool call 為 `Read`，input 為一般路徑
- **THEN** 該 tool call row 顯示灰色 `[local]`（低視覺權重）
