// バトル用 Cloudflare Worker のエントリ。
// アプリ本体（TanStack Start が出力する gamen-rider ワーカー）とは別立ての小さな Worker。
// 役割は「/ws への WebSocket アップグレードを Durable Object へ橋渡しする」だけ。
//
// ルーム: 固定 1 部屋（CLAUDE.md: ルーム作成不要、固有ルームに参加するだけ）。
//   将来複数ルームにしたければ ?room=<id> で分ければよい（idFromName で別インスタンスになる）。

import { BattleRoom } from './battle-room.ts'

// Durable Object クラスは Worker モジュールから export されている必要がある。
export { BattleRoom }

interface Env {
  BATTLE_ROOM: DurableObjectNamespace
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/ws') {
      const room = url.searchParams.get('room') ?? 'room'
      const id = env.BATTLE_ROOM.idFromName(room)
      return env.BATTLE_ROOM.get(id).fetch(request)
    }
    return new Response('gamen-rider battle worker — connect a WebSocket to /ws', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  },
}
