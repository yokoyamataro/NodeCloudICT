// 簡単なビープ音（WebAudio API）。
// 外部音源ファイルを使わずに JS だけで合成するので、PWA / iOS でも遅延ゼロで鳴る。
// 「外で工事中・スマホをポケットに入れたまま記録」を想定し、それなりにはっきりした
// 矩形波寄りの音にする。

let ctx: AudioContext | null = null

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (ctx && ctx.state !== 'closed') return ctx
  const AC =
    (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  try {
    ctx = new AC()
  } catch {
    return null
  }
  return ctx
}

/** ユーザの最初の操作（タップ）に対して呼ぶ。AudioContext の resume を済ませる。 */
export async function unlockAudio(): Promise<void> {
  const c = ensureCtx()
  if (!c) return
  if (c.state === 'suspended') {
    try {
      await c.resume()
    } catch {
      /* ignore */
    }
  }
}

interface BeepOptions {
  frequency?: number
  durationMs?: number
  volume?: number
  type?: OscillatorType
}

function beep(opts: BeepOptions = {}): void {
  const c = ensureCtx()
  if (!c) return
  const freq = opts.frequency ?? 880
  const dur = (opts.durationMs ?? 150) / 1000
  const vol = opts.volume ?? 0.25
  const type: OscillatorType = opts.type ?? 'sine'
  try {
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.type = type
    osc.frequency.value = freq
    gain.gain.value = 0
    // 短いアタック + 自然な減衰でクリック音を抑える
    const now = c.currentTime
    gain.gain.linearRampToValueAtTime(vol, now + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur)
    osc.connect(gain).connect(c.destination)
    osc.start(now)
    osc.stop(now + dur + 0.02)
  } catch {
    /* AudioContext が閉じている等は無視 */
  }
}

/** GNSS 記録開始時に鳴らす音（高めの 2 連短音） */
export function playStartChime(): void {
  beep({ frequency: 880, durationMs: 110, volume: 0.25, type: 'sine' })
  window.setTimeout(() => {
    beep({ frequency: 1320, durationMs: 130, volume: 0.25, type: 'sine' })
  }, 130)
}

/** GNSS 記録終了時に鳴らす音（低めの 1 連長音） */
export function playStopChime(): void {
  beep({ frequency: 440, durationMs: 320, volume: 0.28, type: 'sine' })
}
