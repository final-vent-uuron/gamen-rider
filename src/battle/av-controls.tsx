// 全画面ボタンと BGM 音量スライダー（/battle と / タイトルで共用の小物 UI）。
// どちらもステージ/背景の上に置く前提で、半透明の下地つき。
import { useEffect, useState } from 'react'

import { getStoredBgmVolume, setStoredBgmVolume } from './bgm'

export function FullscreenButton() {
  const [fs, setFs] = useState(false)
  useEffect(() => {
    const onChange = () => setFs(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    onChange()
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  return (
    <button
      type="button"
      onClick={() => {
        if (document.fullscreenElement) document.exitFullscreen()
        else document.documentElement.requestFullscreen()
      }}
      style={{
        background: 'rgba(0,0,0,0.45)',
        border: '1px solid #334155',
        borderRadius: '6px',
        color: '#e5e7eb',
        fontSize: '0.78rem',
        padding: '2px 10px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {fs ? '✕ 全画面解除' : '⛶ 全画面'}
    </button>
  )
}

// BGM マスター音量（0〜100%）。動かすたびに localStorage へ保存する。再生中のループ BGM
// （home / henshin）は bgm.ts の音量変更イベントで追従する。/battle のように独自の
// Bgm インスタンスを持つページは onChange で追加反映する（setVolume）。
export function BgmVolumeControl({ onChange }: { onChange?: (v: number) => void }) {
  const [master, setMaster] = useState(() => getStoredBgmVolume())
  const pct = Math.round(master * 100)
  return (
    <label
      title="BGM 音量"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.35rem',
        background: 'rgba(0,0,0,0.45)',
        border: '1px solid #334155',
        borderRadius: '6px',
        color: '#e5e7eb',
        fontSize: '0.78rem',
        padding: '2px 8px',
        whiteSpace: 'nowrap',
        cursor: 'default',
        userSelect: 'none',
      }}
    >
      <span aria-hidden="true">{pct === 0 ? '🔇' : '♪'}</span>
      <span style={{ minWidth: '2.4em', textAlign: 'right', color: '#cbd5e1' }}>{pct}</span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={pct}
        aria-label="BGM 音量"
        onChange={(e) => {
          const v = Number(e.target.value) / 100
          setMaster(v)
          setStoredBgmVolume(v)
          onChange?.(v)
        }}
        style={{
          width: '88px',
          accentColor: '#a78bfa',
          cursor: 'pointer',
          verticalAlign: 'middle',
        }}
      />
    </label>
  )
}
