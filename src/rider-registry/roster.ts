// 大会で使うライダーの固定ロースター。
// slug は登録ID＝R2 のファイル名（riders/<slug>.json）になり、再登録は同じファイルへの
// 上書きになる（同一画像の重複登録でカード認証が死ぬ事故を防ぐ）。
// sensorSet は既定のセンサー名（BLE デバイス名の <ライダー名>_<部位> の <ライダー名> 部分。
// 登録画面で変更可）。既定では name とそのまま同じにしてある。
export interface RosterRider {
  slug: string
  name: string
  sensorSet: string
}

export const RIDER_ROSTER: RosterRider[] = [
  { slug: 'arduino', name: 'Arduino', sensorSet: 'Arduino' },
  { slug: 'python', name: 'Python', sensorSet: 'Python' },
  { slug: 'swift', name: 'Swift', sensorSet: 'Swift' },
  { slug: 'flutter', name: 'Flutter', sensorSet: 'Flutter' },
]
