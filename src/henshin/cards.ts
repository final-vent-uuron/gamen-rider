// カードid → riderId の対応表。
// 現在カードは /auth/register で登録したものだけで、その場合は カードid＝riderId なので
// この表は使われない（呼び出し側が「登録ライダーに一致すればそのまま採用」を先に見る）。
// 組み込みライダー（RIDER_ROUTINES）に固定カードを割り当てたくなったときにここへ足す。
// 値は src/pose/routine.ts の RIDER_ROUTINES の riderId と揃えること。
export const CARD_TO_RIDER: Record<string, string> = {}

export function cardToRiderId(cardId: string): string | null {
  return CARD_TO_RIDER[cardId] ?? null
}
