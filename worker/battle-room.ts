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
  applyAbare,
  applyAttack,
  applyJump,
  applyThrow,
  applyTurn,
  createBattle,
  removePlayer,
  stepBattle,
} from '../src/battle/state.ts'

const TICK_MS = 1000 / 60 // シミュレーション更新（60Hz）
const BROADCAST_MS = 1000 / 60 // 状態配信（60Hz）。量子化遅延を減らして体感を軽く（ペイロードは小さい）

// ハートビート: WiFi 切り替え・スリープ等では TCP が黙って死に、close イベントが
// 飛ばないままゴーストプレイヤーが部屋に残る。クライアントは PING 間隔（net.ts: 3s）で
// ping を送り、サーバーは最終受信からこの時間を超えた接続を強制的に落とす。
const STALE_MS = 10_000 // これを超えて何も受信しない接続はゴーストとみなして切る
const SWEEP_MS = 1_000 // ゴースト掃除の周期（sim ループ内で間引き実行）

interface Conn {
  id: string
  riderId?: string
  riderName?: string
  lastSeen: number // 最終受信時刻（ハートビート判定用。どのメッセージでも更新）
}

type ClientMsg =
  | { t: 'join'; riderId?: unknown; riderName?: unknown }
  | { t: 'move'; dir?: unknown }
  | { t: 'jump' }
  | { t: 'attack'; kind?: unknown }
  | { t: 'guard'; on?: unknown }
  | { t: 'turn' } // 振り向き（カメラの体の向き検出: 正面 → 横向き）
  | { t: 'throw' }
  | { t: 'abare' }
  | { t: 'reset' }
  | { t: 'ping' } // ハートビート（生存確認のみ。ゲームへの影響なし）

export class BattleRoom extends DurableObject {
  private sockets = new Map<WebSocket, Conn>()
  private battle = createBattle([])
  private moveIntent: Record<string, -1 | 0 | 1> = {}
  private guardIntent: Record<string, boolean> = {}
  private last = 0
  private lastSweep = 0 // 直近のゴースト掃除時刻（SWEEP_MS 間隔で間引く）
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
    this.sockets.set(server, { id, lastSeen: Date.now() })
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
    conn.lastSeen = Date.now() // どのメッセージでも生存扱い（ping 専用にしない）

    switch (msg.t) {
      case 'join': {
        conn.riderId = String(msg.riderId ?? 'unknown')
        conn.riderName = String(msg.riderName ?? 'Rider')
        // 再戦（案A）: 前の試合が決着済みの部屋に入ってきたら、まず部屋をまっさらに
        // 作り直す。前ラウンドの KO 状態が残ったまま join すると「生存1人」で即勝者判定に
        // 跳ね返るため、reset と同じく現在つながっている全員でフルHPから組み直す。
        if (this.battle.winnerId) {
          this.resetRoom()
        } else {
          this.battle = addPlayer(this.battle, {
            id: conn.id,
            riderId: conn.riderId,
            riderName: conn.riderName,
          })
          this.moveIntent[conn.id] = 0
          this.guardIntent[conn.id] = false
        }
        break
      }
      case 'move': {
        const d = msg.dir
        this.moveIntent[conn.id] = d === -1 || d === 1 ? d : 0
        break
      }
      case 'jump':
        this.battle = applyJump(this.battle, conn.id, Date.now())
        break
      case 'attack':
        if (
          msg.kind === 'punch' ||
          msg.kind === 'kick' ||
          msg.kind === 'final' ||
          msg.kind === 'shot'
        ) {
          this.battle = applyAttack(this.battle, conn.id, msg.kind, Date.now())
        }
        break
      case 'guard':
        this.guardIntent[conn.id] = msg.on === true
        break
      case 'turn':
        this.battle = applyTurn(this.battle, conn.id, Date.now())
        break
      case 'throw':
        this.battle = applyThrow(this.battle, conn.id, Date.now())
        break
      case 'abare':
        this.battle = applyAbare(this.battle, conn.id, Date.now())
        break
      case 'reset':
        this.resetRoom()
        break
      case 'ping':
        break // lastSeen の更新（上で実施）だけが目的
    }
  }

  // 現在つながっている全員でバトルをフルHPから作り直す（再戦 / 明示リセット共通）。
  private resetRoom() {
    const inits = [...this.sockets.values()]
      .filter((c) => c.riderId)
      .map((c) => ({ id: c.id, riderId: c.riderId!, riderName: c.riderName! }))
    this.battle = createBattle(inits)
    this.moveIntent = {}
    this.guardIntent = {}
    for (const c of inits) {
      this.moveIntent[c.id] = 0
      this.guardIntent[c.id] = false
    }
  }

  private onClose(ws: WebSocket) {
    const conn = this.sockets.get(ws)
    if (!conn) return
    this.battle = removePlayer(this.battle, conn.id)
    delete this.moveIntent[conn.id]
    delete this.guardIntent[conn.id]
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
      this.battle = stepBattle(this.battle, dt, now, this.moveIntent, this.guardIntent)
      // ゴースト掃除（1秒ごとに間引き実行）: close イベントが飛ばないまま死んだ接続を
      // 最終受信からの経過時間で検出して落とす（WiFi 切り替え・スリープ対策）。
      if (now - this.lastSweep >= SWEEP_MS) {
        this.lastSweep = now
        for (const [ws, conn] of this.sockets) {
          if (now - conn.lastSeen > STALE_MS) this.onClose(ws)
        }
      }
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
    // st: サーバー時刻。クライアントは受信時刻でなくこれを補間の時間軸に使う
    // （ネットワークのバースト到着の揺れが他プレイヤーの動きに出ないように）。
    const payload = JSON.stringify({ t: 'state', state: this.battle, st: Date.now() })
    for (const ws of this.sockets.keys()) {
      try {
        ws.send(payload)
      } catch {
        this.onClose(ws)
      }
    }
  }
}
