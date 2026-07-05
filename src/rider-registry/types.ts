import type { CustomStep } from '../pose/custom'

// registry.json に保存する登録ライダー1件分。
// 画像本体は同じフォルダ（src/assets/riders/）に `${id}.<ext>` で保存する。
export interface RegisteredRider {
  id: string
  name: string
  image: string // src/assets/riders/ 内のファイル名
  steps: CustomStep[]
  createdAt: string
}

// クライアントへ返す形。画像はファイルパスではなく data URL として同梱する
// （dev/build どちらでも <img> や ORB マッチャにそのまま渡せるようにするため）。
export interface RegisteredRiderWithImage {
  id: string
  name: string
  steps: CustomStep[]
  imageDataUrl: string
}

export interface SaveRiderInput {
  name: string
  imageDataUrl: string // data:image/png;base64,... 形式
  steps: CustomStep[]
}
