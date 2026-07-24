// NFC ファイナルベント連携の検証ページ（開発用）。
// Swift アプリが本来やること（① 紐付け: POST /riders/nfc、② 発動: POST /riders/nfc-final。
// WS の {t:'nfc-final'} でも同じことができるが HTTP 版が本命）をブラウザから素振りできる。
//
// API ベース URL は画面上で明示的に選べるようにしてある（rider-registry の bindRiderNfc や
// battle/net.ts の defaultWsUrl は環境から自動判定するため、実際にどこを叩いたか分かりにくい
// ＝検証ページとしては不向き。ここでは常に「今から叩く URL」をそのまま画面に出す）。
import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

import type { BattleState } from '../battle/state'
import { RIDER_ROSTER, listRiders } from '../rider-registry'
import type { RegisteredRiderWithImage } from '../rider-registry'

export const Route = createFileRoute('/nfc-test')({ component: NfcTestPage })

type WsStatus = 'idle' | 'connecting' | 'open' | 'closed'

interface LogEntry {
  id: number
  at: string
  text: string
  kind: 'send' | 'recv' | 'info' | 'error'
}

const API_BASE_PRESETS = [
  { label: '本番 (gamen-rider.com)', value: 'https://gamen-rider.com' },
  { label: 'workers.dev', value: 'https://gamen-rider-battle.pachi.workers.dev' },
  { label: 'ローカル (:8787)', value: 'http://localhost:8787' },
]

let logSeq = 0

function toWs(httpBase: string): string {
  return httpBase.replace(/^http/, 'ws')
}

