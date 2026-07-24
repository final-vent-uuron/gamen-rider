// バトル用 Cloudflare Worker のエントリ。
// アプリ本体（TanStack Start が出力する gamen-rider ワーカー）とは別立ての小さな Worker。
// 役割は3つ:
//   - /ws         : WebSocket アップグレードを Durable Object（対戦部屋）へ橋渡し
//   - /riders     : 登録ライダーの保存/一覧（R2）
//   - /riders/nfc : ファイナルベント用 NFC タグの紐付け（Swift アプリの enroll から）
//
// ルーム: 固定 1 部屋（CLAUDE.md: ルーム作成不要、固有ルームに参加するだけ）。
//   将来複数ルームにしたければ ?room=<id> で分ければよい（idFromName で別インスタンスになる）。

import { BattleRoom } from './battle-room.ts'
import { handleNfcBind, handleRiders } from './riders.ts'

// Durable Object クラスは Worker モジュールから export されている必要がある。
export { BattleRoom }

export interface Env {
  BATTLE_ROOM: DurableObjectNamespace
  RIDER_BUCKET: R2Bucket
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/ws') {
      const room = url.searchParams.get('room') ?? 'room'
      const id = env.BATTLE_ROOM.idFromName(room)
      return env.BATTLE_ROOM.get(id).fetch(request)
    }
    if (url.pathname === '/riders/nfc') {
      return handleNfcBind(request, env.RIDER_BUCKET)
    }
    if (url.pathname === '/riders') {
      return handleRiders(request, env.RIDER_BUCKET)
    }
    return new Response('gamen-rider battle worker — connect a WebSocket to /ws', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  },
}
