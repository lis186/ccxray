# ccxray

[English](README.md) | [正體中文](README.zh-TW.md) | **日本語**

AIエージェントセッションのX線ビュー。ゼロ設定のHTTPプロキシで、Claude Code・Codexと上流API間のすべての呼び出しを記録し、ワークフロータイムラインとリアルタイムダッシュボードでエージェント内部の動きを可視化します。

![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)
[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge-flat.svg)](https://github.com/hesreallyhim/awesome-claude-code)

![ccxrayダッシュボード](https://raw.githubusercontent.com/lis186/ccxray/v2.5.0-rc.1/docs/dashboard-v2.png)

## なぜ必要か

Claude Codeはブラックボックスです。以下が見えません：
- どんなシステムプロンプトを送信しているか（バージョン間の変更も含む）
- 各ツール呼び出しのコスト
- なぜ30秒も思考しているのか
- 200Kトークンのコンテキストウィンドウを何が消費しているのか

ccxrayはそれをガラス箱に変えます。

## クイックスタート

```bash
npx ccxray claude
# または
npx ccxray codex
# または
npx ccxray grok
```

プロキシが起動し、選択した CLI がプロキシ経由で実行され、ダッシュボードも自動で開きます。macOS と Linux では `--port` を指定しない agent launch が一つの hub とダッシュボードを共有します。Windows では起動ごとに独立サーバーが動作します。下の例を参照してください。

ccxray が proxy を読み込めない、または hub に接続できない場合、agent を直接起動し、その session は記録されません。hub 接続の予算時間はデフォルトで 3000 ms です。未解決の接続は時間切れで fallback し、それより前に失敗すれば早く fallback します。`CCXRAY_ATTACH_TIMEOUT_MS` で予算時間を変更できます。ccxray は `<CCXRAY_HOME>/fail-open.log`（デフォルトは `~/.ccxray/fail-open.log`）への記録を試みますが、書き込みは best effort で失敗することもあります。`CCXRAY_FAIL_CLOSED=1` を設定すると、fallback せずに起動を停止します。Claude の `--bg` / `--background` launch は仕様上 proxy を通りません。

Claude の shell wrapper を設定して継続利用する場合（ローカル記録のみ）：

```bash
npm install -g ccxray
ccxray setup
# 新しいターミナルを開く（または shell profile を再読み込み）し、設定を確認：
ccxray setup --check
```

`ccxray setup` だけでは出力設定を書き込まず、bucket・domains・gcloud 認証情報も不要です。GCS へのサマリー出力は `--export` で明示的に有効にします。使用前に Claude Code をインストールし、ログイン済みアカウントのメールアドレスを ccxray が取得できることを確認してください。`--domains` のリストにはそのアカウントのドメインを含めます。出力の設定には読み取り可能な gcloud Application Default Credentials も必要です。先に `gcloud auth application-default login` を実行してください。exporter 自体は service-account key file に対応していますが、setup は `CCXRAY_EXPORT_GCS_KEY_FILE` を拒否します。

```bash
gcloud auth application-default login
ccxray setup --export --bucket "<bucket>" --domains example.com --cwd-allowlist "project-a,project-b" --retention-days 30
```

すでに出力が有効なインストール（2.x で設定）は、`--export` なしで `ccxray setup` を再実行しても出力を続けます。setup はその旨を 1 行表示します。

`setup` は shell profile に Claude wrapper（`--export` 指定時は出力設定も）を追加し、ログ保持期間を設定して `CCXRAY_IMPORT_DISABLE=1` を書き込みます。Codex wrapper は追加しません。`ccxray setup --dry-run`（同じ setup オプションを指定）で変更をプレビューできます。`ccxray setup --remove` は ccxray が書き込んだ shell block を削除して tombstone を書き、今後のアップロードを停止します。ローカルログやアップロード済みサマリーは削除しません。詳細は[エクスポート設定ガイド](docs/export-onboarding.md)を参照してください。

launcher の引数は provider registry で管理されています。現在 `claude`・`codex`・`grok` に対応。未知の provider コマンドは即座に失敗し、未設定のプロキシが静かに起動することはありません。

### Herdr プラグイン

Herdr 内で ccxray セッションを実行し、サイドバーの context、cost、health、Mission Control、dashboard を利用できます。

```bash
herdr plugin install lis186/ccxray/plugins/herdr
herdr plugin action invoke ccxray.herdr.quick-start
```

2 つ目のコマンドは、すでに起動している Herdr へのインストールでは startup hook が実行されないため、カーソル操作できる Quick Start をすぐに開きます。矢印キーまたは `j`/`k` で移動し、`Enter` で実行してください。数字と文字のショートカットも利用できます。オンボーディングが未完了なら、次回の完全な Herdr 起動時にも Quick Start を一度提供します。インストール済みの provider を検出して最初の traced session を起動します。サイドバーの変更は任意で、明示的な同意が必要な可逆操作です。最初の traced session 後に Mission Control が、十分なサンプルが集まった後に experimental の Capability Footprint が利用できます。インストール、信頼、更新、アンインストールは [Herdr プラグインガイド](https://github.com/lis186/ccxray/blob/v2.5.0-rc.1/plugins/herdr/README.md)を、Provider ごとの機能マトリクスと制限は [Herdr サポートガイド](https://github.com/lis186/ccxray/blob/v2.5.0-rc.1/docs/herdr-support.ja.md)を参照してください。

### その他の実行方法

```bash
ccxray                           # プロキシ + ダッシュボードのみ
ccxray claude --continue         # provider に渡す引数の例
ccxray codex exec "hello"        # provider に渡す引数の例
ccxray grok -p "hello"           # provider に渡す引数の例
ccxray --port 8080 claude        # カスタムポート（独立モード、hub共有なし）
ccxray claude --no-browser       # ブラウザの自動オープンをスキップ
ccxray status                    # process、出力、home、hubの状態を表示
ccxray --port 5602 status        # hub lock が見つからない場合に 5602 番ポートを確認
ANTHROPIC_BASE_URL=http://localhost:5577 claude   # 既存の claude セッションを実行中の ccxray hub に向ける
```

hub と standalone の違い、プロキシを動かし続ける方法、ccxray 経由で起動しないエージェントをプロキシに向ける方法は [Running ccxray](docs/running-ccxray.md)（英語）を参照してください。

provider の引数は各 CLI に渡されます。`--port` や `--no-browser` など ccxray が認識する global flag は、引数列のどこにあっても ccxray が処理し、CLI には渡しません。

### マルチプロジェクト

macOS と Linux では、複数のターミナルで `ccxray claude` を実行すると、設定なしで単一のプロキシとダッシュボードを共有します。Windows は共有 hub を使わず、起動ごとに独立したサーバーが動くため、それぞれに別のポートが必要です。

```bash
# Terminal 1
cd ~/project-a && ccxray claude     # hubを起動 + claude

# Terminal 2
cd ~/project-b && ccxray claude     # 既存のhubに接続

# 両プロジェクトが http://localhost:5577 のダッシュボードに表示
```

macOS または Linux で hub プロセスがクラッシュした場合、接続中のクライアントは数秒以内に自動復旧します。Windows では起動ごとに別のポートを指定してください：

```powershell
# Terminal 1
ccxray --port 5577 claude

# Terminal 2
ccxray --port 5578 claude
```

`http://localhost:5577` と `http://localhost:5578` を開くと、それぞれの独立したダッシュボードを確認できます。

```bash
$ ccxray status
Hub: http://localhost:5577 (pid 12345, uptime 3600s, v<version>)
Process: exportState=enabled ... identity={...}
Home: ~/.ccxray — current — cursor has consumed through the index tail (...)
Machine: {"proxy":true,"hub":true,"pid":12345,"port":5577,"occupant":"ccxray-hub"}
Connected clients (2):
  [1] pid 23456 — ~/dev/project-a
  [2] pid 34567 — ~/dev/project-b
Shell: exportState=enabled hash=... — this shell's environment, not what the running exporter uses
Config: equal
Durable: ~/.ccxray (named by hub) — enrollment=enrolled · cursor ... · last attempt ...
```

`Process`、`Home`、`Shell`、`Config`、`Durable` の各行は、実行中の process、本機の出力状態、この shell の設定、永続化された enrollment/cursor の履歴を表示します。`--port` を使うと独立サーバーとして実行できます。

## 対応エージェントモジュール

launcher は `server/providers.js` に登録されています（すべて同じ hub + ダッシュボードを共有）：

| コマンド | Wire ファミリー | 上流（デフォルト） |
|---------|-------------|--------------------|
| `ccxray claude` | Anthropic Messages | `api.anthropic.com` |
| `ccxray codex` | OpenAI Responses | `api.openai.com` / ChatGPT |
| `ccxray grok` | OpenAI Responses（クライアントモジュール） | `cli-chat-proxy.grok.com`（`XAI_BASE_URL` で上書き可） |

Codex 以外の OpenAI-wire クライアント（現在は Grok）は `OPENAI_WIRE_CLIENTS` に登録されます — 共通パーサー、個別の host/agent/raw-session バケット。マルチエージェント hub では `OPENAI_BASE_URL` を切り替えることなく混在できます。受け入れテストの記録：[Grok テスト](https://github.com/lis186/ccxray/blob/v2.5.0-rc.1/docs/grok-testing.md)。

**Grok の課金情報開示：** Grok CLI のトラフィックをプロキシする際、ccxray は `cli-chat-proxy.grok.com/v1/billing` を呼び出し（CLI がすでにプロキシ経由で送信しているのと同じ auth token を使用）、Usage タブのアカウントカードを表示します。成功レスポンスの後 60 秒間は再呼び出しを抑制します（alias+credential ごと）。`XAI_BASE_URL` を設定すると呼び出し先ホストを変更できます。

## Codex サポート（Beta）

```bash
npx ccxray codex
```

API キーのセッションはサポートされています。**2.5.0-rc.3 で既知の非対応：** Codex 0.159.2 と 0.163.0 の ChatGPT ログインセッションは、ローカル HTTP プロキシ経由の workspace-routing bootstrap に失敗します（[#671](https://github.com/lis186/ccxray/issues/671)）。これらのセッションでは ccxray の base-URL 上書きを使わずに Codex を直接実行してください。discovery パスの不一致と HTTPS-origin の制約については[調査記録](docs/codex-workspace-routing.md)を参照してください。

互換性のある ChatGPT クライアントでは、`chatgpt-account-id` ヘッダーがあると `chatgpt.com/backend-api/codex` へルーティングされます。codex 起動時のプラットフォームポーリング（プラグイン一覧、コネクタディレクトリ、アプリメタデータ）はプロキシされますがダッシュボードには表示されず、タイムラインには会話トラフィックのみが表示されます。

**Beta の注意事項：**
- WebSocket トランスポート（`/v1/responses` のアップグレード）はフレームごとにデコードされます：各 codex ターンは model、トークン使用量、リクエストの instructions/input/tools、レスポンスイベントを記録します。一部の大きなエンベロープイベントは完全なペイロードではなくコンパクトなタイミングアンカー（TTFT 用）として保存されるため、codex ターンの詳細度は部分的に Claude ターンに及ばないことがあります。
- Claude パスと比較して実運用でのテストが限定的です。

チューニング用の環境変数：`OPENAI_BASE_URL`、`CHATGPT_BASE_URL`、`CCXRAY_WS_IDLE_TIMEOUT_MS`、`CCXRAY_WS_MAX_QUEUE_BYTES`。詳細は [CLAUDE.md](https://github.com/lis186/ccxray/blob/v2.5.0-rc.1/CLAUDE.md) を参照。

問題は [GitHub](https://github.com/lis186/ccxray/issues) へ — Beta とは、粗削りな部分の報告を歓迎するという意味です。

## 機能

### ワークフロータイムライン

エージェントの思考プロセスと並行構造をリアルタイムで観察。

**ターンカード**：各ターンは5行カードとして表示 — コスト、キャッシュ温度（ターン間のギャップ時間付きでキャッシュミスを即座に検出）、ツール失敗リスクシグナル、`hit:0%` の赤警告、ツール一覧をタイトル上に配置。カードを一枚も展開することなく、セッション全体の健全性を一望できます。

**レーン可視化**：マルチエージェントセッションは自動的に並行レーンに分割されます — orchestrator はメインレーン、サブエージェントは Fork / Teammate レーンとして表示。各レーンは WCAG ≥3:1 コントラスト準拠の個別カラーを持ち、混合モデルラベルに対応。Sequential-interleave tracker が同一会話内のターンの順次/並行を識別します。

**鳥瞰モード**：birdseye overview に切り替えると、overview エリアがビューポートの約 80% に拡大。拡大版ミニマップとレンジサマリーで長いセッションの全体像を把握できます。

**L1/L2 二層選択**：Tab / ▲▼ でレーン選択（L1）、j/k でレーン内のターン選択（L2）、Esc で段階的に戻る。従来の単層クリックモデルを置き換えます。

![ワークフロータイムライン](https://raw.githubusercontent.com/lis186/ccxray/v2.5.0-rc.1/docs/timeline-v2.png)

### 使用量とコスト

実際の支出を把握。消費レート、アカウント別の Claude・Codex レート制限カード — トークンの行き先を正確に把握できます。

![使用量分析](https://raw.githubusercontent.com/lis186/ccxray/v2.5.0-rc.1/docs/usage.png)

### システムプロンプト追跡

バージョンの自動検出とdiffビューア。複数の認識されたエージェントタイプのプロンプトを閲覧し、更新ごとの変更点を正確に把握できます。不確定なものは `unknown` として正直に表示します。

![システムプロンプト追跡](https://raw.githubusercontent.com/lis186/ccxray/v2.5.0-rc.1/docs/system-prompt-v2.png)

### キーボード操作

ダッシュボード全体をキーボードで操作可能。すべての画面下部に文脈対応のヒントバーが表示され、現在有効なショートカットが移動に合わせてリアルタイムで更新されます。`?` で完全なチートシートを展開。projects → sessions → timeline → 個別の diff hunk まで、マウスに触れずにナビゲート。

**ワークフローナビゲーション**：Tab / ▲▼ でレーン間を切替（L1 選択）、j/k でレーン内のターン間を切替（L2 選択）、Esc で段階的に上位レイヤーへ戻る。

**ステップタイプジャンプ**：`e`/`E` で次/前のエラーへ、`s`/`S` で Skill 呼び出しへ、`a`/`A` で subagent（Agent/Task）呼び出しへ、`m`/`M` で MCP ツール呼び出しへ。各ジャンプは位置対応で、現在位置から前後に最も近い一致ステップを見つけ、アドレスバーの URL を更新します。

`n`/`N` はダッシュボード全体でスター付きアイテムの次/前へジャンプします — プロジェクト、セッション、ターン、タイムラインの個別ステップを横断して移動できます。コマンドバーは現在のビューからスター付きアイテムに到達できる場合のみこのショートカットを表示します。

![キーボード操作](https://raw.githubusercontent.com/lis186/ccxray/v2.5.0-rc.1/docs/keyboard-v2.png)

### セッションタイトルとキャッシュアラート

セッションカードに Claude Code が自動生成したタイトル（例：`Fix login button on mobile`）とリアルタイムのキャッシュ TTL カウントダウン（`cache 4m left`）が表示され、1 分を切ると赤く点滅します。いずれかのセッションが期限に近づくと、ブラウザのタブタイトルが `ccxray` と `⚠ ccxray` の間で交互に切り替わります。オプトインのブラウザ通知はプラン対応のリードタイムで発火します — Max は 5 分前、Pro/API キーは 60 秒前。ダイレクト API トラフィックや進行中のセッションは短いハッシュにフォールバックします。

![セッションタイトルとキャッシュアラート](https://raw.githubusercontent.com/lis186/ccxray/v2.5.0-rc.1/docs/cache-expiry.png)

### セッション天気

各セッションカードに天気絵文字（☀️ 晴れ → ⛈️ 嵐）が表示され、コンテキスト圧力、コンパクション、出力の切り詰め、レイテンシドリフト、キャッシュヒット率に基づいてスコアを示します。ツール結果の証拠が不足すると、状態が unavailable になる場合もあります。ホバーで内訳を表示。詳細は[天気機能ガイド](https://github.com/lis186/ccxray/blob/v2.5.0-rc.1/docs/weather.md)を参照してください。

> **注意（2.3.1）：** ツール失敗シグナルの修正中のため、天気表示は**デフォルトでオフ**です。計算はバックグラウンドで継続しています。ダッシュボード URL に `?weather=on` を追加して一時的に確認するか、コンソールで `localStorage.setItem('ccxray-weather-display', 'on')` を実行して永続化できます。詳細は[天気機能ガイド](https://github.com/lis186/ccxray/blob/v2.5.0-rc.1/docs/weather.md#display-toggle-231)を参照してください。

### プラン自動検出

ccxray は Anthropic の `cache_creation` 使用量フィールドを読み取り、設定不要でサブスクリプションプラン（Pro、Max 5x、Max 20x）を自動検出します。キャッシュ TTL とクォータしきい値は検出されたプランを使用します。自動検出が誤っている場合は `CCXRAY_PLAN` で上書きできます。

### アカウント別レート制限

同一ダッシュボード上で、すべての Claude および Codex アカウントの 5 時間・週間クォータ使用量を確認できます。`~/.codex-*/sessions/` を自動検出してマルチアカウント Codex 構成をサポートし、`ccxray setup-statusline` で Claude ステータスラインデータを読み取ります。Business/unlimited Codex プランは `∞ Unlimited` と表示されます。データは 30 秒ごとにバックグラウンドで非同期更新され、プロキシをブロックしません。

### リクエストの傍受と編集

リクエストが Anthropic に到達する前に一時停止できます。セッションで傍受を有効にすると、Claude Code からの次のリクエストはダッシュボードで保留されます — システムプロンプト、メッセージ、ツール、サンプリングパラメータをその場で編集してから、承認（編集後の内容を転送）するか拒否（Claude Code にエラーを返す）するかを選びます。プロンプトエンジニアリング、危険なツール呼び出しのサンドボックス化、エージェントを分岐させずに実験を行いたい場面に便利です。

### Context HUD

オプションのコンテキスト統計フッターを Claude Code 内の Claude の応答末尾に追加できます: `📊 Context: 28% (290k/1M) | 1k in + 800 out | Cache 99% hit | $0.15`。デフォルトで有効。ダッシュボードのトップバーから切り替え可能です。

**なぜ切り替えが必要なのか?** 親エージェントが Agent / Task ツール経由で sub-agent を呼び出す場合、追加されるブロックが sub-agent の応答を親エージェントに返る前に切り詰めてしまい、マルチエージェントワークフローでデータが静かに失われる可能性があります。sub-agent を多用するセッションでは HUD を無効にしてください。状態は `~/.ccxray/settings.json` に保存されます。

### ずっと残すための Star

turn、session、または project カードにある star をクリックすると、永久的な retention としてマークされます。star が付いたアイテムは `LOG_RETENTION_DAYS` による自動 prune を生き残ります;状態はサーバー側の `~/.ccxray/settings.json` に保存され、ブラウザをまたいで永続化されます。star が付いた turn はその session 内のすべての turn を保護します;star が付いた session はその配下にあるすべての turn を保護します;star が付いた project はその配下にあるすべてを保護します。キャッチオールな bucket(`direct-api`、`(unknown)`、`(quota-check)`)は bucket レベルでの star を受け付けません — 代わりに内部の個別の turn に star を付けてください。

タイムラインの個別ステップにも star を付けられます（各ステップ行に `★`/`☆` トグル）。star が付いたステップは、直接 turn に star を付けた場合と同様に、その親 turn と session を保護します。

親要素が star の付いた子孫要素から保護を継承している場合、badge は `★` ではなく `☆ [N]` になります。chip をクリックすると、どの要素によって retention されているかを正確にリスト表示する popover が開きます。各行の star は独立したトグルになっており、行の本体をクリックすると、その turn / session へ直接移動します。

![スター保持と子孫ポップオーバー](https://raw.githubusercontent.com/lis186/ccxray/v2.5.0-rc.1/docs/stars.png)

### 使用量分析 CLI

```bash
ccxray usage                          # 人間が読めるサマリー
ccxray usage --json                   # エージェント向け JSON 出力 (< 4KB)
ccxray usage --last 7d                # 直近 7 日間（d/h/m 対応）
ccxray usage --cwd myproject          # ディレクトリ名の部分一致でスマート検索
ccxray usage --cwd ~/code/app         # 絶対パスまたは ~ パス → サブツリー前方一致
ccxray usage --cwd proj-a,proj-b      # 複数プロジェクト → 比較テーブル
ccxray usage --session latest         # 最新セッション
ccxray usage --session costliest      # 最高コストセッション
ccxray usage --session "fix login"    # セッションタイトルで検索
ccxray usage --session 950432         # UUID 前方一致
ccxray usage --session costliest --open  # ダッシュボードで該当セッションを開く
ccxray usage --tools                  # 全ツール呼び出しの内訳
```

0.6 秒で自動使用量分析 — ログを手動で掘らなくても、トークンとコストの行き先が分かります。`index.ndjson` を直接読み取り、サーバー起動不要。モデル別コスト、ツール・スキル使用量、プロンプトハッシュ安定性（system/tools/core プロンプトのターン間変化頻度）、ターン間隔別キャッシュヒット率、コスト上位 10 セッション（タイトル付き）を表示します。

`--json` 出力はエージェント向けの契約です — フィールドごとの完全なスキーマ、multi-cwd とエラー時の出力形状、フィルタのセマンティクスは [`docs/usage.md`](docs/usage.md) を参照してください。

### agentflow レポート（実験的）

```bash
ccxray agentflow report              # プロジェクトの agentflow notebook の全 Ask
ccxray agentflow report --ask A-012  # 1 つの Ask
ccxray agentflow report --json       # JSON
```

[agentflow](https://github.com/agfnow/agentflow) を使うプロジェクト向け：notebook の各 Ask について、トークン、コスト、モデル、effort、時間を、ホストセッション、サブエージェント、ディスパッチされた外部ワーカーに分けて表示します。レポートは帰属判定に transcript を読みますが、使用量は ccxray index 内の turn から集計します。必要な turn がすでに index にあれば import は不要です。transcript にしかない履歴は、使用量に加える前に import してください。`ccxray setup` は import を無効にするため、必要な場合はガイドにある1回限りの import 手順を使います。サーバーは不要です。詳細は [`docs/agentflow-report.md`](docs/agentflow-report.md)（英語）。

### その他

- **ディープリンクナビゲーション** — すべての選択状態（project / session / turn / step）はアドレスバーの URL に反映されます。URL を新しいタブに貼り付けると、ダッシュボードが同じ画面に直接ナビゲートします。
- **折りたたみサイドバー** — overview パネルを折りたたんで、タイムラインにより広いスペースを確保。
- **キャッシュ TTL 分類** — ターン詳細でキャッシュが 5 分 TTL と 1 時間 TTL のどちらを使用しているかを表示。
- **プロジェクト非表示** — `settings.json` で `hiddenProjects` を設定して特定プロジェクトをダッシュボードから隠し、共有時に漏れを防止。
- **セッション別復元上限** — `CCXRAY_SESSION_ENTRY_CAP` が起動時にセッションごとの読み込みエントリ数を制限し、巨大セッションが他のセッションを押し出すのを防止。
- **セッション検出** — Claude Codeセッションごとに自動グループ化。プロジェクト/作業ディレクトリの抽出付き
- **トークン会計** — ターンごとの内訳：input/output/cache-read/cache-createトークン、USD単位のコスト、コンテキストウィンドウ使用率バー

## 仕組み

```
Claude Code  ──►  ccxray (:5577)  ──►  api.anthropic.com（または ANTHROPIC_BASE_URL）
                      │
                      ▼
          ~/.ccxray/logs/ (JSON)
                      │
                      ▼
                  ダッシュボード（同じポート）
```

ccxray は透過型 HTTP プロキシです。リクエストを上流 API（Anthropic または OpenAI）に転送し、リクエストとレスポンスを JSON ファイルに記録して、同じポートで Web ダッシュボードを提供します。Loopback から dashboard と upstream API へのリクエストはデフォルトで信頼されます。`CCXRAY_LOOPBACK_REQUIRE_AUTH=1` を設定すると loopback にも認証を要求します。非 loopback の保護対象 dashboard/API リクエストには有効な認証が必要です。upstream HTTP と WebSocket の通信には通常 ccxray が注入する認証情報が必要です。ChatGPT にルーティングされる Codex 通信には互換性の例外があります。ccxray は `chatgpt-account-id` と JWT 形式の `Authorization` ヘッダーを受け入れますが、署名は検証せず、OAuth の有効性は upstream が判断します。`AUTH_TOKEN` は共有 token として設定でき、未設定時は ccxray がローカル secret を使います。`/_api/health` は最小限の識別情報（`capabilities: []`）を公開し、export report は信頼された呼び出し元にだけ返します。Hub 間通信は HTTP ではなく Unix domain socket（`~/.ccxray/hub.sock`）を使います。

## 設定

### CLIフラグ

| フラグ | 説明 |
|---|---|
| `--port <number>` | プロキシ + ダッシュボードのポート（デフォルト: 5577）。hub共有を無効化 |
| `--no-browser` | ダッシュボードをブラウザで自動オープンしない |

### 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PROXY_PORT` | `5577` | プロキシ + ダッシュボードのポート（`--port`で上書き） |
| `BROWSER` | — | `none`に設定すると自動オープンを無効化 |
| `AUTH_TOKEN` | _（未設定）_ | 任意の共有 access token。未設定時は `<CCXRAY_HOME>/local-secret` を使います（デフォルト `~/.ccxray/local-secret`）。非 loopback の保護対象 dashboard/API リクエストと大半の upstream 通信には認証が必要です。ChatGPT にルーティングされる Codex 通信には native-marker の例外があります。`CCXRAY_LOOPBACK_REQUIRE_AUTH=1` を設定しない限り loopback は信頼されます。[SECURITY.md](SECURITY.md) を参照してください。 |
| `CCXRAY_SESSION_ENTRY_CAP` | `500` | 起動復元時に単一セッションから読み込むエントリの最大数。超過セッションは最新1件のみ保持（ランタイムでは制限なし） |
| `CCXRAY_LOOPBACK_REQUIRE_AUTH` | _（未設定）_ | ループバックはデフォルトで認証不要。`1` に設定するとループバックでも認証を強制 |
| `CCXRAY_HOME` | `~/.ccxray` | hubロックファイル、ログ、hub.logの基本ディレクトリ |
| `CCXRAY_MAX_ENTRIES` | `5000` | メモリ上の最大エントリ数（古いものから削除。ディスクログには影響なし） |
| `LOG_RETENTION_DAYS` | `14` | 起動時に N 日より古いログファイルを自動削除。Star が付いた turn / session / project(およびその配下のすべて)は保護されます;復元されたエントリから参照されているファイルも保護されます。`0` で無効化。ただし export の enrollment がある home では、記録された正の保持日数が優先されます(export onboarding を参照)。 |
| `RESTORE_DAYS` | `14` | 起動時に読み込むログの日数を制限（`0` = 全部、`CCXRAY_MAX_ENTRIES` の上限は適用される）。ログディレクトリが非常に大きい場合に有用。 |
| `CCXRAY_PLAN` | _（自動）_ | プラン検出を上書き：`pro`、`max5x`、`max20x`、`api-key` |
| `CCXRAY_DISABLE_TITLES` | _（未設定）_ | `1` に設定するとセッションタイトル抽出を無効化（短いハッシュにフォールバック） |
| `CCXRAY_MODEL_PREFIX` | _（未設定）_ | 転送前にモデル名にプレフィックスを付加（例：`databricks-`）。上流がベンダープレフィックス付きモデル名を要求するが Claude Code は標準名のみ受け付ける場合に使用。 |
| `HTTPS_PROXY` / `https_proxy` | _（未設定）_ | HTTP CONNECT トンネル経由で送信 HTTPS トラフィックを企業プロキシに転送。 |
| `ANTHROPIC_BASE_URL` | — | カスタム上流Anthropicエンドポイント（企業ゲートウェイなど）。ベースパスをサポート — `https://host/serving-endpoints/anthropic` がそのまま動作します。`ANTHROPIC_TEST_*`が設定されている場合はそちらが優先されます。 |

すべての環境変数（デフォルト値と定義ファイル付き）は [docs/env-vars.md](docs/env-vars.md) に一覧があります。

生の request/response ログはローカルの `LOGS_DIR`（デフォルトは `~/.ccxray/logs/`）に `{timestamp}_req.json` と `{timestamp}_res.json` として保存されます。v1.0からアップグレードする場合、`./logs/`のログは初回起動時に自動的に移行されます。

`ccxray setup` で出力を設定すると、日次・セッション別サマリーをアップロードできます。生の request/response ログはアップロードされません。サマリーにはユーザー ID、session ID、repository basename、model 名、tool 名や skill 名が含まれることがあります。元データ由来の名前や metadata は全面的に秘匿化されないため、出力を有効にする前に確認してください。`CCXRAY_EXPORT_CWD_ALLOWLIST` は未登録の repo 名を `[other]` にマスクしますが、その session 自体は除外しません。`CCXRAY_EXPORT_DOMAINS` を設定した場合、一致する Claude launch-account snapshot がある turn だけを出力します。Codex と Grok の launch にはこの snapshot がないため、この filter では除外されます。これは意図された動作です。フィールド、filter、削除方法は[エクスポート設定ガイド](docs/export-onboarding.md)を参照してください。

## Docker

```bash
docker build -t ccxray .
docker run -p 5577:5577 ccxray
```

## 要件

- Node.js 18+

## 作者の他のプロジェクト

- [SourceAtlas](https://sourceatlas.io/) — あらゆるコードベースへのマップ
- [AskRoundtable](https://github.com/AskRoundtable/expert-skills) — AIをMunger、Feynman、Paul Grahamのように思考させる
- Xで [@lis186](https://x.com/lis186) をフォローして最新情報をチェック

## ライセンス

PolyForm Noncommercial 1.0.0 — [LICENSE](LICENSE) を参照
