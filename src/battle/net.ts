// クライアント側の通信レイヤ（WebSocket）。
//
// 役割は 2 つだけ:
//   1. 自分の入力（move / jump / attack / reset）を権威サーバーへ送る
//   2. サーバーから届いた BattleState を onState で渡す（描画はバトル画面側）
// input.ts の InputSource と同じ思想で、バトル画面はこの薄い口だけを見ればよい。
//
// 接続先 URL（defaultWsUrl で自動判定）:
//   - 本番（公開ドメイン）: デプロイ済みバトル Worker（PROD_WS_URL）。VITE_WS_URL で上書き可。
//   - ローカル / LAN       : ws://<今見ているホスト>:8787/ws
//       * ホスト PC 自身    : ws://localhost:8787/ws
//       * 別 PC（LAN 経由） : http://<ホストIP>:3000 で開けば ws://<ホストIP>:8787/ws になる
//   ローカルのサーバーは `pnpm server`（wrangler dev、既定ポート 8787）で起動する。

import type { AttackKind, BattleState } from './state'

export type NetStatus = 'connecting' | 'open' | 'closed'

export interface ConnectBattleOptions {
  riderId: string
  riderName: string
  // 状態を受信するたびに呼ばれる。youId = このクライアント自身のプレイヤー id。
  onState: (state: BattleState, youId: string) => void
  onStatus?: (status: NetStatus) => void
  url?: string
}

// バトル画面が握るハンドル。入力の送信口 + 切断。
export interface BattleNet {
  sendMove(dir: -1 | 0 | 1): void
  sendJump(): void
  sendAttack(kind: AttackKind): void
  sendGuard(on: boolean): void
  sendThrow(): void
  sendReset(): void
  close(): void
}

// 本番の常設バトルサーバー（Cloudflare の Durable Object Worker）。
// gamen-rider.com など公開ドメインからはここへ繋ぐ。差し替えたければ VITE_WS_URL で上書き可。
const PROD_WS_URL = 'wss://gamen-rider-battle.pachi.workers.dev/ws'

// localhost / LAN 内かどうか（ローカル開発・会場デモ用の判定）。
function isLocalHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host.endsWith('.local') ||
    /^192\.168\./.test(host) ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  )
}

export function defaultWsUrl(): string {
  const fromEnv = import.meta.env?.VITE_WS_URL as string | undefined
  if (fromEnv) return fromEnv
  const host = typeof location !== 'undefined' ? location.hostname : 'localhost'
  // ローカル開発 / LAN デモは手元の `pnpm server`（wrangler dev, :8787）へ。
  if (isLocalHost(host)) return `ws://${host}:8787/ws`
  // 本番（gamen-rider.com 等）はデプロイ済みのバトル Worker へ。
  return PROD_WS_URL
}

export function connectBattle(opts: ConnectBattleOptions): BattleNet {
  const url = opts.url ?? defaultWsUrl()
  let ws: WebSocket | null = null
  let youId = ''
  let closedByUser = false
  let reconnectTimer = 0

  const send = (obj: unknown) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
  }

  const connect = () => {
    opts.onStatus?.('connecting')
    ws = new WebSocket(url)

    ws.onopen = () => {
      opts.onStatus?.('open')
      // 接続できたら自分のライダーで参加表明。
      send({ t: 'join', riderId: opts.riderId, riderName: opts.riderName })
    }

    ws.onmessage = (ev) => {
      let msg: { t?: string; youId?: string; state?: BattleState }
      try {
        msg = JSON.parse(ev.data as string)
      } catch {
        return
      }
      if (msg.t === 'welcome' && typeof msg.youId === 'string') {
        youId = msg.youId
      } else if (msg.t === 'state' && msg.state) {
        opts.onState(msg.state, youId)
      }
    }

    ws.onclose = () => {
      opts.onStatus?.('closed')
      // 明示 close 以外（サーバー再起動・一時切断）は自動で再接続を試みる。
      if (!closedByUser) reconnectTimer = window.setTimeout(connect, 1000)
    }

    ws.onerror = () => ws?.close()
  }

  connect()

  return {
    sendMove: (dir) => send({ t: 'move', dir }),
    sendJump: () => send({ t: 'jump' }),
    sendAttack: (kind) => send({ t: 'attack', kind }),
    sendGuard: (on) => send({ t: 'guard', on }),
    sendThrow: () => send({ t: 'throw' }),
    sendReset: () => send({ t: 'reset' }),
    close: () => {
      closedByUser = true
      window.clearTimeout(reconnectTimer)
      ws?.close()
    },
  }
}
