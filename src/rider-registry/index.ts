// ライダー登録の API クライアント。/auth/register（登録）と /auth ほか（認証への読み込み）が使う。
// 保存の実体はバトル Worker（worker/riders.ts）＋ R2（gamen-rider-models の riders/）。
// dev / 本番どちらでも常にデプロイ済み Worker へ fetch する＝登録データは Cloudflare に残り、
// どの PC からも同じ一覧が見える。
import type { RegisteredRiderWithImage, SaveRiderInput } from './types'

export type { RegisteredRider, RegisteredRiderWithImage, SaveRiderInput } from './types'
export { RIDER_ROSTER } from './roster'
export type { RosterRider } from './roster'

// バトル Worker と同じホスト（net.ts の PROD_WS_URL と揃える）。VITE_RIDERS_API_URL で上書き可。
const PROD_API_BASE = 'https://gamen-rider-battle.pachi.workers.dev'

function apiBase(): string {
  const fromEnv = import.meta.env?.VITE_RIDERS_API_URL as string | undefined
  return (fromEnv?.trim() || PROD_API_BASE).replace(/\/$/, '')
}

/** 登録ライダーの BLE センサー名（<ライダー名>_<部位> 命名の <ライダー名> 部分）。未登録 ID・未設定・取得失敗は null。 */
export async function riderSensorSet(riderId: string): Promise<string | null> {
  try {
    const riders = await listRiders()
    return riders.find((r) => r.id === riderId)?.sensorSet ?? null
  } catch {
    return null // 取得できないときは「制限なし」に倒す（センサーが繋げない事故を避ける）
  }
}

/** 登録済みライダー一覧を画像（data URL）つきで返す。 */
export async function listRiders(): Promise<RegisteredRiderWithImage[]> {
  const res = await fetch(`${apiBase()}/riders`)
  if (!res.ok) throw new Error(`ライダー一覧の取得に失敗しました (${res.status})`)
  return (await res.json()) as RegisteredRiderWithImage[]
}

/** NFC タグを登録ライダーへ紐付ける（POST /riders/nfc-bind）。対象ライダーは登録済みである必要がある。 */
export async function bindRiderNfc(riderId: string, nfcId: string): Promise<void> {
  const res = await fetch(`${apiBase()}/riders/nfc-bind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ riderId, nfcId }),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => null)
    throw new Error((detail as { error?: string } | null)?.error ?? `紐付けに失敗しました (${res.status})`)
  }
}

/** ライダーを新規登録する（R2 の riders/<id>.json に保存）。 */
export async function saveRider({ data }: { data: SaveRiderInput }): Promise<{ id: string }> {
  const res = await fetch(`${apiBase()}/riders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => null)
    throw new Error(
      (detail as { error?: string } | null)?.error ?? `登録の保存に失敗しました (${res.status})`,
    )
  }
  return (await res.json()) as { id: string }
}
