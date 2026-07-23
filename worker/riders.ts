// 登録ライダーの保存/一覧 API（R2 バケット gamen-rider-models の riders/ プレフィックス）。
// クライアント（/auth/register, /auth など）は dev/本番どちらからも
// デプロイ済みのこの Worker へ直接 fetch する＝登録データが全 PC で共有される。
//
// 保存形式: riders/<id>.json 1オブジェクト＝ライダー1件（画像は data URL のまま同梱）。
// registry.json のような単一ファイルへの read-modify-write をしないので、
// 2PC からの同時登録でも上書き事故が起きない。
//
// id はクライアントがロースターの slug（arduino / python / swift / flutter）を指定してくる想定。
// 同じ id への再登録は同じファイルへの上書き＝ライダーは常に1件ずつに保たれる
//（同一画像が2件並ぶとカード認証のマージン判定が通らなくなるため、重複させない）。

const RIDERS_PREFIX = 'riders/'

// steps（ポーズ手順）は src/pose/custom.ts の CustomStep[]。Worker 側では中身に
// 関知せず JSON として素通しする。
// sensorSet: BLE センサーセット番号（GR<n>_… 命名の n）。null = 紐付けなし。
interface StoredRider {
  id: string
  name: string
  imageDataUrl: string
  steps: unknown[]
  sensorSet: number | null
  createdAt: string
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  })
}

export async function handleRiders(request: Request, bucket: R2Bucket): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (request.method === 'GET') {
    const listed = await bucket.list({ prefix: RIDERS_PREFIX })
    const riders = await Promise.all(
      listed.objects
        .filter((o) => o.key.endsWith('.json'))
        .map(async (o) => {
          const obj = await bucket.get(o.key)
          if (!obj) return null
          try {
            return (await obj.json()) as StoredRider
          } catch {
            return null // 壊れた1件はスキップして他を生かす
          }
        }),
    )
    const valid = riders
      .filter((r): r is StoredRider => r !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ id, name, steps, imageDataUrl, sensorSet }) => ({
        id,
        name,
        steps,
        imageDataUrl,
        sensorSet: sensorSet ?? null, // sensorSet 導入前の登録は null 扱い
      }))
    return json(valid)
  }

  if (request.method === 'POST') {
    let input: Partial<StoredRider>
    try {
      input = (await request.json()) as Partial<StoredRider>
    } catch {
      return json({ error: 'JSON ボディが必要です' }, 400)
    }
    if (!input.name?.trim()) return json({ error: 'ライダー名が空です' }, 400)
    if (!input.imageDataUrl?.startsWith('data:image/')) return json({ error: '画像がありません' }, 400)
    if (!Array.isArray(input.steps) || input.steps.length === 0)
      return json({ error: 'ポーズが未登録です' }, 400)
    if (input.id !== undefined && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(input.id))
      return json({ error: 'id は英小文字・数字・ハイフンのみです' }, 400)

    const id = input.id ?? `rider-${Date.now().toString(36)}`
    const sensorSet =
      typeof input.sensorSet === 'number' && Number.isInteger(input.sensorSet) && input.sensorSet > 0
        ? input.sensorSet
        : null
    const entry: StoredRider = {
      id,
      name: input.name.trim(),
      imageDataUrl: input.imageDataUrl,
      steps: input.steps,
      sensorSet,
      createdAt: new Date().toISOString(),
    }
    await bucket.put(`${RIDERS_PREFIX}${id}.json`, JSON.stringify(entry), {
      httpMetadata: { contentType: 'application/json' },
    })
    return json({ id })
  }

  return json({ error: 'method not allowed' }, 405)
}
