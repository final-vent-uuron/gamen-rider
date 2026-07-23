# gamen-rider

仮面ライダー龍騎モチーフの **IoT 対戦ゲーム**（ハッカソン作品）。

カードデッキをカメラにかざして「変身」し、自分が認証したライダーの姿になって対戦する。
パンチは腕に着けた加速度センサー（またはキーボード）で繰り出し、必殺技「**ファイナルベント**」はカード＋ポーズで発動する。

---

## どんなゲーム？

- **対戦形式**：個人戦 FFA（最大数人が同じルームで戦う。1 ブラウザ = 1 プレイヤー）
- **見た目**：横スクロール系の 3D 対戦。スマブラ風（HP 制 / スマブラ風 UI）。ライダーは R2 配信の GLB
- **目玉**：カード＋ポーズで放つ必殺技「**ファイナルベント**」（右下カメラ。キー／カード UI は開発用バイパス）

## 遊びの流れ

1. **カード認証** — 自分のカードデッキをカメラにかざす。ORB 特徴点マッチング（opencv.js）でカード（＝ライダー）を識別
2. **ポーズ認証** — 特定のポーズを取る（MediaPipe Pose）。カードとポーズの**両方**をクリアすると変身成立
3. **バトル** — 認証したライダーの姿で対戦。HP が尽きたら脱落 → `/result`
4. **ファイナルベント（必殺技）** — メーター満タン時、画面右下の web カメラに**カードをかざし → 腕の前突き出しポーズ**を保持すると発動（`L` / `F` またはカード UI でも可）

> トップ画面の導線は「認証 → ペアリング → バトル → リザルト」だが、現状 `/auth` 成功後は `/battle` へ直接遷移する。センサー接続は `/pairing`（または `/battle-test`）で単体確認できる。

## 操作方法

| 操作 | 入力（現状） |
|------|-------------|
| 移動 | キーボード `A` / `D`（または ← →） |
| パンチ | キーボード `J`（左）/ `K`（右）。BLE PunchSensor は `/pairing`・`/battle-test` で接続可（本番 `/battle` への配線は未完了） |
| キック | キーボード `N`（左）/ `M`（右） |
| ガード | web カメラ（ボクシングの構え）または `Shift` / `S` |
| カード認証 / ポーズ認証 | PC の web カメラ |
| ファイナルベント | メーター満タン → 右下カメラにカード（ORB）→ **登録したポーズ手順**（変身と同じ流れ判定。未登録は前突き出し）。発動中は全員停止＋カメラ寄せ（SA3 風）。バイパス: `L` / `F` またはカード UI |

> 入力は `InputSource` インターフェースで抽象化してあり、キーボードと BLE を差し替え可能。
> PunchSensor は Arduino（LIS3DH + ArduinoBLE）＋ Web Bluetooth 想定。一度ペアリングすれば以降は自動再接続する実装がある。
> リポジトリの `test/` は PlatformIO のひな形（現状は LED 点滅デモ）で、PunchSensor 本体ファームとは別。
> ファイナルベント用カード参照は変身フローと同じ登録ライダー画像（`listRiders` → `resolveFinalVentCardRefs`）。
> FV ポーズは `/final-vent-pose` で**キャラごと・複数ステップ**登録（変身と同じ流れ判定。localStorage）。

## 技術スタック

| 領域 | 技術 |
|------|------|
| フロントエンド | React 19 / TanStack Start + Router / Vite |
| 3D 描画 | three.js（GLB。ロード失敗時は box フォールバック） |
| カード認識 | opencv.js（ORB 特徴点マッチング） |
| ポーズ・ガード認識 | MediaPipe Tasks Vision |
| バトルサーバー | Cloudflare Workers + Durable Objects（WebSocket / 権威サーバー） |
| モデル配信 | Cloudflare R2（`models.gamen-rider.com`） |

バトルのシミュレーション本体は `src/battle/state.ts` の純粋関数。クライアントの予測と Durable Object 側の権威シミュレーションが同じロジックを共有する。ローカル開発時のサーバーは `wrangler dev`（`pnpm server`）。

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
**Cloudflare R2 の公開バケット `gamen-rider-models`**（カスタムドメイン `models.gamen-rider.com`）で管理する。

```bash
npx wrangler login   # 未ログインなら（初回のみ）

pnpm models:setup    # 初回のみ: バケット作成 + r2.dev 公開 + CORS 設定
pnpm models:upload   # public/model の使用中 GLB をアップロード（モデル更新時も同じ）
pnpm models:url      # 公開 URL の確認
```

- 配信元 URL は `src/model-assets.ts` が一元管理（既定は `https://models.gamen-rider.com`）。
- 手元の `public/model/` から読みたいとき（オフライン検証など）は
  `.env` に `VITE_MODEL_BASE_URL=/model` を書けば戻せる。
- モデルを追加するときは `scripts/r2-models.sh` の `FILES` に足して upload する。

### 主な画面（ルート）

| パス | 内容 |
|------|------|
| `/` | トップ |
| `/auth` | カード認証 → ポーズ認証（カード登録は `/auth/register`） |
| `/pairing` | BLE センサーのペアリング |
| `/final-vent-pose` | ファイナルベント専用ポーズ登録（キャラごと・変身とは別） |
| `/battle` | バトル本番（R2 の GLB。ロード失敗時は box） |
| `/result` | 決着・リザルト |
| `/select` | キャラ選択（デモ） |
| `/pose` / `/detect` | ポーズ／画像検知の単体検証 |
| `/henshin` | 変身フロー（旧） |
| `/battle-test` | GLB＋BLE の検証用サンドボックス |
| `/model-check` | モデル検証 |

### ディレクトリ構成

```
src/
  card/           カード認識（ORB）
  pose/           ポーズ認証
  henshin/        変身演出
  battle/         バトル（state / 3D / 入力 / BLE / FV カメラ / 通信 / SFX / BGM）
  rider-registry/ ライダー定義（ファイルベースの仮ストア）
  routes/         画面ルーティング（TanStack Router）
worker/           バトルサーバー（Cloudflare Durable Object）
test/             センサー向け PlatformIO ひな形
scripts/          R2 モデル管理など
```

## まだ足りない／仮置きのもの

- **BLE → 本番バトル**：`/battle` へのセンサー配線、キック／移動センサー
- **本番導線**：`/auth` → `/pairing` → `/battle` のつなぎ
- **DB**：未定（現状インメモリ／ファイルベース）
- **ライダー別デッキ**：バトルカード UI は共通プレースホルダ。FV のかざすカードは登録ライダー画像を使用
- **FV ポーズ**：`/final-vent-pose` でキャラごとに登録（未登録キャラは前突き出し）

## リポジトリ

- Organization：`final-vent-uuron`
- 開発：`uuronn`
