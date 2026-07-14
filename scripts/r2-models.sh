#!/usr/bin/env bash
# GLB モデルを Cloudflare R2 で管理するためのスクリプト。
#
# 使い方（要 `npx wrangler login`）:
#   pnpm models:setup    # 初回のみ: バケット作成 + r2.dev 公開 + CORS 設定
#   pnpm models:upload   # public/model の使用中 GLB をアップロード（更新時も同じ）
#   pnpm models:url      # 開発用 URL（https://pub-….r2.dev）の確認
#
# 本番の配信元はカスタムドメイン https://models.gamen-rider.com（CDN キャッシュが効く）。
# バケットへの接続はセットアップ済み:
#   npx wrangler r2 bucket domain add gamen-rider-models \
#     --domain models.gamen-rider.com --zone-id bcf6a17300137f95761d4ed9f08fdd76
# 配信元を変えるときは src/model-assets.ts の R2_PUBLIC_BASE_URL を更新する。
#
# 注意: Cache-Control を1年にしているため、モデルを差し替えるときは
# 「同名で上書き」ではなくファイル名を変える（例: -v2 を付ける）こと。
set -euo pipefail
cd "$(dirname "$0")/.."

# final-vent-uuron の Cloudflare アカウント（wrangler.battle.jsonc と同じ）
export CLOUDFLARE_ACCOUNT_ID=b7e33c313027642691f2088285bec4e2
BUCKET=gamen-rider-models

# コードから参照している GLB（src/battle/arena3d.ts / src/routes/model-check.tsx）。
# モデルを追加したらここに足して `pnpm models:upload` を実行する。
# ※ public/model には未使用の大きいファイル（Untitled.glb 等）があるため *.glb 一括にはしない。
FILES=(
  gamen-rider-python-animation.glb
  gamen-rider-arduino-add-animation-fix.glb
  flutter.glb
  test.glb
)

case "${1:-}" in
  setup)
    npx wrangler r2 bucket create "$BUCKET" --location=apac
    npx wrangler r2 bucket dev-url enable "$BUCKET"
    npx wrangler r2 bucket cors set "$BUCKET" --file scripts/r2-models-cors.json
    npx wrangler r2 bucket dev-url get "$BUCKET"
    ;;
  upload)
    for f in "${FILES[@]}"; do
      echo "==> $f"
      npx wrangler r2 object put "$BUCKET/$f" --file "public/model/$f" \
        --content-type model/gltf-binary \
        --cache-control "public, max-age=31536000" --remote
    done
    ;;
  url)
    npx wrangler r2 bucket dev-url get "$BUCKET"
    ;;
  *)
    echo "usage: $0 {setup|upload|url}" >&2
    exit 1
    ;;
esac
