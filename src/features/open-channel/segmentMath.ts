/**
 * 断面 1 区間 の 形 を 解く。
 *
 * 1 区間 は 「前 の 点 から 外 へ 向かう ひと続き の 直線」 で、 4 つ の 値 で
 * 言い表せる。 どれ か 2 つ が 決まれば 残り は 決まる。
 *
 *   幅   (width)  : 水平距離 [m]。 外 向き が 正、 負 で 内 へ 戻る
 *   直高 (height) : 鉛直距離 [m]。 上 が 正
 *   勾配 (slope)  : 外 へ 1m 進む ごと の 上がり [m]。 % と 1:n で 入力 する
 *   法長 (length) : 斜面 に 沿った 長さ [m]。 常に 0 以上
 *
 * 組合せ は 4 つ に 絞って いる。 「法長 + 幅」 「法長 + 直高」 は
 * 直高 (幅) の 符号 が 決まら ない (上り か 下り か) ため 外して ある。
 * 勾配 を 一緒 に 入れて もらえば 一意 に 決まる。
 */

/** 4 つ の 値 の うち どの 2 つ を 入力 に する か */
export type SegmentInputMode =
  | 'widthSlope'
  | 'widthHeight'
  | 'heightSlope'
  | 'lengthSlope'
  /**
   * 勾配 だけ 決めて おき、 現況線 と ぶつかる ところ まで 伸ばす (法面 の 摺り付け)。
   * 余裕幅 を 足す と、 交点 から さらに 同じ 勾配 の まま 幅方向 に 伸びる。
   * 長さ は 現況 が 分かって 初めて 決まる ので、 標準断面 の 定義 時 に は
   * 決まら ない (測点 へ 取り込む とき に 解決 する)。
   */
  | 'toGround'

/** 区間 の 値 の 呼び名 */
export type SegmentField = 'width' | 'height' | 'slope' | 'length'

export const SEGMENT_INPUT_MODES: {
  key: SegmentInputMode
  label: string
  /** この モード で 手入力 に する 欄 (残り は 自動計算) */
  fields: readonly SegmentField[]
}[] = [
  { key: 'widthSlope', label: '幅 + 勾配', fields: ['width', 'slope'] },
  { key: 'widthHeight', label: '幅 + 直高', fields: ['width', 'height'] },
  { key: 'heightSlope', label: '直高 + 勾配', fields: ['height', 'slope'] },
  { key: 'lengthSlope', label: '法長 + 勾配', fields: ['length', 'slope'] },
  { key: 'toGround', label: '勾配 ～ 現況まで', fields: ['slope'] },
]

export const isInputField = (mode: SegmentInputMode, f: SegmentField): boolean =>
  (SEGMENT_INPUT_MODES.find((m) => m.key === mode)?.fields ?? []).includes(f)

/** 解いた 結果。 幅 0 の とき 勾配 は 決まら ない ので f は null に なる */
export interface SegmentSolved {
  /** 水平距離 [m] (符号付き) */
  w: number
  /** 鉛直距離 [m] (符号付き) */
  h: number
  /** 外 へ 1m あたり の 上がり。 幅 0 (直立) なら null */
  f: number | null
  /** 法長 [m] (0 以上) */
  l: number
  /**
   * 「現況まで」 で、 交点 が 現況 の 測定範囲 の 外 に あり、
   * 端 の 勾配 を 延長 して 求めた 場合 に true。
   */
  extrapolated?: boolean
  /**
   * 「現況まで」 で、 入れた 向き で は 現況 に 届かず、 上下 を 反転 して
   * 求めた 場合 に true。 法面 の 勾配 は 大きさ で 決まり、 上り か 下り かは
   * 現況 が 基準点 より 上 に ある か 下 に ある か で 決まる ため。
   */
  flipped?: boolean
}

export type SegmentSolveResult =
  | { ok: true; value: SegmentSolved }
  | { ok: false; error: string }

const r3 = (v: number) => Math.round(v * 1000) / 1000

