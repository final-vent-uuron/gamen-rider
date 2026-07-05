// バトル中に表示するカード（プレースホルダ）。
// 龍騎世界のカード名を仮置き。実カード・効果・アイコンが決まったらここを差し替える。
// kind は演出やアクション対応付けのヒント（attack→パンチ相当 / final→ファイナルベント）。

export type BattleCardKind = 'attack' | 'guard' | 'special' | 'final'

export interface BattleCard {
  id: string
  label: string
  kind: BattleCardKind
  color: string
}

export const DEFAULT_BATTLE_CARDS: BattleCard[] = [
  { id: 'strike', label: 'ストライクベント', kind: 'attack', color: '#f87171' },
  { id: 'sword', label: 'ソードベント', kind: 'attack', color: '#fbbf24' },
  { id: 'guard', label: 'ガードベント', kind: 'guard', color: '#60a5fa' },
  { id: 'final', label: 'ファイナルベント', kind: 'final', color: '#a78bfa' },
]

// ライダーごとのカード。今は共通のプレースホルダを返す。
// 将来: riderId で分岐して固有デッキを返す。
export function battleCardsFor(_riderId: string): BattleCard[] {
  return DEFAULT_BATTLE_CARDS
}
