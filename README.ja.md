# ccxray

[English](README.md) | [正體中文](README.zh-TW.md) | **日本語**

AIエージェントセッションのX線ビュー。ゼロ設定のHTTPプロキシで、Claude Code・Codexと上流API間のすべての呼び出しを記録し、ワークフロータイムラインとリアルタイムダッシュボードでエージェント内部の動きを可視化します。

![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)
[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge-flat.svg)](https://github.com/hesreallyhim/awesome-claude-code)

![ccxrayダッシュボード](docs/dashboard-v2.png)

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
```

これだけです。プロキシが起動し、Claude Codeがプロキシ経由で接続し、ダッシュボードが自動的にブラウザで開きます。複数のターミナルで実行すると、自動的に一つのダッシュボードを共有します。

### その他の実行方法

```bash
ccxray                           # プロキシ + ダッシュボードのみ
ccxray claude --continue         # すべてのclaude引数がそのまま渡される
ccxray --port 8080 claude        # カスタムポート（独立モード、hub共有なし）
ccxray claude --no-browser       # ブラウザの自動オープンをスキップ
ccxray status                    # hubの情報と接続中のクライアントを表示
ANTHROPIC_BASE_URL=http://localhost:5577 claude   # 既存の claude セッションを実行中の ccxray hub に向ける
```

### マルチプロジェクト

複数のターミナルで `ccxray claude` を実行すると、自動的に単一のプロキシとダッシュボードを共有します。設定は不要です。

```bash
# Terminal 1
cd ~/project-a && ccxray claude     # hubを起動 + claude

# Terminal 2
cd ~/project-b && ccxray claude     # 既存のhubに接続

# 両プロジェクトが http://localhost:5577 のダッシュボードに表示
```

Hubプロセスがクラッシュした場合、接続中のクライアントは数秒以内に自動的に復旧します。

```bash
$ ccxray status
Hub: http://localhost:5577 (pid 12345, uptime 3600s)
Connected clients (2):
  [1] pid 23456 — ~/dev/project-a
  [2] pid 34567 — ~/dev/project-b
```

`--port` を使用すると独立モードで実行できます。

## 機能

### ワークフロータイムライン

エージェントの思考プロセスと並行構造をリアルタイムで観察。

**ターンカード**：各ターンは5行カードとして表示 — コスト、キャッシュ温度（ターン間のギャップ時間付きでキャッシュミスを即座に検出）、ツール失敗リスクシグナル、`hit:0%` の赤警告、ツール一覧をタイトル上に配置。セッション全体の健全性を一望できます。

**レーン可視化**：マルチエージェントセッションは自動的に並行レーンに分割されます — メインフローはメインレーン、サブエージェントは Fork / Teammate レーンとして表示。各レーンは WCAG ≥3:1 コントラスト準拠の個別カラーを持ち、混合モデルラベルに対応。Sequential-interleave tracker が同一会話内のターンの順次/並行を識別します。

**鳥瞰モード**：birdseye overview に切り替えると、overview エリアがビューポートの 80% まで拡大。拡大版ミニマップとレンジサマリーで長いセッションの全体像を把握できます。

**L1/L2 二層選択**：Tab / ▲▼ でレーン選択（L1）、j/k でレーン内のターン選択（L2）、Esc で段階的に戻る。従来の単層クリックモデルを置き換えます。

![ワークフロータイムライン](docs/timeline-v2.png)

### 使用量とコスト

実際の支出を把握。消費レート、アカウント別の Claude・Codex レート制限カード — トークンの行き先を正確に把握できます。

![使用量分析](docs/usage.png)

### システムプロンプト追跡

バージョンの自動検出とdiffビューア。複数の認識されたエージェントタイプのプロンプトを閲覧し、更新ごとの変更点を正確に把握できます。不確定なものは `unknown` として正直に表示します。

![システムプロンプト追跡](docs/system-prompt-v2.png)

### キーボード操作

ダッシュボード全体をキーボードで操作可能。すべての画面下部に文脈対応のヒントバーが表示され、現在有効なショートカットが移動に合わせてリアルタイムで更新されます。`?` で完全なチートシートを展開。projects → sessions → timeline → 個別の diff hunk まで、マウスに触れずにナビゲート。

**ワークフローナビゲーション**：Tab / ▲▼ でレーン間を切替（L1 選択）、j/k でレーン内のターン間を切替（L2 選択）、Esc で段階的に上位レイヤーへ戻る。

**ステップタイプジャンプ**：`e`/`E` で次/前のエラーへ、`s`/`S` で Skill 呼び出しへ、`a`/`A` で subagent（Agent/Task）呼び出しへ、`m`/`M` で MCP ツール呼び出しへ。各ジャンプは位置対応で、現在位置から前後に最も近い一致ステップを見つけ、アドレスバーの URL を更新します。

`n`/`N` はダッシュボード全体でスター付きアイテムの次/前へジャンプします — プロジェクト、セッション、ターン、タイムラインの個別ステップを横断して移動できます。コマンドバーは現在のビューからスター付きアイテムに到達できる場合のみこのショートカットを表示します。

![キーボード操作](docs/keyboard-v2.png)

### セッションタイトルとキャッシュアラート

セッションカードに Claude Code が自動生成したタイトル（例：`Fix login button on mobile`）とリアルタイムのキャッシュ TTL カウントダウン（`cache 4m left`）が表示され、1 分を切ると赤く点滅します。いずれかのセッションが期限に近づくと、ブラウザのタブタイトルが `ccxray` と `⚠ ccxray` の間で交互に切り替わります。オプトインのブラウザ通知はプラン対応のリードタイムで発火します — Max は 5 分前、Pro/API キーは 60 秒前。ダイレクト API トラフィックやタイトル生成中のセッションは短いハッシュにフォールバックします。

![セッションタイトルとキャッシュアラート](docs/cache-expiry.png)

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

![スター保持と子孫ポップオーバー](docs/stars.png)

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

### その他

- **ディープリンクナビゲーション** — すべての選択状態（project / session / turn / step）はアドレスバーの URL に反映されます。URL を新しいタブに貼り付けると、ダッシュボードが同じ画面に直接ナビゲートします。
- **折りたたみサイドバー** — overview パネルを折りたたんで、タイムラインにより広いスペースを確保。
- **キャッシュ TTL 分類** — ターン詳細でキャッシュが 5 分 TTL と 1 時間 TTL のどちらを使用しているかを表示。
- **プロジェクト非表示** — `settings.json` で `hiddenProjects` を設定して特定プロジェクトをダッシュボードから隠し、共有時に漏れを防止。
- **セッション別復元上限** — `CCXRAY_SESSION_ENTRY_CAP` により、起動復元時に巨大セッションが他のすべてのセッションを押し出すのを防止。
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

ccxrayは透過型HTTPプロキシです。リクエストを上流API（AnthropicまたはOpenAI）に転送し、リクエストとレスポンスの両方をJSONファイルとして記録し、同じポートでWebダッシュボードを提供します。すべてのエンドポイントで認証が強制されます：launcherから起動したCLIは `X-Ccxray-Auth` ヘッダーを自動注入するため、ユーザーは意識する必要がありません。`/v1/*` を直接呼び出すスクリプトはこのヘッダーを付与する必要があります（詳細はCHANGELOGを参照）。Hub間通信はHTTPではなくUnixドメインソケット（`~/.ccxray/hub.sock`）を使用します。

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
| `AUTH_TOKEN` | _（自動生成）_ | アクセス制御用キー。未設定時は `<CCXRAY_HOME>/local-secret` から自動導出（デフォルト `~/.ccxray/local-secret`）。すべてのエンドポイントで認証は強制。 |
| `CCXRAY_SESSION_ENTRY_CAP` | `500` | 起動復元時に単一セッションから読み込むエントリの最大数。超過セッションは最新1件のみ保持（ランタイムでは制限なし） |
| `CCXRAY_LOOPBACK_REQUIRE_AUTH` | _（未設定）_ | ループバックはデフォルトで認証不要。`1` に設定するとループバックでも認証を強制 |
| `CCXRAY_HOME` | `~/.ccxray` | hubロックファイル、ログ、hub.logの基本ディレクトリ |
| `CCXRAY_MAX_ENTRIES` | `5000` | メモリ上の最大エントリ数（古いものから削除。ディスクログには影響なし） |
| `LOG_RETENTION_DAYS` | `14` | 起動時に N 日より古いログファイルを自動削除。Star が付いた turn / session / project(およびその配下のすべて)は保護されます;復元されたエントリから参照されているファイルも保護されます。`0` で無効化。 |
| `RESTORE_DAYS` | `14` | 起動時に読み込むログの日数を制限（`0` = 全部、`CCXRAY_MAX_ENTRIES` の上限は適用される）。ログディレクトリが非常に大きい場合に有用。 |
| `CCXRAY_PLAN` | _（自動）_ | プラン検出を上書き：`pro`、`max5x`、`max20x`、`api-key` |
| `CCXRAY_DISABLE_TITLES` | _（未設定）_ | `1` に設定するとセッションタイトル抽出を無効化（短いハッシュにフォールバック） |
| `CCXRAY_MODEL_PREFIX` | _（未設定）_ | 転送前にモデル名にプレフィックスを付加（例：`databricks-`）。上流がベンダープレフィックス付きモデル名を要求するが Claude Code は標準名のみ受け付ける場合に使用。 |
| `HTTPS_PROXY` / `https_proxy` | _（未設定）_ | HTTP CONNECT トンネル経由で送信 HTTPS トラフィックを企業プロキシに転送。 |
| `ANTHROPIC_BASE_URL` | — | カスタム上流Anthropicエンドポイント（企業ゲートウェイなど）。ベースパスをサポート — `https://host/serving-endpoints/anthropic` がそのまま動作します。`ANTHROPIC_TEST_*`が設定されている場合はそちらが優先されます。 |

ログは`~/.ccxray/logs/`に`{timestamp}_req.json`と`{timestamp}_res.json`として保存されます。v1.0からアップグレードする場合、`./logs/`のログは初回起動時に自動的に移行されます。

ccxray は現在、ログをローカルファイルシステムにのみ保存します。リモートのオブジェクトストレージバックエンド（S3 / R2）はまだサポートされていません — ストレージインターフェースと、request／response ログをマシン外へ送信する際のセキュリティモデルについて、さらなる設計が必要です。

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
