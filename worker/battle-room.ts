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
  ARENA,
  addPlayer,
  applyAbare,
  applyAttack,
  applyJump,
  applyThrow,
  applyTurn,
  flipMoveIntent,
  beginFinalVent,
  createBattle,
  endFinalVent,
  removePlayer,
  stepBattle,
} from '../src/battle/state.ts'
import { readAllRiders } from './riders.ts'
import type { Env } from './index.ts'

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
  | { t: 'attack'; kind?: unknown; side?: unknown } // side = パンチ/キックの左右（省略可）
  | { t: 'guard'; on?: unknown }
  | { t: 'turn' } // 振り向き（カメラの体の向き検出: 正面 → 横向き）
  | { t: 'throw' }
  | { t: 'abare' }
  | { t: 'final-vent'; on?: unknown; phase?: unknown } // SA3 風溜め開始/更新/解除
  | { t: 'reset' }
  | { t: 'ping' } // ハートビート（生存確認のみ。ゲームへの影響なし）
  // NFC 連携（Swift 製スマホアプリ）: カード認識の代わりに NFC タップでポーズ相へ進む。
  // 発動本体は PC 側カメラのポーズ認証後（クライアントが sendAttack('final')）。
  // riderId は送らせない（公開済みの固定4文字列を誰でも打ててしまうため）。物理タグの固有ID
  // だけを受け取り、事前に /riders/nfc-bind で紐付け済みのライダーをサーバー側で引き当てる
  // ＝実際にタグを持っている人にしかポーズ相に入れない。
  | { t: 'nfc-final'; nfcId?: unknown; tagId?: unknown }

export class BattleRoom extends DurableObject<Env> {
  private sockets = new Map<WebSocket, Conn>()
  private battle = createBattle([])
  private moveIntent: Record<string, -1 | 0 | 1> = {}
  private guardIntent: Record<string, boolean> = {}
  private last = 0
  private lastSweep = 0 // 直近のゴースト掃除時刻（SWEEP_MS 間隔で間引く）
  private simTimer: number | null = null
  private broadcastTimer: number | null = null
  // nfcId → riderId のキャッシュ（R2 の riders/*.json から）。NFC トリガー毎に R2 を
  // 読みに行かないよう短時間だけ使い回す。
  private nfcCache = new Map<string, string>()
  private nfcCacheAt = 0
  private static readonly NFC_CACHE_TTL_MS = 15_000
  // 直近の nfc-final 結果（検証ページ /nfc-test が GET /riders/nfc-final でポーリングする）。
  // Swift アプリの実際のリクエストが「届いたか・何が起きたか」をブラウザ側でも見えるようにする。
  private nfcLog: { at: number; nfcId: string; riderId?: string; ok: boolean; reason?: string }[] = []
  private static readonly NFC_LOG_MAX = 30

  // WebSocket のアップグレードに加え、/riders/nfc（発動）だけは常時接続を持たない
  // 呼び出し元（受信ループを書きたくない Swift アプリ等）向けに素の POST でも受ける。
  // /riders/nfc-final は旧パスの後方互換エイリアス。
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/riders/nfc' || url.pathname === '/riders/nfc-final') {
      return this.handleNfcFinalHttp(request)
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    server.accept()

    const id = 'p_' + Math.random().toString(36).slice(2, 9)
    this.sockets.set(server, { id, lastSeen: Date.now() })
    server.send(JSON.stringify({ t: 'welcome', youId: id }))
    this.ensureLoop()

    server.addEventListener('message', (ev) => void this.onMessage(server, ev.data))
    const drop = () => this.onClose(server)
    server.addEventListener('close', drop)
    server.addEventListener('error', drop)

