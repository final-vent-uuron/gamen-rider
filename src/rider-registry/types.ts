import type { CustomStep } from '../pose/custom'

// R2（riders/<id>.json）に保存する登録ライダー1件分。画像は data URL のまま同梱する。
export interface RegisteredRider {
  id: string
  name: string
  imageDataUrl: string
  steps: CustomStep[]
  createdAt: string
}

// クライアントへ返す形。画像は data URL なので <img> や ORB マッチャにそのまま渡せる。
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
