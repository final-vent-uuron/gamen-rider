# gamen-rider

仮面ライダー龍騎モチーフの **IoT 対戦ゲーム**（ハッカソン作品）。

カードデッキをカメラにかざして「変身」し、自分が認証したライダーの姿になって対戦する。
移動・パンチ・キックは腕/足に着けた加速度センサー（またはキーボード）で繰り出し、必殺技「**ファイナルベント**」はカード＋ポーズ、またはスマホアプリ連携の NFC タグで発動する。

---

## どんなゲーム？

- **対戦形式**：個人戦 FFA（最大数人が同じルームで戦う。1 ブラウザ = 1 プレイヤー）。3 人目以降の途中参戦は「乱入」演出つき
- **見た目**：横スクロール系の 3D 対戦。スマブラ風（HP 制 / スマブラ風 UI）。ライダーは R2 配信の GLB
- **目玉**：カード＋ポーズ（またはスマホアプリの NFC タグ）で放つ必殺技「**ファイナルベント**」。発火可能になってから素早く撃つほどダメージが伸びる

## 遊びの流れ

1. **ライダー登録**（`/auth/register`）— カード画像・変身ポーズ手順・ファイナルベントポーズ手順をまとめて登録。Cloudflare R2 に保存され、どの PC からも共有される
2. **カード認証 → ポーズ認証**（`/auth`）— 自分のカードデッキをカメラにかざす（ORB 特徴点マッチング / opencv.js）→ 登録した変身ポーズを取る（MediaPipe Pose）。両方クリアで変身成立し、`/pairing` へ
3. **センサーのペアリング**（`/pairing`）— 変身したライダーの BLE センサー（腕・足）を接続。未接続でもキーボードでバトルへ進める
4. **バトル**（`/battle`）— 認証したライダーの姿で対戦。HP が尽きたら脱落 → `/result`
5. **ファイナルベント（必殺技）** — メーター満タン時、画面右下の web カメラに**カードをかざし → 登録したポーズ手順**を取ると発動。カードが認識された瞬間から全員の時間が止まる（SA3 風の溜め）。スマホアプリで NFC タグをかざしても同様に発動できる

## 操作方法

| 操作 | 入力 |
|------|------|
| 移動（走る） | 対角の手足センサー（右手＋左足 / 左手＋右足）を交互に振る、またはキーボード `A` / `D`（← →） |
| ジャンプ | 両足のセンサーをほぼ同時に反応させる（両足で踏み切る）、またはキーボード `W` / `↑` / `Space` |
| パンチ | 手の BLE センサー（右手 / 左手）、またはキーボード `J`（左）/ `K`（右） |
| キック | 足の BLE センサー（右足 / 左足）、またはキーボード `N`（左）/ `M`（右） |
| 投げ | キーボード `U` |
| 振り向き | 横向き検知（カメラ）と同時に両手のセンサーを振る、またはキーボード `T` |
| ガード | web カメラ（ボクシングの構え）または `Shift` / `S` / `↓` |
| カード認証 / ポーズ認証 | PC の web カメラ |
| ファイナルベント | メーター満タン → 右下カメラにカード（ORB）→ **登録したポーズ手順**を保持すると発動（変身と同じ流れ判定）。カードが認識された瞬間から全員凍結（SA3 風の溜め。最大 28 秒でサーバーが自動解除）し、発動時はカットイン演出（全員停止＋カメラ寄せ）。スマホアプリで対応 NFC タグをかざしても発動可。開発バイパス: キーボード `L` / `F` |

> 入力は `InputSource` インターフェースで抽象化してあり、キーボードと BLE を差し替え可能。
> BLE センサーは**手 2 / 足 2 の 4 部位**を想定し、`<ライダー名>_<部位コード>`（例: `Arduino_RH`）で命名する。プレイヤーは自分のライダーに紐付いたセンサー名しかペアリング候補に出ない（`sensorSet`）。一度ペアリングすれば以降は自動再接続する。
> 移動（走る）は対角ペアの生インパクト値、パンチ/キックはファームウェアが振り分けたイベントを使う。両手同時パンチは「振り向き」とみなし、一定時間（既定 100ms）待ってパンチ扱いに倒すかを判定する。
> ファイナルベント用カード参照は変身フローと同じ登録ライダー画像（`listRiders` → `resolveFinalVentCardRefs`）。ポーズ手順は `/auth/register` で登録した内容（R2）を最優先で使用し、無ければローカルの旧登録 → 片腕突き出しの順にフォールバックする。
> ダメージは「メーター満タンからどれだけ早く撃ったか」で変動する（早撃ちほど高威力）。

