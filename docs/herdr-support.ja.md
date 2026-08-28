# ccxray for Herdr サポート

ccxray はライブプロキシの可観測性を Herdr に提供します。Herdr から Claude、Codex、Grok を起動し、agent pane の sidebar で compact な context／cost／health summary を確認できます。session、tool、turn の詳細は Mission Control または dashboard で確認できます。

[English](herdr-support.md) · [繁體中文](herdr-support.zh-TW.md) · [日本語](herdr-support.ja.md)

> 2026-08-24 時点で、このガイドは merge 済み parser baseline `d8176cc` と current `main` に対応しています。`server/helpers.js` は観測済みの `custom_tool_call` と `use_tool` の形を認識します。Provider ごとの caveat はサポート契約の一部であり、すべての provider への一般的な保証ではありません。

## 範囲と読み方

このガイドでは、次の 3 つのデータソースを分けます。

- **Live proxy**：リクエストが実際に ccxray を通ったときに取得できるデータ。
- **Herdr integration**：Herdr pane、badge、Mission Control、Notifications、launcher、任意の sidebar row。
- **Local transcript import**：`~/.claude` または `~/.codex*` から再構成する履歴データ。live proxy より情報が少なくなります。

まず **Quick judgment** で適合性を確認し、次に **Provider support matrix** で live parity を確認してください。履歴や診断シグナルが必要な場合は **Local transcript import** と **Weather and health** を読みます。wire reference は観測された field の証拠であり、provider 対応の保証ではありません。

[繁體中文ガイド](herdr-support.zh-TW.md) が support scope、confidence、limitation の normative semantic source です。English と Japanese は要約ではなく、この scope を完全に保つ翻訳です。

多言語レビューで契約を一致させるため、次の契約語彙は英語表記も残します：**Notifications**、**not linked**、**Weather**、**reversible**、**Context window**、**Reset time**、**source of truth**、**lower bound**、**duplicate**。

## サポート凡例

以下の凡例は、後続のすべての matrix に適用されます。

- **✅ 完全対応**：明確な source を持つ contractual または obs-stable な動作で、row の意味を変える既知の制限がありません。
- **△ 明確な制限付きで利用可能**：obs-fragile、regex／heuristic、provider-live-unverified、または既知の lower bound です。すべての △ row は同じ row 内で制限を説明し、[`wire-protocol-reference.md`](wire-protocol-reference.md) または関連 ADR／evidence にリンクします。
- **— 非対応または該当なし**：この範囲では provider または surface がその機能を提供しません。
- **❌ source が field を公開していない**：指定した local source にそのデータがありません。live observation がまだ到着していない場合とは異なります。

## Quick judgment

| 質問 | 回答 |
|---|---|
| Herdr から対応 Provider を起動できますか？ | はい。Claude、Codex、Grok に対応しています。 |
| 3 つすべてで live cost、context、session、badge を確認できますか？ | はい。ただし Provider ごとに意味と confidence が異なります。 |
| 機能 parity は完全ですか？ | いいえ。Intercept、cache breakdown、local import、quota window、pane identity に差があります。 |
| 他の CLI も自動的に対応しますか？ | いいえ。未知の launcher provider command は失敗します。ただし proxy を手動指定した third-party client は記録される場合があります。 |
| 要件は何ですか？ | macOS／Linux、Herdr 0.8 以降、Node.js 18 以降、対応済み agent CLI が少なくとも 1 つ必要です。 |

## Herdr integration が提供するもの

| Herdr surface | 契約 |
|---|---|
| Quick Start | ccxray、インストール済み CLI、要件を確認し、Provider 起動 action を提示します。 |
| Provider launcher | 新しい Herdr tab を作成し、選択した Provider を ccxray 経由にします。 |
| Sidebar badge | compact context bar、cost／age fact または 1 件の alert、`ready`／`not linked`／freshness を表示します。完全な model／cost card ではありません。 |
| Mission Control | Herdr agent と ccxray session を結び、attention 順、evidence confidence、dashboard link を表示します。 |
| Sidebar summary | 任意の width-aware Herdr state row と ccxray context／fact／alert row です。install/remove は **reversible** で、既存 table には ccxray row だけを追加し、削除時も ccxray row だけを削除します。plugin が作った table は全体を削除できます。 |
| Notifications | background pane が done または blocked になったとき通知できます。無効化、または blocked のみへの限定が可能です。 |
| Capability Footprint | MCP schema と MCP／skill 使用状況を観測します。5 件未満の適格な session では観測だけを表示し、候補提案は 5 件以上で experimental として行います。 |
| Doctor | Herdr runtime、ccxray command、hub、最近の usage、pane connection metadata を確認します。 |
| Dashboard | live entry の Miller dashboard、turn detail、timeline、system prompt、raw request／response を提供します。 |

