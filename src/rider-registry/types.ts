import type { CustomStep } from '../pose/custom'

// R2（riders/<id>.json）に保存する登録ライダー1件分。画像は data URL のまま同梱する。
// sensorSet: このライダーが使う BLE センサー名（<ライダー名>_<部位> 命名の <ライダー名> 部分。
// 例: "Arduino"）。null = 紐付けなし。
export interface RegisteredRider {
  id: string
  name: string
  imageDataUrl: string
  steps: CustomStep[]
  // ファイナルベント発動時のポーズ手順（変身ポーズとは別収録）。未登録（旧データ含む）は null。
  finalVentSteps: CustomStep[] | null
  sensorSet: string | null
  createdAt: string
}

// クライアントへ返す形。画像は data URL なので <img> や ORB マッチャにそのまま渡せる。
export interface RegisteredRiderWithImage {
  id: string
  name: string
  steps: CustomStep[]
  finalVentSteps: CustomStep[] | null
  imageDataUrl: string
  sensorSet: string | null
}

export interface SaveRiderInput {
  // 登録ID（ロースターの slug。R2 のファイル名になり、同じ id への再登録は上書き）。
  // 省略時はサーバー側でタイムスタンプ ID を採番する。
  id?: string
  name: string
  imageDataUrl: string // data:image/png;base64,... 形式
  steps: CustomStep[]
  finalVentSteps: CustomStep[] | null
  sensorSet: string | null
}
