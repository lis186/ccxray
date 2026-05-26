## ADDED Requirements

### Requirement: Server-side credential detection
系統 SHALL 在 entry summary 中計算 `hasCredential` flag，涵蓋 assistant text blocks 和 tool_result content 中符合已知 credential pattern 的字串。

#### Scenario: Assistant text contains API key
- **WHEN** assistant message 含有符合 `sk-ant-[a-zA-Z0-9]{20,}` pattern 的文字
- **THEN** entry summary 中 `hasCredential` 為 `true`

#### Scenario: Tool result contains SSH private key
- **WHEN** tool_result content 含有 `-----BEGIN RSA PRIVATE KEY-----`
- **THEN** entry summary 中 `hasCredential` 為 `true`

#### Scenario: No credential present
- **WHEN** assistant text 和所有 tool_result 都不含任何已知 credential pattern
- **THEN** entry summary 中 `hasCredential` 為 `false` 或 `undefined`

#### Scenario: Restore path consistency
- **WHEN** ccxray 啟動並從磁碟 restore 歷史 entries
- **THEN** 每個 restored entry 的 `hasCredential` 與相同資料透過 live path 計算的結果一致

### Requirement: Turns column credential badge
系統 SHALL 在 `hasCredential` 為 true 的 turn row 上顯示橘色 `⚠ cred` badge。

#### Scenario: Badge visible without clicking
- **WHEN** 用戶瀏覽 turns column
- **THEN** 含有 credential 的 turn row 上有可見的橘色 badge，不需要點擊或 hover

#### Scenario: Badge absent when no credential
- **WHEN** turn 不含 credential
- **THEN** turn row 上不顯示 credential badge

### Requirement: Detail view credential highlight
系統 SHALL 在 detail view 的 assistant-text step 和 tool-group result 中，對符合 credential pattern 的字串套用橘色 inline highlight。

#### Scenario: Inline highlight in assistant text
- **WHEN** 用戶點入含有 credential 的 assistant-text step
- **THEN** credential 字串以橘色底色標示，其餘文字正常顯示

#### Scenario: Inline highlight in tool result
- **WHEN** 用戶點入含有 credential 的 tool-group call detail
- **THEN** result 內容中的 credential 字串以橘色底色標示

#### Scenario: No false positives on normal text
- **WHEN** assistant text 或 tool_result 含有普通的英數字串但不符合任何 credential pattern
- **THEN** 不顯示任何 highlight

### Requirement: Proxy flow isolation
credential 掃描 SHALL 不修改任何送往 Anthropic 的 request 或 response 內容。

#### Scenario: Transparent proxy behavior
- **WHEN** credential 掃描偵測到 credential
- **THEN** 送往 Anthropic 的 body 與未啟用掃描時完全相同，proxy 延遲無顯著增加