### NFC 連携（スマホアプリ）

別リポジトリの iOS アプリから NFC タグでファイナルベントを発動できる。

- `POST /riders/nfc-bind` — NFC タグと登録ライダーを紐付け（enroll。事前に `/auth/register` でライダー登録が必要）
- `POST /riders/nfc`（`/riders/nfc-final` は後方互換の別名）— タグ ID を送るとそのライダーのファイナルベントが発動。WebSocket 経由（`{t:'nfc-final'}`）でも同様
- `/nfc-test` — 届いた POST の結果（ok/reason）をポーリング表示する検証ページ

## 技術スタック

| 領域 | 技術 |
|------|------|
| フロントエンド | React 19 / TanStack Start + Router / Vite |
| 3D 描画 | three.js（GLB。ロード失敗時は box フォールバック） |
| カード認識 | opencv.js（ORB 特徴点マッチング） |
| ポーズ・ガード認識 | MediaPipe Tasks Vision |
| センサー入力 | Web Bluetooth（腕・足の加速度センサー、GATT） |
| バトルサーバー | Cloudflare Workers + Durable Objects（WebSocket / 権威サーバー） |
| ライダー登録・モデル配信 | Cloudflare R2（登録データ・GLB とも） |

バトルのシミュレーション本体は `src/battle/state.ts` の純粋関数。クライアントの予測と Durable Object 側の権威シミュレーションが同じロジックを共有する。ローカル開発時のサーバーは `wrangler dev`（`pnpm server`）。

## 開発

```bash
pnpm install

pnpm dev      # フロントエンド (http://localhost:3000)
pnpm server   # バトルサーバー (wrangler dev, port 8787)
```

デプロイ：

```bash
pnpm deploy:battle   # バトルサーバー（Durable Object。/riders API も同居）をデプロイ
```

`src/battle/state.ts` はクライアントとバトル Worker（`worker/battle-room.ts`）で共有しているため、ここを変更したら必ず `pnpm deploy:battle` まで行うこと。

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
- ライダー登録データ（カード画像・ポーズ手順・センサー紐付け・NFC 紐付け）は同じ R2 アカウントの `riders/<id>.json`（1 ライダー 1 ファイル）に保存される。バケットへのアクセスはバトル Worker 経由（`worker/riders.ts`）のみ。

### 主な画面（ルート）

| パス | 内容 |
|------|------|
| `/` | トップ |
| `/auth` | カード認証 → ポーズ認証（変身） |
| `/auth/register` | ライダー登録（カード画像・変身ポーズ・FV ポーズ・センサーセットをまとめて登録） |
| `/pairing` | BLE センサーのペアリング |
| `/battle` | バトル本番（R2 の GLB。ロード失敗時は box） |
| `/result` | 決着・リザルト |
| `/select` | キャラ選択（デモ導線） |
| `/detect` | カード認識（ORB）の単体検証 |
| `/nfc-test` | NFC 発動の結果確認（検証用） |
| `/battle-test` | GLB＋BLE の検証用サンドボックス（サーバー不要のオフライン砂場） |
| `/model-check` | GLB モデル・アニメーションの検証 |

### ディレクトリ構成

```
src/
  card/           カード認識（ORB）
  pose/           ポーズ認証（登録ポーズの類似度判定・組み立て）
  henshin/        変身演出
  battle/         バトル（state / 3D / 入力 / BLE / FV カメラ / 通信 / SFX / BGM）
  rider-registry/ ライダー登録の API クライアント（実体は R2、worker/riders.ts 経由）
  routes/         画面ルーティング（TanStack Router）
worker/           バトルサーバー（Cloudflare Durable Object。/riders・/riders/nfc も同居）
test/             センサー向け PlatformIO ひな形
scripts/          R2 モデル管理など
```

## まだ足りない／仮置きのもの

- **加速度センサーのハード**：Arduino（LIS3DH + ArduinoBLE）＋ Web Bluetooth を想定した実装だが、実機の構成自体は差し替え可能な抽象化（`InputSource`）にとどめてある
- **バトルカード**：現状ファイナルベントのみ（ストライクベント／エラーベントはバトルから撤去済み）。かざすカードは各ライダーの登録画像を使う
- **対戦ルームの永続化**：Durable Object 内のインメモリ状態（ルーム消滅で消える）。ライダー登録データのみ R2 で永続化

## リポジトリ

- Organization：`final-vent-uuron`
- 開発：`uuronn`
