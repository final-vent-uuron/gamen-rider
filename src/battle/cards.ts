// バトル中に表示するカード。
// id は対応する技（＝GLB モーション名ベース）: ストライクベント=skill /
// エラーベント=error-mode / ファイナルベント=final-vent（クリップは special）。
// kind は表示チップと解禁条件（final はゲージ満タンのみ）のヒント。
//
// ファイナルベントの「かざすカード」参照画像は変身フローと同じ登録ライダー
// （listRiders → resolveFinalVentCardRefs）。ゲージ満タン後は任意タイミングで
// かざして発動（満タン＝即待ちにはしない）。キーボード L/F とカード UI は開発用バイパス。

export type BattleCardKind = 'attack' | 'special' | 'final'

export interface BattleCard {
  id: 'skill' | 'error-mode' | 'final-vent'
  label: string
  kind: BattleCardKind
  color: string
}

// ストライクベント（skill）・エラーベント（error-mode）はバトルから無し（意図的に外してある）。
// ファイナルベントのみ表示する。
export const DEFAULT_BATTLE_CARDS: BattleCard[] = [
  { id: 'final-vent', label: 'ファイナルベント', kind: 'final', color: '#a78bfa' },
]

// ライダーごとのカード。今は共通のプレースホルダを返す。
// 将来: riderId で分岐して固有デッキを返す。
export function battleCardsFor(_riderId: string): BattleCard[] {
  return DEFAULT_BATTLE_CARDS
}