[`server/providers.js`](../server/providers.js) の provider launcher registry が launcher の **source of truth** です。3 つの Herdr launch action は [`plugins/herdr/herdr-plugin.toml`](../plugins/herdr/herdr-plugin.toml) に宣言されています。plugin README は install／trust の source of truth、このガイドは support contract の source of truth です。

## Provider support matrix

### 起動、routing、identity

| 機能 | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| `ccxray <provider>` launcher | ✅ | ✅ | ✅ |
| Herdr Quick Start と新しい tab | ✅ | ✅ | ✅ |
| 共用 hub と dashboard | ✅ | ✅ | ✅ |
| Proxy route | Anthropic Messages | OpenAI Responses／ChatGPT | xAI Responses |
| Proxy auth | `X-Ccxray-Auth` header | API-key provider または ChatGPT OAuth native marker | CLI-native auth を proxy 経由で使用 |
| Pane identity | Anthropic custom header | Provider 固有の pane header なし。native session id または cwd fallback | Provider 固有の pane header なし。native session id または cwd fallback |
| Exact pane → session mapping | ✅ | △ native session id は exact。cwd fallback は曖昧または `not linked` になります（[ADR 0005](decisions/0005-agent-key-unreliable-shared-contract.md)） | △ native session id は exact。cwd fallback は曖昧または `not linked` になります（[ADR 0005](decisions/0005-agent-key-unreliable-shared-contract.md)） |

Codex は API-key と ChatGPT OAuth に対応します。Grok は共用の OpenAI Responses parser を使用し、xAI upstream、agent label、`grok-raw` session bucket は独自に持ちます。同じ workspace／cwd で複数の Codex または Grok pane を開き、Herdr が native session id を提供しない場合、ccxray は pane 単位の完全な attribution を保証せず、別 pane の telemetry を借りません。

### Live wire observability

