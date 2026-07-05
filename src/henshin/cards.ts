// カードid → riderId の対応表（仮）。
// 現状の参照画像は果物プレースホルダなので agoneko→ryuki で暫定的にフローを通す。
// 実カード画像・ライダー確定時にここを差し替える（CLAUDE.md「ハードコードしない」方針で1箇所に隔離）。
// 値は src/pose/routine.ts の RIDER_ROUTINES の riderId と揃えること。
export const CARD_TO_RIDER: Record<string, string> = {
  agoneko: 'ryuki',
}

export function cardToRiderId(cardId: string): string | null {
  return CARD_TO_RIDER[cardId] ?? null
}
