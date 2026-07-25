import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { listRiders } from '../rider-registry'

// デモ用のキャラ選択ページ。本番フロー（カード認証 → ポーズ認証）を通さずに、
// 一覧から選ぶだけで /battle に入れるショートカット（デモ・動作確認用）。
// 選択肢は 言語ライダーの固定ロスター ＋ 登録ライダー（/auth/register で作成）。
// 選んだ id/name は /battle の search で渡し、リザルト・再戦まで引き継がれる。

export const Route = createFileRoute('/select')({ component: SelectPage })

interface Choice {
  id: string
  name: string
  image?: string // 登録ライダーのカード画像（data URL）。無ければプレースホルダ表示
  color?: string // タイルのテーマ色。無ければ TILE_COLORS から index で割当
}

// 言語ライダーのロスター。id は arena3d の RIDER_MODELS のキーと揃えること
// （GLB を用意したら RIDER_MODELS に同じ id で登録すればモデルが差し替わる）。
// 色は各言語のブランドカラー。
const LANGUAGE_RIDERS: Choice[] = [
  { id: 'arduino', name: 'Arduino', color: '#00979d' },
  { id: 'swift', name: 'Swift', color: '#f05138' },
  { id: 'python', name: 'Python', color: '#3776ab' },
  { id: 'flutter', name: 'Flutter', color: '#54c5f8' },
]

const TILE_COLORS = ['#a78bfa', '#f87171', '#34d399', '#fbbf24', '#38bdf8']

function SelectPage() {
  const navigate = useNavigate()
  const [choices, setChoices] = useState<Choice[]>(LANGUAGE_RIDERS)
  const [loading, setLoading] = useState(true)

  // 登録ライダーを合流させる。読み込み失敗時（サーバー無し等）は組み込み分のみで続行。
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const registered = await listRiders()
        if (cancelled) return
        setChoices((base) => [
          ...base,
          ...registered
            .filter((r) => !base.some((b) => b.id === r.id))
            .map((r) => ({ id: r.id, name: r.name, image: r.imageDataUrl })),
        ])
      } catch {
        // noop
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  function pick(c: Choice) {
    // キャラ選択 → センサーペアリング（/pairing）→ バトル、の順で進む。
    // rider/name はそのまま持ち回し、/pairing の「バトルへ」で /battle へ渡る。
    navigate({ to: '/pairing', search: { rider: c.id, name: c.name } })
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        minHeight: '100vh',
        padding: '1.5rem',
        gap: '1.5rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', width: '100%', maxWidth: '720px' }}>
        <Link to="/" style={{ color: '#9ca3af', textDecoration: 'none', fontSize: '0.9rem' }}>
          ← Back
        </Link>
        <h1 style={{ margin: 0, fontSize: '1.3rem' }}>キャラ選択（デモ用）</h1>
      </div>

      <p style={{ margin: 0, color: '#9ca3af', fontSize: '0.85rem', textAlign: 'center' }}>
        カード認証・ポーズ認証をスキップして、選んだライダーでセンサーペアリングへ進みます。
      </p>

      <div
        style={{
          display: 'flex',
          gap: '1rem',
          flexWrap: 'wrap',
          justifyContent: 'center',
          maxWidth: '720px',
        }}
      >
        {choices.map((c, i) => {
          const color = c.color ?? TILE_COLORS[i % TILE_COLORS.length]
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => pick(c)}
              style={{
                width: '140px',
                borderRadius: '12px',
                border: `2px solid ${color}`,
                background: `linear-gradient(160deg, ${color}22, #0f172a)`,
                color: '#fff',
                cursor: 'pointer',
                padding: '0.6rem',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              {c.image ? (
                <img
                  src={c.image}
                  alt={c.name}
                  style={{
                    width: '100%',
                    aspectRatio: '3/4',
                    objectFit: 'cover',
                    borderRadius: '8px',
                    background: '#000',
                  }}
                />
              ) : (
                <span
                  style={{
                    width: '100%',
                    aspectRatio: '3/4',
                    borderRadius: '8px',
                    background: '#0b1220',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '2.4rem',
                    fontWeight: 900,
                    color,
                  }}
                >
                  {c.name.charAt(0)}
                </span>
              )}
              <span style={{ fontWeight: 'bold', fontSize: '0.9rem', lineHeight: 1.2 }}>{c.name}</span>
              <span style={{ fontSize: '0.7rem', color: '#9ca3af' }}>このライダーでペアリングへ →</span>
            </button>
          )
        })}
      </div>

      {loading && (
        <span style={{ color: '#6b7280', fontSize: '0.8rem' }}>登録ライダーを読み込み中…</span>
      )}
    </div>
  )
}