/** 勾配 の 入力 値 → 「外 へ 1m あたり の 上がり」。 比率 の 0 は 使えない */
export function slopeToFactor(v: number, unit: 'percent' | 'ratio'): number | null {
  if (unit === 'percent') return v / 100
  if (Math.abs(v) < 1e-9) return null
  return Math.sign(v) * (1 / Math.abs(v))
}

/** 「外 へ 1m あたり の 上がり」 → 勾配 の 表示 値 */
export function factorToSlope(f: number, unit: 'percent' | 'ratio'): string {
  if (unit === 'percent') return (f * 100).toFixed(3)
  if (Math.abs(f) < 1e-9) return ''
  return (Math.sign(f) * (1 / Math.abs(f))).toFixed(3)
}

/**
 * 入力 の 組 から 区間 を 解く。
 * 値 が 足り ない / 解け ない 組合せ は ok:false と 理由 を 返す。
 */
/** 断面 上 の 点 (中心 から の 離れ と 標高) */
export interface SectionPoint {
  offset: number
  elevation: number
}

/**
 * 外 向き の 半直線 と 現況線 (点列) の 最初 の 交点 を 探す。
 * 返す の は 起点 から の 水平距離 t (m, 正)。 交わら なければ null。
 *
 * 半直線 : x(t) = from.offset + sideSign*t,  y(t) = from.elevation + f*t   (t > 0)
 * 現況線 : offset 順 に 並べた 点列 を 直線 で 繋いだ もの
 *
 * 各 区間 で x も y も t の 1 次式 な ので、 差 の 根 を 1 つ 求めて
 * その 区間 の 範囲 に 入って いれば 交点。 最小 の t を 採る。
 */
/**
 * 現況線 の ある 離れ で の 標高。 範囲 外 は 端 の 値 を 使う (目安 表示 用)。
 * 交点 が 見つから ない とき、 起点 が 現況 の 上 か 下 か を 伝える ため の もの。
 */
export function groundElevationAt(ground: SectionPoint[], offset: number): number | null {
  const pts = [...ground]
    .filter((p) => Number.isFinite(p.offset) && Number.isFinite(p.elevation))
    .sort((a, b) => a.offset - b.offset)
  if (pts.length === 0) return null
  if (offset <= pts[0].offset) return pts[0].elevation
  if (offset >= pts[pts.length - 1].offset) return pts[pts.length - 1].elevation
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    if (offset >= a.offset && offset <= b.offset) {
      const dx = b.offset - a.offset
      if (Math.abs(dx) < 1e-9) return a.elevation
      return a.elevation + ((b.elevation - a.elevation) * (offset - a.offset)) / dx
    }
  }
  return null
}

/** 端 を 延長 する 距離 [m]。 これ 以上 離れて 交わって も 実用上 意味 が ない */
const GROUND_EXTEND_M = 50

