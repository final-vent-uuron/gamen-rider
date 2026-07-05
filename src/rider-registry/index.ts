// ライダー登録のサーバー関数。/auth/register（登録）と /auth（認証への読み込み）が使う。
// 保存の実体は storage.ts（node:fs）。handler 内 dynamic import なのでクライアントには載らない。
// CLAUDE.md 方針: DB は未定なので「src/assets/riders/ 内のファイル＋registry.json」を仮ストアとする。
import { createServerFn } from '@tanstack/react-start'
import type { RegisteredRiderWithImage, SaveRiderInput } from './types'

export type { RegisteredRider, RegisteredRiderWithImage, SaveRiderInput } from './types'

/** 登録済みライダー一覧を画像（data URL）つきで返す。 */
export const listRiders = createServerFn({ method: 'GET' }).handler(
  async (): Promise<RegisteredRiderWithImage[]> => {
    const storage = await import('./storage')
    const registry = await storage.readRegistry()
    const riders: RegisteredRiderWithImage[] = []
    for (const r of registry) {
      const imageDataUrl = await storage.readRiderImageDataUrl(r)
      if (!imageDataUrl) continue // 画像が欠けている登録は認証に使えないので除外
      riders.push({ id: r.id, name: r.name, steps: r.steps, imageDataUrl })
    }
    return riders
  },
)

/** ライダーを新規登録する（画像を src/assets/riders/ に保存し registry.json へ追記）。 */
export const saveRider = createServerFn({ method: 'POST' })
  .validator((input: SaveRiderInput) => {
    if (!input.name?.trim()) throw new Error('ライダー名が空です')
    if (!input.imageDataUrl?.startsWith('data:image/')) throw new Error('画像がありません')
    if (!Array.isArray(input.steps) || input.steps.length === 0) throw new Error('ポーズが未登録です')
    return input
  })
  .handler(async ({ data }): Promise<{ id: string }> => {
    const storage = await import('./storage')
    const entry = await storage.saveRiderFiles(data)
    return { id: entry.id }
  })
