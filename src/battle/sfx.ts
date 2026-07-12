// 効果音（WebAudio 合成）。アセット不要で、格ゲーの「手応え」を音で足す。
// - AudioContext はブラウザの自動再生ポリシー対策で遅延生成し、最初のユーザー操作(resume)で解錠。
// - 各音は短いエンベロープのオシレータ＋ノイズで合成（ヒット/重ヒット/ガード/投げ/KO/ゲージ満タン/空振り）。
// バトル画面の命中検出から鳴らすだけ。SSR 安全（window/AudioContext が無ければ無音）。

export interface Sfx {
  resume(): void // 最初のユーザー操作で呼ぶ（オーディオ解錠）
  hit(power: number): void // power 0..1（大きいほど重い音）
  block(): void
  grab(): void // 投げ
  shoot(): void // 波動弾
  burst(): void // あばれ（割り込みバースト）
  ko(): void
  meterFull(): void
  whiff(): void
  close(): void // AudioContext を閉じて解放する（画面を離れるとき必ず呼ぶ）
}

const NOOP: Sfx = {
  resume() {},
  hit() {},
  block() {},
  grab() {},
  shoot() {},
  burst() {},
  ko() {},
  meterFull() {},
  whiff() {},
  close() {},
}

export function createSfx(): Sfx {
  if (typeof window === 'undefined') return NOOP
  const AC: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return NOOP

  let ctx: AudioContext | null = null
  const master = () => {
    if (!ctx) {
      ctx = new AC()
      masterGain = ctx.createGain()
      masterGain.gain.value = 0.5
      masterGain.connect(ctx.destination)
    }
    return ctx
  }
  let masterGain: GainNode

  // 単発トーン（周波数スライド・エンベロープ付き）
  const tone = (
    freq: number,
    dur: number,
    type: OscillatorType,
    gain: number,
    slideTo?: number,
  ) => {
    const c = master()
    const t = c.currentTime
    const osc = c.createOscillator()
    const g = c.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(freq, t)
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + dur)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    osc.connect(g)
    g.connect(masterGain)
    osc.start(t)
    osc.stop(t + dur + 0.02)
  }

  // ノイズバースト（バンドパスで質感を変える）
  const noise = (dur: number, gain: number, filterFreq: number, q = 1) => {
    const c = master()
    const t = c.currentTime
    const len = Math.floor(c.sampleRate * dur)
    const buf = c.createBuffer(1, len, c.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    const src = c.createBufferSource()
    src.buffer = buf
    const bp = c.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = filterFreq
    bp.Q.value = q
    const g = c.createGain()
    g.gain.setValueAtTime(gain, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(bp)
    bp.connect(g)
    g.connect(masterGain)
    src.start(t)
    src.stop(t + dur + 0.02)
  }

  const safe = (fn: () => void) => {
    try {
      fn()
    } catch {
      /* オーディオ失敗はデモを止めない */
    }
  }

  return {
    resume() {
      safe(() => {
        const c = master()
        if (c.state === 'suspended') void c.resume()
      })
    },
    hit(power) {
      // 重いほど低く・長く。ノイズの当たり＋低音の芯。
      safe(() => {
        const p = Math.max(0, Math.min(1, power))
        noise(0.06 + p * 0.05, 0.5 + p * 0.3, 1400 - p * 700, 0.8)
        tone(150 - p * 70, 0.12 + p * 0.1, 'sine', 0.5 + p * 0.3, 60 - p * 20)
      })
    },
    block() {
      // 金属的な短いカチ音
      safe(() => {
        tone(1100, 0.05, 'square', 0.22, 700)
        noise(0.04, 0.25, 2600, 2)
      })
    },
    grab() {
      // 掴み＝下降音＋鈍いノイズ
      safe(() => {
        tone(320, 0.18, 'sawtooth', 0.3, 110)
        noise(0.08, 0.3, 500, 0.7)
      })
    },
    shoot() {
      // 波動弾の発射＝エネルギーが放たれる上昇→減衰音＋軽いノイズ
      safe(() => {
        tone(320, 0.22, 'sawtooth', 0.32, 900)
        tone(660, 0.16, 'sine', 0.22, 1200)
        noise(0.1, 0.22, 1600, 0.8)
      })
    },
    burst() {
      // あばれ＝弾ける衝撃波。上昇スイープ＋広いノイズで「割り込んで押し返す」手応え。
      safe(() => {
        tone(180, 0.3, 'sawtooth', 0.42, 1000)
        tone(90, 0.22, 'square', 0.3, 300)
        noise(0.26, 0.5, 1200, 0.6)
      })
    },
    ko() {
      // 大きな低音の一撃＋ノイズ
      safe(() => {
        tone(110, 0.5, 'sine', 0.7, 45)
        tone(220, 0.35, 'triangle', 0.4, 80)
        noise(0.3, 0.5, 400, 0.5)
      })
    },
    meterFull() {
      // 上昇ブリップ（溜まった合図）
      safe(() => {
        tone(520, 0.08, 'square', 0.25, 700)
        setTimeout(() => safe(() => tone(780, 0.12, 'square', 0.28, 1040)), 90)
      })
    },
    whiff() {
      // 空振りの風切り
      safe(() => noise(0.12, 0.18, 900, 0.6))
    },
    close() {
      // AudioContext を閉じて OS/ブラウザのオーディオリソースを解放する。
      // これを呼ばないと画面遷移のたびに AudioContext が増え続ける（ブラウザ上限で音が止まる）。
      safe(() => {
        if (ctx) {
          void ctx.close()
          ctx = null
        }
      })
    },
  }
}