| 機能 | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| HTTP request／response | ✅ | ✅ | ✅ |
| SSE streaming | ✅ | ✅ | ✅ |
| WebSocket | — | ✅ | △ 共用 OpenAI path ですが、Grok 固有の WebSocket acceptance は未検証です（[wire reference](wire-protocol-reference.md)） |
| Turn list／順序 | ✅ | ✅ | ✅ |
| Cost／model／timing | ✅ | ✅ | △ model と timing は観測できますが、cost は obs-fragile な offline floor に fallback します。利用できる場合は mirrored LiteLLM pricing が優先されます（[wire:168](wire-protocol-reference.md#L168)） |
| Session id | body metadata、socket／session inference fallback | header／metadata／thread id | `x-grok-session-id`／`x-grok-conv-id` |
| CWD／project | system prompt | metadata／header／instructions／fallback | user info／metadata／fallback |
| Main／subagent classification | △ prompt heuristic。未知の prompt variant は fallback します（[ADR 0005](decisions/0005-agent-key-unreliable-shared-contract.md)） | △ header／metadata／agent type の evidence と fallback を使います（[ADR 0005](decisions/0005-agent-key-unreliable-shared-contract.md)） | △ 共用 parser ですが、検証済みの Grok 固有 subagent signal はありません（[wire reference](wire-protocol-reference.md)） |
| Raw request／response detail | ✅ | ✅ | ✅ |
| TTFT／streaming timeline | ✅ | ✅ | ✅ |
| Startup／control-plane noise filtering | △ `count_tokens` は filter されますが、Claude path に同等の startup probe はありません（[wire reference](wire-protocol-reference.md)） | ✅ | ✅ |

Codex WebSocket の一部の大きな envelope は compact timing anchor として保存されるため、個別 turn の raw detail は Claude と同じ完全性とは限りません。Grok の title-generation attribution は best-effort で、cwd のない raw title session は project sidebar に表示されない場合があります。wire reference に field の出所と confidence tag を記録しています。

### Token、cost、Context window の provenance

| 機能 | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| Input／output token | ✅ | ✅ | ✅ |
| Cache read | ✅ | ✅ | ✅ |
| Cache creation | ✅ | — | — |
| Cache 5m／1h breakdown | △ wire field pair `usage.cache_creation.ephemeral_5m_input_tokens`／`usage.cache_creation.ephemeral_1h_input_tokens` は observation-dependent な `obs-fragile` です。両方の field が実際に観測された場合だけ breakdown として扱います（[wire reference](wire-protocol-reference.md)）。 | — | — |
| Aggregate cost confidence | ✅ | ✅ | ✅ |
| Context window provenance | △ 通常は 200K。1M は観測された `context-1m-2025-08-07`／`[1m]` evidence が必要で、API maximum では決まりません（[wire reference](wire-protocol-reference.md)、[ADR 0013](decisions/0013-beta1m-persist-session-window-derive.md)） | △ model／usage evidence から導出し、Claude の 200K／1M ルールは適用しません（[wire reference](wire-protocol-reference.md)） | △ model／usage evidence から導出し、Claude／Codex の window ルールは移植できません（[wire reference](wire-protocol-reference.md)） |
| Dashboard context percentage | ✅ | ✅ | ✅ |
| Sidebar badge Context window／ctx% provenance | △ badge は selected-session value を表示しますが、dashboard denominator の provenance を持ちません（[ADR 0013](decisions/0013-beta1m-persist-session-window-derive.md)） | △ 同じ制限で、dashboard denominator evidence を表示しません（[ADR 0013](decisions/0013-beta1m-persist-session-window-derive.md)） | △ model／usage evidence は dashboard denominator の citation ではありません（[ADR 0013](decisions/0013-beta1m-persist-session-window-derive.md)） |
| Provider-native usage detail | Anthropic cache fields | OpenAI input／output details | Grok response に依存 |

OpenAI の cached input は cache-read に正規化され、Claude の ephemeral cache-create breakdown には相当しません。LiteLLM `max_input_tokens` は API capability hint であり、session Context window の denominator ではありません。永続化された `ctxBeta` と `beta1m` の解釈は意図的に異なる場合があります。wire reference と ADR 0013 を参照してください。

Herdr plugin は `public/format.js` が利用できる場合、共有の aggregate-cost confidence fold を使います。helper がない degraded install では、数値を unmarked のまま表示し、`—`（価格データなし）または `+`（既知の lower bound）だけを残します。worst-of `~` は使いません。これは degraded display であり、数値が完全に校正済みという意味ではありません（[ADR 0017](decisions/0017-aggregate-cost-confidence.md)）。

### Sidebar context trend の契約

Sidebar の context trend は固定幅の refresh-driven viewport です。幅を
`herdr pane layout` から取得する場合、plugin は Herdr 固有の 4 セル分の
Sidebar chrome を先に差し引いて custom token を計算します。これにより scalar が
実際の row 内に残り、Herdr の truncation で消えません。時間は左から右へ進み、
最新の sample は常に右端に置かれます。アニメーションは行いません。
scalar percentage には固定の右寄せ slot があるため、`9%` から `100%` に変わっても
chart endpoint は移動しません。

```
older ------------------------------------------------------> newest
[░][░][▂][▃][▆][░] [  ?]
 ^ 不足している履歴       ^ 最新が unknown   固定 scalar slot
```

`░`（U+2591 LIGHT SHADE）は有効な sample がない chart cell を表し、0 では
ありません。古い有効な履歴がある状態で最新 turn の context usage が unknown
なら、古い履歴を残して右端を `░`、scalar を `?` にします。有効な context
履歴が一つもない場合は `?` だけを表示します。明示的な context-input usage 0% は
有効な履歴として最低 block を表示しますが、usage がない場合や output usage
だけの場合は unknown です。active context band の色を使い、stale または
denominator が不確かな場合は neutral 色を維持します。永続化 provenance と
legacy policy は [ADR 0020](decisions/0020-herdr-fixed-context-trend.md) に定義します。Startup refresh は Herdr の native working 状態から bounded refresh loop も開始し、token TTL の前に working pane の metadata を更新します。

### Tool、MCP attribution、thinking、prompt

| 機能 | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| Tool call count | ✅ | △ 認識できる call は数えますが、gateway／unknown shape と plugin tail により lower bound になる場合があります（[wire reference](wire-protocol-reference.md)） | △ 認識できる call は数えますが、gateway／unknown shape と plugin tail により lower bound になる場合があります（[wire reference](wire-protocol-reference.md)） |
| MCP tool-name attribution | ✅ | △ 既知の `custom_tool_call` の `exec` input を解析します。他の OpenAI-wire shape では外側の name だけになる場合があります（[wire reference](wire-protocol-reference.md)） | △ 既知の `use_tool.arguments.tool_name` を解析します。他の gateway shape では外側の name だけになる場合があります（[wire reference](wire-protocol-reference.md)） |
| Tool result detail | ✅ | △ 必要な result field を公開する response item は一部だけです（[wire reference](wire-protocol-reference.md)） | △ response event がどの情報を送るかに依存します（[wire reference](wire-protocol-reference.md)） |
| Tool-failure signal | △ 複数の data path に制限があり、eligible かつ paired の evidence だけを数えます（[wire reference](wire-protocol-reference.md)） | △ unknown または decode できない result combination は unknown のままです（[wire reference](wire-protocol-reference.md)） | △ unknown または decode できない result combination は unknown のままです（[wire reference](wire-protocol-reference.md)） |
| Thinking／reasoning timeline | ✅ thinking blocks | ✅ reasoning events | △ Grok が対応する event を送るかどうかに依存します（[wire reference](wire-protocol-reference.md)） |
| System prompt／instructions capture | ✅ | ✅ | ✅ |
| Prompt version／hash／diff | ✅ | ✅ | ✅ |
| `skillCalls` 統計 | ✅ | — | — |

merge 済み baseline `d8176cc` は、観測済みの parser shape である Codex `custom_tool_call` item、`exec` JavaScript input に埋め込まれた MCP name、Grok `use_tool` の `arguments.tool_name` をカバーします。live smoke の例は Codex `toolCalls: {mcp__node_repl__js: 1, Bash: 1}` と Grok `{github__pull_request_read: 1}` です。これは将来のすべての provider event で完全な count が保証されるという意味ではありません。

### Dashboard と control

| 機能 | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| Miller dashboard | ✅ | ✅ | ✅ |
| Timeline renderer | ✅ | ✅ | ✅ |
| Tool detail | ✅ | △ response-item coverage に制限があります（[wire reference](wire-protocol-reference.md)） | △ response-event coverage に制限があります（[wire reference](wire-protocol-reference.md)） |
| System Prompt tab（live wire） | ✅ | ✅ | ✅ |
| Request／Response tab（live wire） | ✅ | ✅ | ✅ |
| Session title | ✅ | ✅ | △ title-generation attribution は best-effort です（[wire reference](wire-protocol-reference.md)） |
| Resume command | ✅ `claude --resume` | △ 利用可能な local／session usage evidence が必要です（[import matrix](import-provider-support.md)） | △ usage が必要で、live-verified ではありません（[wire reference](wire-protocol-reference.md)） |
| Intercept／edit request | ✅ | △ request は hold できますが、editor は Codex WebSocket 専用ではありません（[wire reference](wire-protocol-reference.md)） | △ request は hold できますが、editor は Grok Responses body に対応しません（[wire reference](wire-protocol-reference.md)） |
| Mission Control／Herdr badge | ✅ | ✅ | ✅ |

Intercept の session arm と request hold は Provider 固有ではありません。ただし完全に edit できる dashboard editor は Anthropic Messages body 用です。Codex WebSocket や Grok Responses を hold できても、同等の edit support を意味しません。

### Quota と account usage

ここが唯一の quota matrix です。token table にあった重複した quota-card row は削除しました。

| 機能 | Claude | Codex | Grok |
|---|:---:|:---:|:---:|
| Account card | △ `ccxray setup-statusline` で `rate_limits` を書き込む必要があります（[import matrix](import-provider-support.md)） | ✅ | ✅ |
| 複数 account／alias | ✅ | ✅ `.codex-*` | △ live billing は現在 `default` alias に書き込みます（[wire reference](wire-protocol-reference.md)） |
| 5-hour window | ✅ | ✅ | — |
| 7-day／weekly window | ✅ | ✅ | ✅ weekly pool |
| Reset time | ✅ | ✅ | △ upstream が field を返す場合だけ表示します。field がなければ reset time を主張しません（[wire reference](wire-protocol-reference.md)） |
| Provider-native quota semantics | statusline `rate_limits`、Anthropic header samples、plan | Codex rate-limit events、transcript | Grok billing credits／Weekly SuperGrok Limit |

Grok の account card は Weekly SuperGrok Limit を表し、Claude／Codex の 5-hour quota ではありません。そのため percentage を Provider 間で直接比較できません。Claude の quota card は proxy traffic だけでは表示されず、`ccxray setup-statusline` が必要です。Grok adapter は alias field を保持しますが、live billing path は複数 credential の alias 分離をまだ提供しません。

## Local transcript import

Live proxy data が最も完全な source です。local importer は Claude Code と Codex の transcript format を読み、Grok には外部 local transcript importer がありません。

| 機能 | Claude Code local | Codex local | Grok local |
|---|:---:|:---:|:---:|
| Turn list／順序 | ✅ | ✅ | — |
| Cost／model／timing | ✅ | ✅ | — |
| Session／cwd／project | ✅ | ✅ | — |
| Context percentage | ✅ aggregate のみ。system／tools の分解なし | ❌ | — |
| Thinking blocks | ✅ | ❌ | — |
| Tool use／result | ✅ | △ 一部の response item のみです（[import matrix](import-provider-support.md)） | — |
| Cache breakdown | ✅ | ❌ | — |
| stop reason | ✅ | ❌ | — |
| Conversation branching | ✅ `parentUuid` | ❌ | — |
| Error／retry events | ✅ | ❌ | — |
| Raw request／response | ❌ | ❌ | — |
| TTFT／streaming timeline | ❌ | ❌ | — |
| Rate-limit headers | ❌ | ❌ | — |

Grok usage は local transcript ではなく ccxray 自身の `index.ndjson` と Grok billing endpoint から取得します。import された entry は `importSource` を保持しますが、frontend は利用できない全 tab を明示的な説明に変換していないため、空の tab が残る場合があります。

Import と live proxy の record が同じ turn を表す場合があります。index／session merge の前に、Mission Control が **duplicate import×proxy turn** を表示することがあります。これは既知の integration limitation であり、provider が 2 つの turn を送ったという意味ではありません（[ADR 0012](decisions/0012-response-id-read-time-merge.md)）。

## Weather and health

**Weather** の計算は保存されますが、tool-failure signal の修正中は dashboard 表示が**デフォルトでオフ**です。明示的に確認する場合は [`docs/weather.md`](weather.md) の toggle を使用してください。

- Context pressure、compaction、truncation、latency は Provider をまたいで評価できますが、証拠の強さは同じではありません。
- `cache_health` は provider が明示的に Anthropic の entry にだけ適用されます。provider のない legacy entry は互換 path により Anthropic として扱われる場合があります。
- Tool-failure Weather は eligible かつ paired の process／shell evidence だけを使用します。decode できない eligible result は unknown のまま known-rate を下げ、response status だけから failure を推測しません（[wire reference](wire-protocol-reference.md)）。
- Weather は quota field ではありません。provider-neutral badge が健康そうに見えても、provider parity が完全とは限りません。

## 既知の制限

- Plugin の対応 platform は macOS／Linux です。Windows の hub mode は Unix socket を必要とするため、対応 target ではありません。
- 保証される launcher は Claude、Codex、Grok の 3 つだけです。他の provider command に automatic fallback はありません。
- Provider-neutral の Herdr badge は、cache、quota、reasoning、Context window、local-import data が同一であることを意味しません。
- `not linked` は pane identity／session evidence が不足している状態です。plugin は green state を表示するために別 session の telemetry を借りません。
- Notifications は便利な signal です。done／blocked transition は pane ごとに deduplicate され、無効化できますが、provider outcome ではありません。
- Sidebar の install は明示的な同意が必要で **reversible** ですが、action を選ぶと Herdr configuration は変更されます。user-owned table と ccxray 以外の row は保持されます。
- Capability Footprint は experimental です。観測された MCP／skill 使用だけを示し、task success を推測せず、outcome impact は unknown のままです。
- Codex／Grok の MCP name は gateway tool に包まれる場合があります。baseline は既知の `exec`／`use_tool` shape を扱いますが、未知または変更された gateway event では外側の name だけになる場合があります（[wire reference](wire-protocol-reference.md)）。
- Codex／Grok の tool count は **lower bound** になる場合があります。parser は defensive で、将来の gateway event が unknown になる可能性があり、badge は最大 4 MiB の index tail だけを読みます。tail-based cost／turn summary は sample で、完全な履歴合計ではありません。
- local import と live proxy の evidence が merge される前は、Mission Control に duplicate import×proxy turn が表示される場合があります。
- Sidebar badge の ctx% には dashboard denominator provenance がありません。badge の selected-session value は表示しますが、dashboard denominator の citation ではありません（[ADR 0013](decisions/0013-beta1m-persist-session-window-derive.md)）。context trend 自体は固定幅で右端が最新であり、`░` は unknown sample で 0 ではありません（[ADR 0020](decisions/0020-herdr-fixed-context-trend.md)）。
- shared `public/format.js` がない degraded aggregate cost は意図的に unmarked で、`—`／`+` だけを残します。校正済みの完全な total ではなく、却下された worst-of `~` marker も使用しません（[ADR 0017](decisions/0017-aggregate-cost-confidence.md)）。
- Codex は引き続き Beta 表記です。Grok の title-generation と non-main session attribution には conditional edge case があり、Grok の `Reset time` は upstream field がある場合に限られます。

## 検証と source references

2026-08-24 の workspace live smoke は Codex `toolCalls: {mcp__node_repl__js: 1, Bash: 1}` と Grok `toolCalls: {github__pull_request_read: 1}` を記録しました。PR #585 は `d8176cc` として `main` に merge 済みです。これらは指定した parser shape の evidence であり、将来のすべての provider version の保証ではありません。

- [`plugins/herdr/README.md`](../plugins/herdr/README.md)：install、操作、trust disclosure、local-data scope、uninstall。
- [`docs/grok-testing.md`](grok-testing.md)：Grok の unit、proxy e2e、browser、live acceptance evidence。
- [`docs/import-provider-support.md`](import-provider-support.md)：local transcript import の source matrix と caveat。
- [`docs/normalization-map.md`](normalization-map.md)：wire parser から canonical model への field mapping。
- [`docs/wire-protocol-reference.md`](wire-protocol-reference.md)：観測 wire field、version、confidence tag、`custom_tool_call`／`use_tool` evidence。provider-support guarantee ではありません。
- [`docs/weather.md`](weather.md)：Weather の導出と default-off 表示。
- [`server/providers.js`](../server/providers.js)：launcher と OpenAI-wire client registry の source of truth。
- [`plugins/herdr/herdr-plugin.toml`](../plugins/herdr/herdr-plugin.toml)：Herdr action／manifest の source of truth。
- [`docs/decisions/0005-agent-key-unreliable-shared-contract.md`](decisions/0005-agent-key-unreliable-shared-contract.md)：identity fallback と badge classification の制限。
- [`docs/decisions/0013-beta1m-persist-session-window-derive.md`](decisions/0013-beta1m-persist-session-window-derive.md)：Context window denominator provenance。
- [`docs/decisions/0017-aggregate-cost-confidence.md`](decisions/0017-aggregate-cost-confidence.md)：aggregate cost confidence と degraded plugin wording。
- [`docs/decisions/0020-herdr-fixed-context-trend.md`](decisions/0020-herdr-fixed-context-trend.md)：固定幅 context trend、usage provenance、legacy policy。
