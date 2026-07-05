// バトルの権威サーバーを Cloudflare Durable Object として実装したもの。
//
// server/index.ts（ローカル用の Node 版）とまったく同じ考え方で、シミュレーション本体は
// src/battle/state.ts の純粋関数をそのまま流用する。違いは「置き場所」だけ:
//   - Node 版  : 常駐プロセス（LAN デモ用）
//   - DO 版    : Cloudflare Workers 上で接続をまたいで状態を保持できる唯一の部品（本番）
//
// なぜ Hibernation API ではなく標準 API か:
//   本ゲームは移動を毎フレーム時間積分する「連続シミュレーション」なので、サーバー側に
//   一定間隔のティック（setInterval）が要る。setInterval を使うと DO は hibernate せず
//   メモリ常駐する（＝ティックが回り続けられる）。よって標準 WebSocket API を使う。
//   接続が 0 になったらループを止め、DO を退避可能（＝課金停止）にする。

import { DurableObject } from 'cloudflare:workers'
import {
  addPlayer,
  applyAttack,
  applyJump,
  createBattle,
  removePlayer,
  stepBattle,
} from '../src/battle/state.ts'

const TICK_MS = 1000 / 60 // シミュレーション更新（60Hz）
const BROADCAST_MS = 1000 / 30 // 状態配信（30Hz）

interface Conn {
  id: string
  riderId?: string
  riderName?: string
}

type ClientMsg =
  | { t: 'join'; riderId?: unknown; riderName?: unknown }
  | { t: 'move'; dir?: unknown }
  | { t: 'jump' }
  | { t: 'attack'; kind?: unknown }
  | { t: 'reset' }

export class BattleRoom extends DurableObject {
  private sockets = new Map<WebSocket, Conn>()
  private battle = createBattle([])
  private moveIntent: Record<string, -1 | 0 | 1> = {}
  private last = 0
  private simTimer: number | null = null
  private broadcastTimer: number | null = null

  // WebSocket のアップグレードだけを受ける（プロトコルは Node 版と同一 JSON）。
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    server.accept()

    const id = 'p_' + Math.random().toString(36).slice(2, 9)
    this.sockets.set(server, { id })
    server.send(JSON.stringify({ t: 'welcome', youId: id }))
    this.ensureLoop()

    server.addEventListener('message', (ev) => this.onMessage(server, ev.data))
    const drop = () => this.onClose(server)
    server.addEventListener('close', drop)
    server.addEventListener('error', drop)

    return new Response(null, { status: 101, webSocket: client })
  }

  private onMessage(ws: WebSocket, data: string | ArrayBuffer) {
    let msg: ClientMsg
    try {
      msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data))
    } catch {
      return
    }
    const conn = this.sockets.get(ws)
    if (!conn) return

    switch (msg.t) {
      case 'join': {
        conn.riderId = String(msg.riderId ?? 'unknown')
        conn.riderName = String(msg.riderName ?? 'Rider')
        this.battle = addPlayer(this.battle, {
          id: conn.id,
          riderId: conn.riderId,
          riderName: conn.riderName,
        })
        this.moveIntent[conn.id] = 0
        break
      }
      case 'move': {
        const d = msg.dir
        this.moveIntent[conn.id] = d === -1 || d === 1 ? d : 0
        break
      }
      case 'jump':
        this.battle = applyJump(this.battle, conn.id)
        break
      case 'attack':
        if (msg.kind === 'punch' || msg.kind === 'kick' || msg.kind === 'final') {
          this.battle = applyAttack(this.battle, conn.id, msg.kind, Date.now())
        }
        break
      case 'reset': {
        const inits = [...this.sockets.values()]
          .filter((c) => c.riderId)
          .map((c) => ({ id: c.id, riderId: c.riderId!, riderName: c.riderName! }))
        this.battle = createBattle(inits)
        this.moveIntent = {}
        for (const c of inits) this.moveIntent[c.id] = 0
        break
      }
    }
  }

  private onClose(ws: WebSocket) {
    const conn = this.sockets.get(ws)
    if (!conn) return
    this.battle = removePlayer(this.battle, conn.id)
    delete this.moveIntent[conn.id]
    this.sockets.delete(ws)
    try {
      ws.close()
    } catch {
      // already closed
    }
    if (this.sockets.size === 0) this.stopLoop()
  }

  // 接続がある間だけ 2 本のタイマー（sim / broadcast）を回す。
  private ensureLoop() {
    if (this.simTimer !== null) return
    this.last = Date.now()
    this.simTimer = setInterval(() => {
      const now = Date.now()
      const dt = now - this.last
      this.last = now
      this.battle = stepBattle(this.battle, dt, now, this.moveIntent)
    }, TICK_MS) as unknown as number
    this.broadcastTimer = setInterval(() => this.broadcast(), BROADCAST_MS) as unknown as number
  }

  private stopLoop() {
    if (this.simTimer !== null) clearInterval(this.simTimer)
    if (this.broadcastTimer !== null) clearInterval(this.broadcastTimer)
    this.simTimer = null
    this.broadcastTimer = null
    // 誰もいなくなったら状態を破棄（次の参加者はまっさらから始まる）。
    this.battle = createBattle([])
    this.moveIntent = {}
  }

  private broadcast() {
    if (this.sockets.size === 0) return
    const payload = JSON.stringify({ t: 'state', state: this.battle })
    for (const ws of this.sockets.keys()) {
      try {
        ws.send(payload)
      } catch {
        this.onClose(ws)
      }
    }
  }
}