export function intersectGround(
  from: SectionPoint,
  sideSign: 1 | -1,
  slopeFactor: number,
  ground: SectionPoint[],
  opts?: {
    /**
     * 現況 の 測定範囲 の 外 で 交わる とき、 端 区間 の 勾配 を そのまま
     * 延長 して 交点 を 探す か。 測った 範囲 を 越える ので、 使った ときは
     * 呼び出し 側 に 知らせる (extrapolated)。
     */
    extendEnds?: boolean
  },
): { t: number; extrapolated: boolean } | null {
  const base = [...ground]
    .filter((p) => Number.isFinite(p.offset) && Number.isFinite(p.elevation))
    .sort((a, b) => a.offset - b.offset)
  if (base.length < 2) return null
  // 端 の 延長 は 「測った 区間」 と 区別 できる ように 別 に 持つ
  const realLo = base[0].offset
  const realHi = base[base.length - 1].offset
  const pts = [...base]
  if (opts?.extendEnds) {
    const a0 = base[0]
    const a1 = base[1]
    const m0 = (a1.elevation - a0.elevation) / (a1.offset - a0.offset)
    const b1 = base[base.length - 1]
    const b0 = base[base.length - 2]
    const m1 = (b1.elevation - b0.elevation) / (b1.offset - b0.offset)
    if (Number.isFinite(m0)) {
      pts.unshift({
        offset: a0.offset - GROUND_EXTEND_M,
        elevation: a0.elevation - m0 * GROUND_EXTEND_M,
      })
    }
    if (Number.isFinite(m1)) {
      pts.push({
        offset: b1.offset + GROUND_EXTEND_M,
        elevation: b1.elevation + m1 * GROUND_EXTEND_M,
      })
    }
  }
  const EPS = 1e-9
  let best: number | null = null
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const dx = b.offset - a.offset
    if (Math.abs(dx) < EPS) continue
    // この 区間 を 通る t の 範囲
    const tA = (a.offset - from.offset) / sideSign
    const tB = (b.offset - from.offset) / sideSign
    const tLo = Math.max(Math.min(tA, tB), EPS)
    const tHi = Math.max(tA, tB)
    if (tHi <= tLo) continue
    // 現況 の 高さ も t の 1 次式 に 直す
    const m = (b.elevation - a.elevation) / dx
    const c0 = from.elevation - a.elevation - m * (from.offset - a.offset)
    const c1 = slopeFactor - m * sideSign
    if (Math.abs(c1) < EPS) continue // 平行
    const t = -c0 / c1
    if (t < tLo - EPS || t > tHi + EPS) continue
    if (best == null || t < best) best = t
  }
  if (best == null) return null
  const x = from.offset + sideSign * best
  return { t: best, extrapolated: x < realLo - EPS || x > realHi + EPS }
}