function NfcTestPage() {
  const wsRef = useRef<WebSocket | null>(null)
  const [apiBase, setApiBase] = useState(API_BASE_PRESETS[0].value)
  const [wsStatus, setWsStatus] = useState<WsStatus>('idle')
  const [room, setRoom] = useState('room')
  const [nfcId, setNfcId] = useState('demo-tag-001')
  const [bindRiderId, setBindRiderId] = useState(RIDER_ROSTER[0]?.slug ?? '')
  const [binding, setBinding] = useState(false)
  const [firing, setFiring] = useState(false)
  const [bindResult, setBindResult] = useState<{ url: string; body: string; ok: boolean } | null>(null)
  const [fireResult, setFireResult] = useState<{ url: string; body: string; ok: boolean } | null>(null)
  const [registered, setRegistered] = useState<RegisteredRiderWithImage[]>([])
  const [battle, setBattle] = useState<BattleState | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])

  const pushLog = (text: string, kind: LogEntry['kind'] = 'info') => {
    setLog((prev) => [...prev.slice(-49), { id: ++logSeq, at: new Date().toLocaleTimeString(), text, kind }])
  }

  // 登録済みライダー一覧（紐付け先の選択肢＆確認用。listRiders は現状 workers.dev 固定だが
  // 表示専用なので実害なし。実際の紐付け/発動は下の apiBase を必ず経由する）。
  useEffect(() => {
    listRiders()
      .then(setRegistered)
      .catch((err) => pushLog(`ライダー一覧の取得に失敗: ${err instanceof Error ? err.message : err}`, 'error'))
  }, [])

  useEffect(() => {
    return () => wsRef.current?.close()
  }, [])

  async function handleBind() {
    if (!bindRiderId || !nfcId.trim()) return
    const url = `${apiBase}/riders/nfc`
    setBinding(true)
    setBindResult(null)
    pushLog(`POST ${url} body={riderId:"${bindRiderId}",nfcId:"${nfcId.trim()}"}`, 'send')
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ riderId: bindRiderId, nfcId: nfcId.trim() }),
      })
      const bodyText = await res.text()
      setBindResult({ url, body: bodyText, ok: res.ok })
      pushLog(`${res.status} ${bodyText}`, res.ok ? 'recv' : 'error')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setBindResult({ url, body: message, ok: false })
      pushLog(`fetch failed: ${message}`, 'error')
    } finally {
      setBinding(false)
    }
  }

  async function handleFireHttp() {
    if (!nfcId.trim()) return
    const url = `${apiBase}/riders/nfc-final`
    setFiring(true)
    setFireResult(null)
    pushLog(`POST ${url} body={nfcId:"${nfcId.trim()}"}`, 'send')
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nfcId: nfcId.trim() }),
      })
      const bodyText = await res.text()
      setFireResult({ url, body: bodyText, ok: res.ok })
      pushLog(`${res.status} ${bodyText}`, res.ok ? 'recv' : 'error')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setFireResult({ url, body: message, ok: false })
      pushLog(`fetch failed: ${message}`, 'error')
    } finally {
      setFiring(false)
    }
  }

  function handleConnect() {
    if (wsRef.current) return
    const base = `${toWs(apiBase)}/ws`
    const url = room.trim() ? `${base}?room=${encodeURIComponent(room.trim())}` : base
    setWsStatus('connecting')
    pushLog(`connecting: ${url}`, 'info')
    const ws = new WebSocket(url)
    wsRef.current = ws
    ws.onopen = () => {
      setWsStatus('open')
      pushLog('open（観測専用・join は送らない）', 'info')
    }
    ws.onmessage = (ev) => {
      let msg: { t?: string; state?: BattleState; [k: string]: unknown }
      try {
        msg = JSON.parse(ev.data as string)
      } catch {
        pushLog(`recv (unparsable): ${ev.data}`, 'recv')
        return
      }
      if (msg.t === 'state' && msg.state) {
        setBattle(msg.state)
        return // state は 60Hz で届くのでログには出さない（下のパネルで常時表示）
      }
      pushLog(`recv: ${JSON.stringify(msg)}`, msg.t === 'nfc-final-ack' ? 'recv' : 'info')
    }
    ws.onclose = () => {
      setWsStatus('closed')
      wsRef.current = null
      pushLog('closed', 'info')
    }
    ws.onerror = () => pushLog('error', 'error')
  }

  function handleDisconnect() {
    wsRef.current?.close()
    wsRef.current = null
    setWsStatus('closed')
  }

  function handleFireWs() {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !nfcId.trim()) return
    const payload = { t: 'nfc-final', nfcId: nfcId.trim() }
    ws.send(JSON.stringify(payload))
    pushLog(`send: ${JSON.stringify(payload)}`, 'send')
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '1.5rem',
        minHeight: '100vh',
        gap: '1rem',
        color: '#fff',
      }}
    >
      <div style={{ width: '100%', maxWidth: '820px', display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <Link to="/" style={{ color: '#9ca3af', textDecoration: 'none', fontSize: '0.9rem' }}>
          ← Back
        </Link>
        <h1 style={{ margin: 0, fontSize: '1.4rem' }}>NFC ファイナルベント 検証ページ</h1>
      </div>
      <p style={{ width: '100%', maxWidth: '820px', color: '#9ca3af', fontSize: '0.85rem', margin: 0 }}>
        Swift アプリが叩く2本（① 紐付け、② 発動）をブラウザから代わりに叩いて確認する開発用ページ。
        どの URL を叩いたかは各ボタンの直下に必ず表示される。
      </p>

      {/* API ベース選択（ここが今回の肝: 実際に叩く先を明示する） */}
      <section style={panelStyle}>
        <h2 style={h2Style}>叩き先（API ベース）</h2>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {API_BASE_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setApiBase(p.value)}
              style={tabStyle(apiBase === p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <input value={apiBase} onChange={(e) => setApiBase(e.target.value)} style={inputStyle} />
        <span style={{ color: '#6b7280', fontSize: '0.78rem' }}>
          今の設定なら POST 先は <code>{apiBase}/riders/nfc</code> と <code>{apiBase}/riders/nfc-final</code>
        </span>
      </section>

      {/* 1. 紐付け */}
      <section style={panelStyle}>
        <h2 style={h2Style}>① NFC タグの紐付け</h2>
        <code style={urlStyle}>POST {apiBase}/riders/nfc</code>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={fieldStyle}>
            <span style={labelStyle}>対象ライダー</span>
            <select
              value={bindRiderId}
              onChange={(e) => setBindRiderId(e.target.value)}
              style={inputStyle}
            >
              {RIDER_ROSTER.map((r) => (
                <option key={r.slug} value={r.slug}>
                  {r.name}（{r.slug}）
                </option>
              ))}
            </select>
          </label>
          <label style={{ ...fieldStyle, flex: '1 1 220px' }}>
            <span style={labelStyle}>nfcId（タグのUID。ここでは自由入力でOK）</span>
            <input value={nfcId} onChange={(e) => setNfcId(e.target.value)} style={inputStyle} />
          </label>
          <button type="button" onClick={handleBind} disabled={binding} style={btnStyle('#4ade80', binding)}>
            {binding ? '送信中…' : 'このURLに送信する'}
          </button>
        </div>
        {bindResult && (
          <div style={resultBoxStyle(bindResult.ok)}>
            <div style={{ color: '#9ca3af' }}>{bindResult.url}</div>
            <div>{bindResult.body}</div>
          </div>
        )}
        <span style={{ color: '#6b7280', fontSize: '0.78rem' }}>
          登録済みライダー: {registered.length > 0 ? registered.map((r) => r.name).join(' / ') : '(取得中/なし)'}
        </span>
      </section>

      {/* 2-A. 発動（HTTP・本命） */}
      <section style={panelStyle}>
        <h2 style={h2Style}>② 発動（HTTP・Swift アプリが実際に使う版）</h2>
        <code style={urlStyle}>POST {apiBase}/riders/nfc-final</code>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ ...fieldStyle, flex: '1 1 220px' }}>
            <span style={labelStyle}>送信する nfcId（上と共通）</span>
            <input value={nfcId} onChange={(e) => setNfcId(e.target.value)} style={inputStyle} />
          </label>
          <button type="button" onClick={handleFireHttp} disabled={firing} style={btnStyle('#a78bfa', firing)}>
            {firing ? '送信中…' : '📡 このURLに送信する'}
          </button>
        </div>
        {fireResult && (
          <div style={resultBoxStyle(fireResult.ok)}>
            <div style={{ color: '#9ca3af' }}>{fireResult.url}</div>
            <div>{fireResult.body}</div>
          </div>
        )}
      </section>

      {/* 2-B. 発動（WS・任意。対戦状況をリアルタイムで見たいときだけ） */}
      <section style={panelStyle}>
        <h2 style={h2Style}>② 発動（WS・任意 / 対戦状況のライブ確認用）</h2>
        <code style={urlStyle}>WS {toWs(apiBase)}/ws</code>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={fieldStyle}>
            <span style={labelStyle}>room</span>
            <input value={room} onChange={(e) => setRoom(e.target.value)} style={inputStyle} />
          </label>
          {wsStatus === 'open' ? (
            <button type="button" onClick={handleDisconnect} style={btnStyle('#f87171', false)}>
              切断
            </button>
          ) : (
            <button
              type="button"
              onClick={handleConnect}
              disabled={wsStatus === 'connecting'}
              style={btnStyle('#38bdf8', wsStatus === 'connecting')}
            >
              {wsStatus === 'connecting' ? '接続中…' : '接続'}
            </button>
          )}
          <span style={{ fontSize: '0.8rem', color: statusColor(wsStatus) }}>status: {wsStatus}</span>
        </div>
        <button
          type="button"
          onClick={handleFireWs}
          disabled={wsStatus !== 'open' || !nfcId.trim()}
          style={{ ...btnStyle('#38bdf8', wsStatus !== 'open' || !nfcId.trim()), alignSelf: 'flex-start' }}
        >
          📡 WS で nfc-final 送信
        </button>
      </section>

      {/* 3. バトル状況（発動条件＝ゲージ満タンの確認用。WS 接続中のみ） */}
      {battle && (
        <section style={panelStyle}>
          <h2 style={h2Style}>現在の対戦状況（ゲージ満タンか確認用）</h2>
          {battle.players.length === 0 ? (
            <span style={{ color: '#6b7280', fontSize: '0.85rem' }}>誰も対戦していません</span>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              {battle.players.map((p) => (
                <div key={p.id} style={{ display: 'flex', gap: '1rem', fontSize: '0.85rem', fontFamily: 'monospace' }}>
                  <span style={{ color: '#a78bfa', width: '110px' }}>{p.riderName}</span>
                  <span>hp {Math.round(p.hp)}</span>
                  <span style={{ color: p.meter >= 100 ? '#4ade80' : '#9ca3af' }}>meter {Math.round(p.meter)}/100</span>
                  <span>action {p.action}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ログ */}
      <section style={{ ...panelStyle, maxWidth: '820px' }}>
        <h2 style={h2Style}>ログ</h2>
        <div
          style={{
            maxHeight: '260px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.2rem',
            fontFamily: 'monospace',
            fontSize: '0.78rem',
          }}
        >
          {log.length === 0 && <span style={{ color: '#6b7280' }}>（まだ何も無し）</span>}
          {log.map((l) => (
            <div key={l.id} style={{ color: logColor(l.kind) }}>
              [{l.at}] {l.text}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function statusColor(s: WsStatus): string {
  if (s === 'open') return '#4ade80'
  if (s === 'connecting') return '#fbbf24'
  if (s === 'closed') return '#f87171'
  return '#9ca3af'
}

function logColor(kind: LogEntry['kind']): string {
  if (kind === 'send') return '#38bdf8'
  if (kind === 'recv') return '#4ade80'
  if (kind === 'error') return '#f87171'
  return '#9ca3af'
}

const panelStyle: CSSProperties = {
  width: '100%',
  maxWidth: '820px',
  background: '#1f2937',
  borderRadius: '12px',
  padding: '1rem 1.25rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.6rem',
}

const h2Style: CSSProperties = { margin: 0, fontSize: '1rem', color: '#fff' }

const fieldStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.3rem' }

const labelStyle: CSSProperties = { color: '#9ca3af', fontSize: '0.78rem' }

const urlStyle: CSSProperties = {
  fontFamily: 'monospace',
  fontSize: '0.85rem',
  color: '#4ade80',
  background: '#111827',
  padding: '0.4rem 0.6rem',
  borderRadius: '6px',
  wordBreak: 'break-all',
}

const inputStyle: CSSProperties = {
  padding: '0.45rem 0.6rem',
  borderRadius: '6px',
  border: '1px solid #374151',
  background: '#111827',
  color: '#fff',
  fontSize: '0.9rem',
}

function tabStyle(active: boolean): CSSProperties {
  return {
    padding: '0.4rem 0.9rem',
    borderRadius: '999px',
    border: `1px solid ${active ? '#a78bfa' : '#374151'}`,
    background: active ? '#a78bfa22' : 'transparent',
    color: active ? '#a78bfa' : '#9ca3af',
    fontSize: '0.8rem',
    cursor: 'pointer',
  }
}

function resultBoxStyle(ok: boolean): CSSProperties {
  return {
    fontFamily: 'monospace',
    fontSize: '0.8rem',
    color: ok ? '#4ade80' : '#f87171',
    background: '#111827',
    padding: '0.5rem 0.7rem',
    borderRadius: '6px',
    wordBreak: 'break-all',
  }
}

function btnStyle(color: string, disabled: boolean): CSSProperties {
  return {
    padding: '0.5rem 1.2rem',
    borderRadius: '8px',
    border: 'none',
    background: disabled ? '#374151' : color,
    color: disabled ? '#6b7280' : '#000',
    fontWeight: 'bold',
    fontSize: '0.85rem',
    cursor: disabled ? 'not-allowed' : 'pointer',
  }
}
