# ccxray

[English](README.md) | [正體中文](README.zh-TW.md) | **日本語**

AIエージェントセッションのX線ビュー。ゼロ設定のHTTPプロキシで、Claude CodeとAnthropic API間のすべてのAPI呼び出しを記録し、エージェント内部で実際に何が起きているかを確認できるリアルタイムダッシュボードを提供します。

![License](https://img.shields.io/badge/license-MIT-blue)

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

これだけです。プロキシが起動し、Claude Codeがプロキシ経由で接続し、ダッシュボードが自動的にブラウザで開きます。

### その他の実行方法

```bash
ccxray                           # プロキシ + ダッシュボードのみ
ccxray claude --continue         # すべてのclaude引数がそのまま渡される
ccxray --port 8080 claude        # カスタムポート
ccxray claude --no-browser       # ブラウザの自動オープンをスキップ
ANTHROPIC_BASE_URL=http://localhost:5577 claude   # 手動設定（既存セッション）
```

## 機能

### タイムライン

エージェントの思考をリアルタイムで観察。各ターンを思考ブロック（所要時間付き）、ツール呼び出しのインラインプレビュー、アシスタント応答に分解します。

![タイムラインビュー](docs/timeline.png)

### 使用量とコスト

実際の支出を把握。セッションヒートマップ、消費レート、ROI計算 — トークンの行き先を正確に把握できます。

![使用量分析](docs/usage.png)

### システムプロンプト追跡

バージョンの自動検出とdiffビューア。Claude Codeのアップデートで何が変わったかを正確に把握 — プロンプトの変更を見逃しません。

![システムプロンプト追跡](docs/system-prompt.png)

### その他

- **セッション検出** — Claude Codeセッションごとに自動グループ化。プロジェクト/作業ディレクトリの抽出付き
- **トークン会計** — ターンごとの内訳：input/output/cache-read/cache-createトークン、USD単位のコスト、コンテキストウィンドウ使用率バー

## 仕組み

```
Claude Code  ──►  ccxray (:5577)  ──►  api.anthropic.com
                      │
                      ▼
                  logs/ (JSON)
                      │
                      ▼
                  ダッシュボード（同じポート）
```

ccxrayは透過型HTTPプロキシです。リクエストをそのままAnthropicに転送し、リクエストとレスポンスの両方をJSONファイルとして記録し、同じポートでWebダッシュボードを提供します。APIキーは不要です — Claude Codeが送信する内容をそのまま通過させます。

## 設定

### CLIフラグ

| フラグ | 説明 |
|---|---|
| `--port <number>` | プロキシ + ダッシュボードのポート（デフォルト: 5577） |
| `--no-browser` | ダッシュボードをブラウザで自動オープンしない |

### 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PROXY_PORT` | `5577` | プロキシ + ダッシュボードのポート（`--port`で上書き） |
| `BROWSER` | — | `none`に設定すると自動オープンを無効化 |
| `STORAGE_BACKEND` | `local` | ストレージアダプタ: `local` または `s3` |
| `LOGS_DIR` | `./logs` | ログディレクトリ（localバックエンド） |
| `AUTH_TOKEN` | _（なし）_ | アクセス制御用APIキー（未設定時は無効） |
| `S3_BUCKET` | — | S3/R2バケット名（s3バックエンド） |
| `S3_REGION` | `auto` | AWSリージョン（s3バックエンド） |
| `S3_ENDPOINT` | — | R2/MinIO用カスタムエンドポイント（s3バックエンド） |
| `S3_PREFIX` | `logs/` | バケット内のキープレフィックス（s3バックエンド） |

ログは`./logs/`に`{timestamp}_req.json`と`{timestamp}_res.json`として保存されます。

## Docker

```bash
docker build -t ccxray .
docker run -p 5577:5577 ccxray
```

## 要件

- Node.js 18+
- その他の依存関係不要（ネイティブの`http`/`https`を使用）

## ライセンス

MIT