export function solveSegment(
  mode: SegmentInputMode,
  v: {
    width: number | null
    height: number | null
    /** 外 へ 1m あたり の 上がり。 比率 0 など で 求まら ない ときは null */
    slopeFactor: number | null
    length: number | null
    /** 「現況まで」 の とき、 交点 から さらに 伸ばす 幅 [m] */
    marginW?: number | null
  },
  /** 「現況まで」 を 解く のに 要る 情報。 標準断面 の 定義 時 に は 無い */
  ctx?: {
    from: SectionPoint
    sideSign: 1 | -1
    ground: SectionPoint[] | null
    /**
     * 現況 の 測定範囲 の 外 で 交わる とき、 端 の 勾配 を 延長 して 良い か。
     * 既定 は true (延長 する)。 延長 して 求めた 場合 は value.extrapolated が true。
     */
    extendGround?: boolean
    /**
     * 入れた 向き で 届か ない とき、 上下 を 反転 して 探す か。 既定 は true。
     * 標準断面 の 法面 は 大きさ だけ を 決めて おき、 切土 の 測点 で は 上り、
     * 盛土 の 測点 で は 下り に なる の が 普通 な ため。
     * false に する と 入れた 向き だけ で 探す。
     */
    lockSlopeDirection?: boolean
  },
): SegmentSolveResult {
  const done = (w: number, h: number): SegmentSolveResult => ({
    ok: true,
    value: {
      w: r3(w),
      h: r3(h),
      f: Math.abs(w) < 1e-9 ? null : h / w,
      l: r3(Math.hypot(w, h)),
    },
  })

  if (mode === 'widthHeight') {
    if (v.width == null || v.height == null) return { ok: false, error: '幅 と 直高 を 入れて ください' }
    return done(v.width, v.height)
  }

  if (mode === 'widthSlope') {
    if (v.width == null) return { ok: false, error: '幅 と 勾配 を 入れて ください' }
    if (v.slopeFactor == null) return { ok: false, error: '勾配 を 入れて ください (比率 の 0 は 不可)' }
    return done(v.width, v.width * v.slopeFactor)
  }

  if (mode === 'heightSlope') {
    if (v.height == null) return { ok: false, error: '直高 と 勾配 を 入れて ください' }
    if (v.slopeFactor == null) return { ok: false, error: '勾配 を 入れて ください (比率 の 0 は 不可)' }
    if (Math.abs(v.slopeFactor) < 1e-9)
      return { ok: false, error: '勾配 0 では 直高 から 幅 を 出せません' }
    return done(v.height / v.slopeFactor, v.height)
  }

  if (mode === 'toGround') {
    if (v.slopeFactor == null)
      return { ok: false, error: '勾配 を 入れて ください (比率 の 0 は 不可)' }
    if (!ctx || !ctx.ground || ctx.ground.length < 2)
      return { ok: false, error: '長さ は 現況 と の 交点 で 決まります (取込 時 に 計算)' }
    const opts = { extendEnds: ctx.extendGround !== false }
    // まず 入れた 向き。 届か なければ 反転 して みる。
    // 法面 の 勾配 は 大きさ で 決まり、 上り か 下り かは 現況 が 基準点 より
    // 上 に ある か 下 に ある か で 決まる。 同じ 標準断面 を 切土 の 測点 でも
    // 盛土 の 測点 でも 使える ように する ため。
    let f = v.slopeFactor
    let hit = intersectGround(ctx.from, ctx.sideSign, f, ctx.ground, opts)
    let flipped = false
    if (hit == null && ctx.lockSlopeDirection !== true && Math.abs(f) > 1e-12) {
      const alt = intersectGround(ctx.from, ctx.sideSign, -f, ctx.ground, opts)
      if (alt != null) {
        hit = alt
        f = -f
        flipped = true
      }
    }
    if (hit == null) {
      // 何 と ぶつから なかった の か が 分かる ように 数字 を 添える。
      // 一番 多い の は 「勾配 の 向き が 逆」。 起点 が 現況 の 上 に あるのに
      // 上り を 指定 した (または 下 に あるのに 下り) と、 外 へ 行く ほど
      // 離れて いく ので 永久 に 交わら ない。
      const offs = ctx.ground.map((p) => p.offset)
      const lo = Math.min(...offs)
      const hi = Math.max(...offs)
      const gz = groundElevationAt(ctx.ground, ctx.from.offset)
      const dir = v.slopeFactor > 0 ? '上り' : v.slopeFactor < 0 ? '下り' : '水平'
      const parts = [
        '現況線 と 交わりません。',
        '基準点 は 離れ ' +
          ctx.from.offset.toFixed(3) +
          ' / 標高 ' +
          ctx.from.elevation.toFixed(3) +
          ' で、 そこ から ' +
          (ctx.sideSign > 0 ? '右' : '左') +
          'へ ' +
          dir +
          '。',
      ]
      if (gz != null) {
        const d = ctx.from.elevation - gz
        const rel = d > 0 ? '上' : d < 0 ? '下' : '同じ高さ'
        parts.push(
          'その 位置 の 現況 は 標高 ' +
            gz.toFixed(3) +
            ' な ので、 基準点 は 現況 の ' +
            Math.abs(d).toFixed(3) +
            'm ' +
            rel +
            '。',
        )
        parts.push('上り / 下り の 両方 を 試しました が 届きません でした。')
      }
      parts.push('現況 の 範囲 は 離れ ' + lo.toFixed(3) + ' ～ ' + hi.toFixed(3) + ' です。')
      return { ok: false, error: parts.join(' ') }
    }
    // 交点 から 先 は 同じ 勾配 の まま 幅方向 に 余裕分 だけ 伸ばす
    const w = hit.t + (v.marginW ?? 0)
    const r = done(w, w * f)
    if (r.ok) {
      if (hit.extrapolated) r.value.extrapolated = true
      if (flipped) r.value.flipped = true
    }
    return r
  }

  // lengthSlope: 法長 と 勾配。 幅 は 外 向き (正) に 取る
  if (v.length == null) return { ok: false, error: '法長 と 勾配 を 入れて ください' }
  if (v.slopeFactor == null) return { ok: false, error: '勾配 を 入れて ください (比率 の 0 は 不可)' }
  const l = Math.abs(v.length)
  const w = l / Math.hypot(1, v.slopeFactor)
  return done(w, w * v.slopeFactor)
}