    return new Response(null, { status: 101, webSocket: client })
  }

  private async onMessage(ws: WebSocket, data: string | ArrayBuffer) {
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
          const side = msg.side === 'left' || msg.side === 'right' ? msg.side : undefined
          this.battle = applyAttack(this.battle, conn.id, msg.kind, Date.now(), side)
        }
        break
      case 'guard':
        this.guardIntent[conn.id] = msg.on === true
        break
      case 'turn': {
        // 振り向き成功時は進行方向（moveIntent）も反転する。
        // これをしないと次ティックの stepBattle が旧 dir で facing を上書きしてしまう。
        const { state, turned } = applyTurn(this.battle, conn.id, Date.now())
        this.battle = state
        if (turned) {
          this.moveIntent[conn.id] = flipMoveIntent(this.moveIntent[conn.id] ?? 0)
        }
        break
      }
      case 'throw':
        this.battle = applyThrow(this.battle, conn.id, Date.now())
        break
      case 'abare':
        this.battle = applyAbare(this.battle, conn.id, Date.now())
        break
      case 'final-vent': {
        const phase = msg.phase === 'pose' ? 'pose' : 'card'
        if (msg.on === false) {
          this.battle = endFinalVent(this.battle, conn.id)
        } else {
          this.battle = beginFinalVent(this.battle, conn.id, phase, Date.now())
        }
        break
      }
      case 'reset':
        this.resetRoom()
        break
      case 'ping':
        break // lastSeen の更新（上で実施）だけが目的
      case 'nfc-final': {
        const nfcId = String(msg.nfcId ?? msg.tagId ?? '')
        const result = await this.triggerNfcFinal(nfcId)
        ws.send(JSON.stringify({ t: 'nfc-final-ack', ...result }))
        break
      }
    }
  }

  // /riders/nfc（カード認証→ポーズ相）のハンドラ。/riders/nfc-final は同じ処理への後方互換エイリアス。
  //   POST: 常時接続を持たない呼び出し元（受信ループ不要にしたい Swift アプリ等）向け。
  //         処理内容は WS の 'nfc-final' と同じ（triggerNfcFinal 共有）。即ダメージはしない。
  //   GET : 直近の結果ログを返す。検証ページ（/nfc-test）がポーリングして、実際に届いた
  //         リクエストの結果をブラウザ側でも見えるようにするため。
  private async handleNfcFinalHttp(request: Request): Promise<Response> {
    const headers = { 'content-type': 'application/json; charset=utf-8' }
    if (request.method === 'GET') {
      return new Response(JSON.stringify({ log: this.nfcLog }), { status: 200, headers })
    }
    if (request.method !== 'POST') {
      console.log(`[nfc-final] HTTP ${request.method} -> method-not-allowed`)
      return new Response(JSON.stringify({ ok: false, reason: 'method-not-allowed' }), {
        status: 405,
        headers,
      })
    }
    let body: { nfcId?: unknown; tagId?: unknown }
    try {
      body = (await request.json()) as { nfcId?: unknown; tagId?: unknown }
    } catch {
      console.log('[nfc-final] HTTP body が JSON として読めなかった')
      return new Response(JSON.stringify({ ok: false, reason: 'bad-request' }), { status: 400, headers })
    }
    // Swift アプリ側は "tagId" というキー名で送ってくる（web 側が合わせる方針）。
    // nfcId を優先しつつ tagId も同じものとして受け付ける。
    const nfcId = String(body.nfcId ?? body.tagId ?? '')
    console.log(`[nfc-final] HTTP received nfcId="${nfcId}"`)
    const result = await this.triggerNfcFinal(nfcId)
    return new Response(JSON.stringify(result), { status: 200, headers })
  }

  // 直近の nfc-final 結果を記録する（検証ページ用のログ。最大 NFC_LOG_MAX 件で古いものから捨てる）。
  private logNfc(nfcId: string, result: { ok: boolean; riderId?: string; reason?: string }) {
    this.nfcLog.push({ at: Date.now(), nfcId, ...result })
    if (this.nfcLog.length > BattleRoom.NFC_LOG_MAX) this.nfcLog.shift()
  }

  // nfc-final の中身（WS メッセージ・HTTP POST 共通）。
  // nfcId → 紐付け済みライダー → 対戦中の該当プレイヤーを引き当て、ゲージ満タンなら
  // カード認識相当としてポーズ相（SA3 風凍結）を開始する。ダメージ発動はしない
  //（PC カメラのポーズ認証後にクライアントが sendAttack('final')）。
  // 理由がわかるよう毎回 console.log ＋ nfcLog に記録する
  //（wrangler tail でも /nfc-test のポーリングでも見える）。
  private async triggerNfcFinal(
    nfcId: string,
  ): Promise<{ ok: boolean; riderId?: string; reason?: string }> {
    const riderId = await this.resolveRiderIdByNfc(nfcId)
    if (!riderId) {
      const known = [...this.nfcCache.keys()]
      console.log(`[nfc-final] nfcId="${nfcId}" -> unknown-tag（紐付け済み: ${known.join(', ') || 'なし'}）`)
      const result = { ok: false, reason: 'unknown-tag' }
      this.logNfc(nfcId, result)
      return result
    }
    const target = [...this.sockets.values()].find((c) => c.riderId === riderId)
    const player = target ? this.battle.players.find((p) => p.id === target.id) : null
    if (!player) {
      const connected = [...this.sockets.values()].map((c) => c.riderId ?? '(未join)').join(', ')
      console.log(
        `[nfc-final] riderId=${riderId} -> not-found（今この部屋に居るriderId: ${connected || 'なし'}）`,
      )
      const result = { ok: false, riderId, reason: 'not-found' }
      this.logNfc(nfcId, result)
      return result
    }
    if (player.meter < ARENA.meterFinalCost) {
      console.log(`[nfc-final] riderId=${riderId} -> low-meter（meter=${player.meter}/${ARENA.meterFinalCost}）`)
      const result = { ok: false, riderId, reason: 'low-meter' }
      this.logNfc(nfcId, result)
      return result
    }
    const now = Date.now()
    const prev = this.battle.finalVent
    // 既に自分のポーズ待ちなら冪等に成功扱い（二重タップ対策）
    if (prev && now < prev.until && prev.playerId === player.id && prev.phase === 'pose') {
      console.log(`[nfc-final] riderId=${riderId} -> OK ポーズ待ち（継続）`)
      const result = { ok: true, riderId, reason: 'pose-pending' }
      this.logNfc(nfcId, result)
      return result
    }
    this.battle = beginFinalVent(this.battle, player.id, 'pose', now)
    const vent = this.battle.finalVent
    if (!vent || now >= vent.until || vent.playerId !== player.id || vent.phase !== 'pose') {
      console.log(`[nfc-final] riderId=${riderId} -> busy（他プレイヤーの FV 溜め中など）`)
      const result = { ok: false, riderId, reason: 'busy' }
      this.logNfc(nfcId, result)
      return result
    }
    console.log(`[nfc-final] riderId=${riderId} -> OK ポーズ待ち開始`)
    const result = { ok: true, riderId }
    this.logNfc(nfcId, result)
    return result
  }

  // nfcId → riderId。R2（riders/*.json の nfcId フィールド）で事前に /riders/nfc から
  // 紐付け済みのものだけを引き当てる。未紐付けの nfcId・taken されていないタグは null。
  private async resolveRiderIdByNfc(nfcId: string): Promise<string | null> {
    if (!nfcId) return null
    const stale = Date.now() - this.nfcCacheAt > BattleRoom.NFC_CACHE_TTL_MS
    if (stale || !this.nfcCache.has(nfcId)) {
      try {
        const riders = await readAllRiders(this.env.RIDER_BUCKET)
        this.nfcCache = new Map(
          riders.filter((r): r is typeof r & { nfcId: string } => !!r.nfcId).map((r) => [r.nfcId, r.id]),
        )
        this.nfcCacheAt = Date.now()
      } catch (err) {
        console.warn('[battle-room] nfc cache refresh failed:', err)
      }
    }
    return this.nfcCache.get(nfcId) ?? null
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
    this.battle = endFinalVent(this.battle, conn.id)
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
