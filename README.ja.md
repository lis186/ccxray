# ccxray

[English](README.md) | [正體中文](README.zh-TW.md) | **日本語**

AIエージェントセッションのX線ビュー。ゼロ設定のHTTPプロキシで、Claude CodeとAnthropic API間のすべてのAPI呼び出しを記録し、エージェント内部で実際に何が起きているかを確認できるリアルタイムダッシュボードを提供します。

![License](https://img.shields.io/badge/license-MIT-blue)
[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge-flat.svg)](https://github.com/hesreallyhim/awesome-claude-code)

![ccxrayダッシュボード](docs/dashboard.png)

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

### タイムライン

エージェントの思考をリアルタイムで観察。各ターンは 5 行カードとして表示されます: 1 行目にコスト、キャッシュ温度（ターン間のギャップ時間付きでキャッシュミスを即座に検出）、ツール失敗リスクシグナル、`hit:0%` の赤警告、ツール一覧をタイトル上に配置。カードを開かずにセッション全体の健全性を一望できます。

![タイムラインビュー](docs/timeline.png)

### 使用量とコスト

実際の支出を把握。セッションヒートマップ、消費レート、ROI計算 — トークンの行き先を正確に把握できます。

![使用量分析](docs/usage.png)

### システムプロンプト追跡

バージョンの自動検出とdiffビューア。認識された 11 種類のエージェント — Orchestrator、General Purpose、Plan、Explore、Web Search、Codex Rescue、Claude Code Guide、Summarizer、Title Generator、Name Generator、Translator — のプロンプトを閲覧し、更新ごとの変更点を正確に把握できます。実際に捕捉した 12,730 件のプロンプトで精度検証済み: 分類されたものは 100% 正確、判定できないものは `unknown` として正直に表示します。

![システムプロンプト追跡](docs/system-prompt.png)

### キーボード操作

ダッシュボード全体をキーボードで操作可能。すべての画面下部に文脈対応のヒントバーが表示され、現在有効なショートカットが移動に合わせてリアルタイムで更新されます。`?` で完全なチートシートを展開。projects → sessions → turns → sections → timeline → 個別の diff hunk まで、マウスに触れずにナビゲート。

![キーボード操作](docs/keyboard.png)

### セッションタイトルとキャッシュアラート

セッションカードに Claude Code が自動生成したタイトル（例：`Fix login button on mobile`）とリアルタイムのキャッシュ TTL カウントダウン（`cache 4m left`）が表示され、1 分を切ると赤く点滅します。いずれかのセッションが期限に近づくと、ブラウザのタブタイトルが `ccxray` と `⚠ ccxray` の間で交互に切り替わります。オプトインのブラウザ通知はプラン対応のリードタイムで発火します — Max は 5 分前、Pro/API キーは 60 秒前。ダイレクト API トラフィックやタイトル生成中のセッションは短いハッシュにフォールバックします。

![セッションタイトルとキャッシュアラート](docs/cache-expiry.png)

### プラン自動検出

ccxray は Anthropic の `cache_creation` 使用量フィールドを読み取り、設定不要でサブスクリプションプラン（Pro、Max 5x、Max 20x）を自動検出します。トップバーに `Plan: Max 5x · TTL 1h (auto)` と表示されます。ROI 計算とクォータパネルは検出されたプランを使用します。自動検出が誤っている場合は `CCXRAY_PLAN` で上書きできます。

### リクエストの傍受と編集

リクエストが Anthropic に到達する前に一時停止できます。セッションで傍受を有効にすると、Claude Code からの次のリクエストはダッシュボードで保留されます — システムプロンプト、メッセージ、ツール、サンプリングパラメータをその場で編集してから、承認（編集後の内容を転送）するか拒否（Claude Code にエラーを返す）するかを選びます。プロンプトエンジニアリング、危険なツール呼び出しのサンドボックス化、エージェントを分岐させずに実験を行いたい場面に便利です。

### Context HUD

オプションのコンテキスト統計フッターを Claude Code 内の Claude の応答末尾に追加できます: `📊 Context: 28% (290k/1M) | 1k in + 800 out | Cache 99% hit | $0.15`。デフォルトで有効。ダッシュボードのトップバーから切り替え可能です。

**なぜ切り替えが必要なのか?** 親エージェントが Agent / Task ツール経由で sub-agent を呼び出す場合、追加されるブロックが sub-agent の応答を親エージェントに返る前に切り詰めてしまい、マルチエージェントワークフローでデータが静かに失われる可能性があります。sub-agent を多用するセッションでは HUD を無効にしてください。状態は `~/.ccxray/settings.json` に保存されます。

### その他

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

ccxrayは透過型HTTPプロキシです。リクエストをAnthropicに転送し、リクエストとレスポンスの両方をJSONファイルとして記録し、同じポートでWebダッシュボードを提供します。APIキーは不要です — Claude Codeが送信する内容をそのまま通過させます。

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
| `AUTH_TOKEN` | _（なし）_ | アクセス制御用APIキー（未設定時は無効） |
| `CCXRAY_HOME` | `~/.ccxray` | hubロックファイル、ログ、hub.logの基本ディレクトリ |
| `CCXRAY_MAX_ENTRIES` | `5000` | メモリ上の最大エントリ数（古いものから削除。ディスクログには影響なし） |
| `LOG_RETENTION_DAYS` | `14` | 起動時に N 日より古いログファイルを自動削除。復元されたエントリから参照されているファイルは保護されます。`0` で無効化。 |
| `RESTORE_DAYS` | `0` | 起動時に読み込むログの日数を制限（`0` = 全部、`CCXRAY_MAX_ENTRIES` の上限は適用される）。ログディレクトリが非常に大きい場合に有用。 |
| `CCXRAY_PLAN` | _（自動）_ | プラン検出を上書き：`pro`、`max5x`、`max20x`、`api-key` |
| `CCXRAY_DISABLE_TITLES` | _（未設定）_ | `1` に設定するとセッションタイトル抽出を無効化（短いハッシュにフォールバック） |
| `CCXRAY_MODEL_PREFIX` | _（未設定）_ | 転送前にモデル名にプレフィックスを付加（例：`databricks-`）。上流がベンダープレフィックス付きモデル名を要求するが Claude Code は標準名のみ受け付ける場合に使用。 |
| `HTTPS_PROXY` / `https_proxy` | _（未設定）_ | HTTP CONNECT トンネル経由で送信 HTTPS トラフィックを企業プロキシに転送。 |
| `ANTHROPIC_BASE_URL` | — | カスタム上流Anthropicエンドポイント（企業ゲートウェイなど）。ベースパスをサポート — `https://host/serving-endpoints/anthropic` がそのまま動作します。`ANTHROPIC_TEST_*`が設定されている場合はそちらが優先されます。 |

ログは`~/.ccxray/logs/`に`{timestamp}_req.json`と`{timestamp}_res.json`として保存されます。v1.0からアップグレードする場合、`./logs/`のログは初回起動時に自動的に移行されます。

### S3 / R2 ストレージバックエンド

`STORAGE_BACKEND=s3` を設定すると、ローカルディスクの代わりに S3 互換ストレージ（AWS S3、Cloudflare R2、MinIO）にログを書き込みます。`@aws-sdk/client-s3` のインストールが必要です。

| 変数 | デフォルト | 説明 |
|---|---|---|
| `STORAGE_BACKEND` | `local` | `local` または `s3` |
| `S3_BUCKET` | _（必須）_ | バケット名 |
| `S3_REGION` | `auto` | リージョン（R2 では `auto` を使用） |
| `S3_ENDPOINT` | _（未設定）_ | カスタムエンドポイント URL（R2 / MinIO） |
| `S3_PREFIX` | `logs/` | バケット内のキープレフィックス |

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

MIT
