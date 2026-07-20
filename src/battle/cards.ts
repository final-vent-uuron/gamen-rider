// バトル中に表示するカード。
// id は対応する技（＝GLB モーション名ベース）: ストライクベント=skill /
// エラーベント=error-mode / ファイナルベント=final-vent（クリップは special）。
// kind は表示チップと解禁条件（final はゲージ満タンのみ）のヒント。

export type BattleCardKind = 'attack' | 'special' | 'final'

export interface BattleCard {
  id: 'skill' | 'error-mode' | 'final-vent'
  label: string
  kind: BattleCardKind
  color: string
}

export const DEFAULT_BATTLE_CARDS: BattleCard[] = [
  { id: 'skill', label: 'ストライクベント', kind: 'attack', color: '#f87171' },
  { id: 'error-mode', label: 'エラーベント', kind: 'special', color: '#fbbf24' },
  { id: 'final-vent', label: 'ファイナルベント', kind: 'final', color: '#a78bfa' },
]

// ライダーごとのカード。今は共通のプレースホルダを返す。
// 将来: riderId で分岐して固有デッキを返す。
export function battleCardsFor(_riderId: string): BattleCard[] {
  return DEFAULT_BATTLE_CARDS
}
