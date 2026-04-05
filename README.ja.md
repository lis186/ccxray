# ccxray

[English](README.md) | [正體中文](README.zh-TW.md) | **日本語**

AIエージェントセッションのX線ビュー。ゼロ設定のHTTPプロキシで、Claude CodeとAnthropic API間のすべてのAPI呼び出しを記録し、エージェント内部で実際に何が起きているかを確認できるリアルタイムダッシュボードを提供します。

![License](https://img.shields.io/badge/license-MIT-blue)

![ccxrayダッシュボード](https://raw.githubusercontent.com/lis186/ccxray/main/docs/dashboard.png)

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
ccxray --port 8080 claude        # カスタムポート（独立モード、hub共有なし）
ccxray claude --no-browser       # ブラウザの自動オープンをスキップ
ccxray status                    # hubの情報と接続中のクライアントを表示
ANTHROPIC_BASE_URL=http://localhost:5577 claude   # 手動設定（既存セッション）
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

`--port` を使用すると独立モードで実行できます。

## 機能

### タイムライン

エージェントの思考をリアルタイムで観察。各ターンを思考ブロック（所要時間付き）、ツール呼び出しのインラインプレビュー、アシスタント応答に分解します。

![タイムラインビュー](https://raw.githubusercontent.com/lis186/ccxray/main/docs/timeline.png)

### 使用量とコスト

実際の支出を把握。セッションヒートマップ、消費レート、ROI計算 — トークンの行き先を正確に把握できます。

![使用量分析](https://raw.githubusercontent.com/lis186/ccxray/main/docs/usage.png)

### システムプロンプト追跡

バージョンの自動検出とdiffビューア。Claude Codeのアップデートで何が変わったかを正確に把握 — プロンプトの変更を見逃しません。

![システムプロンプト追跡](https://raw.githubusercontent.com/lis186/ccxray/main/docs/system-prompt.png)

### その他

- **セッション検出** — Claude Codeセッションごとに自動グループ化。プロジェクト/作業ディレクトリの抽出付き
- **トークン会計** — ターンごとの内訳：input/output/cache-read/cache-createトークン、USD単位のコスト、コンテキストウィンドウ使用率バー

## 仕組み

```
Claude Code  ──►  ccxray (:5577)  ──►  api.anthropic.com
                      │
                      ▼
          ~/.ccxray/logs/ (JSON)
                      │
                      ▼
                  ダッシュボード（同じポート）
```

ccxrayは透過型HTTPプロキシです。リクエストをそのままAnthropicに転送し、リクエストとレスポンスの両方をJSONファイルとして記録し、同じポートでWebダッシュボードを提供します。APIキーは不要です — Claude Codeが送信する内容をそのまま通過させます。

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

ログは`~/.ccxray/logs/`に`{timestamp}_req.json`と`{timestamp}_res.json`として保存されます。

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
