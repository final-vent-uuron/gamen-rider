# gamen-rider

仮面ライダー龍騎モチーフの **IoT 対戦ゲーム**（ハッカソン作品）。

カードデッキをカメラにかざして「変身」し、自分が認証したライダーの姿になって対戦する。
パンチは腕に着けた加速度センサーで繰り出し、必殺技「**ファイナルベント**」はカード＋ポーズで発動する。

---

## どんなゲーム？

- **対戦形式**：個人戦（1 PC に 1 人）
- **見た目**：横スクロール系の 3D 対戦。スマブラ風（HP 制 / スマブラ風 UI）
- **目玉**：カード＋ポーズで放つ必殺技「**ファイナルベント**」

## 遊びの流れ

1. **カード認証** — 自分のカードデッキをカメラにかざす。ORB 特徴点マッチング（opencv.js）でカード（＝ライダー）を識別。
2. **ポーズ認証** — 特定のポーズを取る（MediaPipe Pose）。カードとポーズの**両方**をクリアすると変身成立。
3. **バトル** — 認証したライダーの姿で対戦。HP が尽きたら脱落。
4. **ファイナルベント（必殺技）** — バトル中、画面右下に常時表示された web カメラに**カードをかざし → 特定のポーズ**を取ると発動。

## 操作方法

| 操作 | 入力 |
|------|------|
| パンチ | 腕に着ける自作 BLE 加速度センサー（PunchSensor） |
| ガード | web カメラ（ボクシングの構えを検出） |
| カード認証 / ポーズ認証 | PC の web カメラ |
| ファイナルベント | 画面右下の web カメラ（カード＋ポーズ） |

> パンチセンサーは Arduino（LIS3DH + ArduinoBLE）製。Web Bluetooth でブラウザに直接つながり、一度ペアリングすれば以降は自動再接続する。
> 入力は `InputSource` インターフェースで抽象化してあり、キーボードでも同じバトルロジックを動かせる（開発用）。

## 技術スタック

| 領域 | 技術 |
|------|------|
| フロントエンド | React 19 / TanStack Start + Router / Vite |
| 3D 描画 | three.js |
| カード認識 | opencv.js（ORB 特徴点マッチング） |
| ポーズ・ガード認識 | MediaPipe Tasks Vision |
| バトルサーバー | Cloudflare Workers + Durable Objects（WebSocket / 権威サーバー方式） |
| センサーデバイス | Arduino + LIS3DH（PlatformIO、`test/` 以下） |

バトルのシミュレーション本体は `src/battle/state.ts` の純粋関数で、Durable Object 版（本番）とローカル Node 版が同じロジックを共有する。

## 開発

```bash
pnpm install

pnpm dev      # フロントエンド (http://localhost:3000)
pnpm server   # バトルサーバー (wrangler dev, port 8787)
```

デプロイ：

```bash
pnpm deploy:battle   # バトルサーバー（Durable Object）をデプロイ
```

### 3Dモデル(GLB)の管理

GLB は 20MB 超のバイナリが多いため git にはコミットせず（`public/model/` は gitignore 済み）、
**Cloudflare R2 の公開バケット `gamen-rider-models`** で管理する。

```bash
npx wrangler login   # 未ログインなら（初回のみ）

pnpm models:setup    # 初回のみ: バケット作成 + r2.dev 公開 + CORS 設定
pnpm models:upload   # public/model の使用中 GLB をアップロード（モデル更新時も同じ）
pnpm models:url      # 公開 URL（https://pub-….r2.dev）の確認
```

- 配信元 URL は `src/model-assets.ts` が一元管理。setup 後に表示される公開 URL を
  `R2_PUBLIC_BASE_URL` へ貼ると、全員そのまま R2 から読むようになる。
- 手元の `public/model/` から読みたいとき（オフライン検証など）は
  `.env` に `VITE_MODEL_BASE_URL=/model` を書けば戻せる。
- モデルを追加するときは `scripts/r2-models.sh` の `FILES` に足して upload する。

### 主な画面（ルート）

| パス | 内容 |
|------|------|
| `/` | トップ |
| `/auth` | カード認証（カード登録は `/auth/register`） |
| `/pose` | ポーズ認証 |
| `/henshin` | 変身演出 |
| `/battle` | バトル本番（現状プレースホルダの box 表示） |
| `/battle-test` | GLB アバターの検証用サンドボックス |
| `/result` | 決着・リザルト |

### ディレクトリ構成

```
src/
  card/           カード認識（ORB）
  pose/           ポーズ認証
  henshin/        変身演出
  battle/         バトル（state / 3D 描画 / 入力 / BLE / 通信 / SFX）
  rider-registry/ ライダー定義
  routes/         画面ルーティング（TanStack Router）
worker/           バトルサーバー（Cloudflare Durable Object）
test/             パンチセンサーのファームウェア（PlatformIO）
```

## 未確定なこと

- **DB**：未定（現状インメモリ）
- **3D アセット（ライダーモデル）**：未定。プレースホルダで対戦ロジックを先行させ、後からモデルを差し替える方針

## リポジトリ

- Organization：`final-vent-uuron`
- 開発：`uuronn`
