#!/usr/bin/env bash
# GLB モデルを Cloudflare R2 で管理するためのスクリプト。
#
# 使い方（要 `npx wrangler login`）:
#   pnpm models:setup    # 初回のみ: バケット作成 + r2.dev 公開 + CORS 設定
#   pnpm models:upload   # public/model の使用中 GLB をアップロード（更新時も同じ）
#   pnpm models:url      # 公開 URL（https://pub-….r2.dev）の確認
#
# 公開 URL は src/model-assets.ts の R2_PUBLIC_BASE_URL に貼ること（そこが配信元の既定になる）。
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
        --content-type model/gltf-binary --remote
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
