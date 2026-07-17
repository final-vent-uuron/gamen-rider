// BGM（public/bgm/ の mp3 再生）。効果音（sfx.ts = WebAudio 合成）とは別レイヤで、
// こちらは HTMLAudioElement によるストリーミング再生を管理する。
//
// 使い分け:
//   - main-bgm       : バトル中ずっとループ
//   - Intrusion-bgm  : 乱入（3人目以降の途中参戦）。WARNING 演出の間だけ main をダッキングして再生
//   - final-vent-bgm : ファイナルベント発動の高揚。voice（1〜4 のランダム）を重ねる
//   - win-bgm        : リザルト画面（playWinBgm を /result から呼ぶ）
//
// ブラウザの自動再生ポリシー対策: play() が拒否されたら最初のユーザー操作
// （pointerdown / keydown）で自動リトライする。SSR 安全（Audio が無ければ何もしない）。

const BGM_DIR = '/bgm'

// ファイナルベントの掛け声（存在するファイル名そのまま。3 だけ綴りが違う）。
const FINAL_VENT_VOICES = [
  'final-vent-voice-1.mp3',
  'final-vent-voice-2.mp3',
  'fina-vent-voice-3.mp3',
  'final-vent-voice-4.mp3',
]

export interface Bgm {
  playMain(): void // メイン BGM をループ再生（既に鳴っていれば何もしない）
  intrusion(durationMs: number): void // 乱入: main を止めて Intrusion-bgm を durationMs だけ流す
  finalVent(): void // ファイナルベント: 掛け声＋final-vent-bgm を数秒流して main へ戻す
  fadeOutMain(ms?: number): void // 決着時など、main をフェードアウトして止める
  close(): void // 全停止＋解放（画面を離れるとき必ず呼ぶ）
}

const NOOP: Bgm = {
  playMain() {},
  intrusion() {},
  finalVent() {},
  fadeOutMain() {},
  close() {},
}

// play() が自動再生ポリシーで拒否されたら、最初のユーザー操作で一度だけリトライする。
function playWithUnlock(audio: HTMLAudioElement, isAlive: () => boolean) {
  audio.play().catch(() => {
    const retry = () => {
      cleanup()
      if (isAlive()) audio.play().catch(() => {})
    }
    const cleanup = () => {
      window.removeEventListener('pointerdown', retry)
      window.removeEventListener('keydown', retry)
    }
    window.addEventListener('pointerdown', retry, { once: true })
    window.addEventListener('keydown', retry, { once: true })
  })
}

export function createBgm(): Bgm {
  if (typeof window === 'undefined' || typeof Audio === 'undefined') return NOOP

  let closed = false
  const alive = () => !closed
  const timers: number[] = []
  const later = (fn: () => void, ms: number) => timers.push(window.setTimeout(fn, ms))

  const make = (file: string, volume: number, loop = false) => {
    const a = new Audio(`${BGM_DIR}/${file}`)
    a.volume = volume
    a.loop = loop
    a.preload = 'auto'
    return a
  }

  const MAIN_VOL = 0.35
  const main = make('main-bgm.mp3', MAIN_VOL, true)
  const intrusionBgm = make('Intrusion-bgm.mp3', 0.75)
  const finalBgm = make('final-vent-bgm.mp3', 0.6)

  // 音量フェード（50ms 刻みの線形）。onDone は最後に一度だけ。
  const fades = new Map<HTMLAudioElement, number>()
  const fadeTo = (a: HTMLAudioElement, target: number, ms: number, onDone?: () => void) => {
    window.clearInterval(fades.get(a))
    const from = a.volume
    const start = performance.now()
    const id = window.setInterval(() => {
      const k = Math.min(1, (performance.now() - start) / ms)
      a.volume = from + (target - from) * k
      if (k >= 1) {
        window.clearInterval(id)
        fades.delete(a)
        onDone?.()
      }
    }, 50)
    fades.set(a, id)
  }

  // main を一時停止 → 割り込み音源を流す → 終わったら main をフェードインで復帰、の共通形。
  let interruptDepth = 0 // 乱入とファイナルが重なっても main の復帰は最後の1回だけ
  const interrupt = (a: HTMLAudioElement, durationMs: number, fadeOutMs: number) => {
    interruptDepth++
    main.pause()
    a.currentTime = 0
    a.volume = a === intrusionBgm ? 0.75 : 0.6
    playWithUnlock(a, alive)
    later(() => fadeTo(a, 0, fadeOutMs, () => a.pause()), Math.max(0, durationMs - fadeOutMs))
    later(() => {
      interruptDepth--
      if (interruptDepth > 0 || closed || mainStopped) return
      main.volume = 0
      playWithUnlock(main, alive)
      fadeTo(main, MAIN_VOL, 600)
    }, durationMs)
  }

  let mainStopped = false

  return {
    playMain() {
      if (closed || mainStopped) return
      if (!main.paused) return
      playWithUnlock(main, alive)
    },
    intrusion(durationMs) {
      if (closed) return
      interrupt(intrusionBgm, durationMs, 700)
    },
    finalVent() {
      if (closed) return
      // 掛け声（ランダム）＋ BGM を約 8 秒。技そのものは ~1.2s だが余韻を残す。
      const voice = make(FINAL_VENT_VOICES[Math.floor(Math.random() * FINAL_VENT_VOICES.length)], 0.9)
      playWithUnlock(voice, alive)
      interrupt(finalBgm, 8000, 1200)
    },
    fadeOutMain(ms = 800) {
      if (closed) return
      mainStopped = true // 以後 interrupt 明けでも main は復帰させない
      fadeTo(main, 0, ms, () => main.pause())
    },
    close() {
      closed = true
      for (const t of timers) window.clearTimeout(t)
      for (const id of fades.values()) window.clearInterval(id)
      for (const a of [main, intrusionBgm, finalBgm]) {
        a.pause()
        a.src = '' // ネットワーク/デコードのリソースを解放
      }
    },
  }
}

// リザルト画面用の勝利ジングル（約6秒・単発）。戻り値のクリーンアップを unmount で呼ぶ。
export function playWinBgm(volume = 0.7): () => void {
  if (typeof window === 'undefined' || typeof Audio === 'undefined') return () => {}
  let stopped = false
  const a = new Audio(`${BGM_DIR}/win-bgm.mp3`)
  a.volume = volume
  playWithUnlock(a, () => !stopped)
  return () => {
    stopped = true
    a.pause()
    a.src = ''
  }
}
