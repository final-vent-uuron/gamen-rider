// バトル用 Cloudflare Worker のエントリ。
// アプリ本体（TanStack Start が出力する gamen-rider ワーカー）とは別立ての小さな Worker。
// 役割は4つ:
//   - /ws            : WebSocket アップグレードを Durable Object（対戦部屋）へ橋渡し
//   - /riders        : 登録ライダーの保存/一覧（R2）
//   - /riders/nfc-bind: ファイナルベント用 NFC タグの紐付け（Swift アプリの enroll から）
//   - /riders/nfc    : NFC タップでの Final Vent 発動（POST 一発版。常時接続を持ちたく
//                       ない呼び出し元向け。GET で直近の結果ログも取れる。同じことは
//                       WS の {t:'nfc-final'} でもできる。/riders/nfc-final は後方互換の別名）
//
// /riders/nfc（発動）と /ws はどちらも対戦中の生きた状態（接続中プレイヤー・ゲージ等）を持つ
// Durable Object 本体への橋渡しが必要なので、R2 だけで完結する /riders 系とは別に
// Durable Object（BattleRoom）へ forward する。/riders/nfc-bind（紐付け）は R2 だけで完結する。
//
// ルーム: 固定 1 部屋（CLAUDE.md: ルーム作成不要、固有ルームに参加するだけ）。
//   将来複数ルームにしたければ ?room=<id> で分ければよい（idFromName で別インスタンスになる）。

import { BattleRoom } from './battle-room.ts'
import { handleNfcBind, handleRegisterUnlock, handleRiders } from './riders.ts'

// Durable Object クラスは Worker モジュールから export されている必要がある。
export { BattleRoom }

export interface Env {
  BATTLE_ROOM: DurableObjectNamespace
  RIDER_BUCKET: R2Bucket
  // /auth/register の簡易パスワード（シークレット。wrangler secret put REGISTER_PASSWORD、
  // ローカルは .dev.vars）。フロントには値を渡さず /riders/unlock で照合だけ行う。
  REGISTER_PASSWORD?: string
}

function battleRoom(env: Env, url: URL): DurableObjectStub {
  const room = url.searchParams.get('room') ?? 'room'
  return env.BATTLE_ROOM.get(env.BATTLE_ROOM.idFromName(room))
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    // /riders/nfc-final は旧パス（後方互換のため残す）。/riders/nfc が今の正式な発動先。
    if (url.pathname === '/ws' || url.pathname === '/riders/nfc' || url.pathname === '/riders/nfc-final') {
      return battleRoom(env, url).fetch(request)
    }
    if (url.pathname === '/riders/nfc-bind') {
      return handleNfcBind(request, env.RIDER_BUCKET)
    }
    if (url.pathname === '/riders/unlock') {
      return handleRegisterUnlock(request, env.REGISTER_PASSWORD)
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
