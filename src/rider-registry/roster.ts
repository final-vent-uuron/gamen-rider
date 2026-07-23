// 大会で使うライダーの固定ロースター。
// slug は登録ID＝R2 のファイル名（riders/<slug>.json）になり、再登録は同じファイルへの
// 上書きになる（同一画像の重複登録でカード認証が死ぬ事故を防ぐ）。
// sensorSet は既定の GR センサーセット番号（登録画面で変更可）。
export interface RosterRider {
  slug: string
  name: string
  sensorSet: number
}

export const RIDER_ROSTER: RosterRider[] = [
  { slug: 'arduino', name: 'Arduino', sensorSet: 1 },
  { slug: 'python', name: 'Python', sensorSet: 2 },
  { slug: 'swift', name: 'Swift', sensorSet: 3 },
  { slug: 'flutter', name: 'Flutter', sensorSet: 4 },
]
