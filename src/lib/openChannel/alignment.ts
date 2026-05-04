// 小水路（明渠）の線形ジオメトリ
//
// 入力: 順序付きの XY 点列（BP → IP1 ... → EP）と各 IP の半径 R（0 = 角）
// 出力: 線形をサンプリングした連続点列（折点で R 補間）
// 　　　＋ 任意距離 → 座標 (測点座標) の問い合わせ

export interface XY {
  x: number
  y: number
}

export interface AlignmentVertex extends XY {
  /** 'bp' | 'ip' | 'ep' */
  kind: 'bp' | 'ip' | 'ep'
  /** IP のとき、単曲線の半径 (m)。0 または未指定なら直角折れ */
  radius?: number
}

export type AlignmentSegment =
  | {
      kind: 'line'
      p0: XY
      p1: XY
      length: number
    }
  | {
      kind: 'arc'
      center: XY
      radius: number
      a0: number
      dA: number
      length: number
    }

const EPS = 1e-9

function dist(a: XY, b: XY): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function normalize(v: XY): XY {
  const m = Math.hypot(v.x, v.y)
  return m < EPS ? { x: 0, y: 0 } : { x: v.x / m, y: v.y / m }
}

function sub(a: XY, b: XY): XY {
  return { x: a.x - b.x, y: a.y - b.y }
}

interface IpArc {
  i: number
  tc: XY
  ct: XY
  center: XY
  a0: number
  dA: number
  radius: number
}

/**
 * 各 IP に対して単曲線を当て、(TC, CT, center, a0, dA, R) を求める。
 * R が無効、または偏角が小さすぎる場合は対象から外す（その IP は角折れとして扱われる）。
 */
function computeIpArcs(vertices: AlignmentVertex[]): IpArc[] {
  const out: IpArc[] = []
  for (let i = 1; i < vertices.length - 1; i++) {
    const v = vertices[i]
    if (v.kind !== 'ip') continue
    const requestedR = v.radius
    if (!requestedR || requestedR <= 0) continue
    const prev = vertices[i - 1]
    const next = vertices[i + 1]
    const dirIn = normalize(sub(v, prev))
    const dirOut = normalize(sub(next, v))
    const dot = Math.max(-1, Math.min(1, dirIn.x * dirOut.x + dirIn.y * dirOut.y))
    const theta = Math.acos(dot)
    if (theta < EPS) continue
    // 接線長 T = R * tan(θ/2)。隣接区間長を超えるなら R を縮める。
    const T = requestedR * Math.tan(theta / 2)
    const inLen = dist(prev, v)
    const outLen = dist(v, next)
    const Tmax = Math.min(inLen, outLen) * 0.95
    const Teff = Math.min(T, Tmax)
    const Reff = Teff / Math.tan(theta / 2)
    const tc = { x: v.x - dirIn.x * Teff, y: v.y - dirIn.y * Teff }
    const ct = { x: v.x + dirOut.x * Teff, y: v.y + dirOut.y * Teff }
    // 中心 = TC + 法線 (in 方向 CCW90°) * sign * R
    const nIn: XY = { x: -dirIn.y, y: dirIn.x }
    const cross = dirIn.x * dirOut.y - dirIn.y * dirOut.x
    const sign = cross >= 0 ? 1 : -1
    const center = {
      x: tc.x + nIn.x * sign * Reff,
      y: tc.y + nIn.y * sign * Reff,
    }
    const a0 = Math.atan2(tc.y - center.y, tc.x - center.x)
    const a1 = Math.atan2(ct.y - center.y, ct.x - center.x)
    let dA = a1 - a0
    if (sign > 0) {
      while (dA <= 0) dA += Math.PI * 2
    } else {
      while (dA >= 0) dA -= Math.PI * 2
    }
    out.push({ i, tc, ct, center, a0, dA, radius: Reff })
  }
  return out
}

/**
 * 線形を「直線セグメント」「円弧セグメント」の配列に分解する。
 * BP → (line→) TC1 → (arc) → CT1 → (line→) TC2 → ... → EP の順。
 */
export function buildSegments(vertices: AlignmentVertex[]): AlignmentSegment[] {
  const segs: AlignmentSegment[] = []
  if (vertices.length < 2) return segs
  const arcs = computeIpArcs(vertices)
  let cur: XY = { x: vertices[0].x, y: vertices[0].y }
  for (let i = 1; i < vertices.length; i++) {
    const arc = arcs.find((a) => a.i === i)
    if (arc) {
      const lineLen = dist(cur, arc.tc)
      if (lineLen > EPS) {
        segs.push({ kind: 'line', p0: cur, p1: arc.tc, length: lineLen })
      }
      const arcLen = arc.radius * Math.abs(arc.dA)
      segs.push({
        kind: 'arc',
        center: arc.center,
        radius: arc.radius,
        a0: arc.a0,
        dA: arc.dA,
        length: arcLen,
      })
      cur = arc.ct
    } else {
      const target: XY = { x: vertices[i].x, y: vertices[i].y }
      const lineLen = dist(cur, target)
      if (lineLen > EPS) {
        segs.push({ kind: 'line', p0: cur, p1: target, length: lineLen })
      }
      cur = target
    }
  }
  return segs
}

/** 線形の総延長 (m) — セグメントベース（円弧は弧長で正確に算出）。 */
export function totalLength(segments: AlignmentSegment[]): number {
  return segments.reduce((sum, s) => sum + s.length, 0)
}

/** vertex 列から直接、合計延長を求める */
export function alignmentTotalLength(vertices: AlignmentVertex[]): number {
  return totalLength(buildSegments(vertices))
}

/**
 * 線形の起点 (BP) からの距離 d (m) における点を返す。
 * 範囲外の場合は端にクランプ。線形が空のとき null。
 */
export function pointAtDistance(
  segments: AlignmentSegment[],
  distance: number,
): XY | null {
  if (segments.length === 0) return null
  if (distance <= 0) {
    const s = segments[0]
    if (s.kind === 'line') return { x: s.p0.x, y: s.p0.y }
    return {
      x: s.center.x + s.radius * Math.cos(s.a0),
      y: s.center.y + s.radius * Math.sin(s.a0),
    }
  }
  let acc = 0
  for (let idx = 0; idx < segments.length; idx++) {
    const s = segments[idx]
    const isLast = idx === segments.length - 1
    if (distance <= acc + s.length + EPS || isLast) {
      const local = distance - acc
      const t = s.length < EPS ? 0 : Math.max(0, Math.min(1, local / s.length))
      if (s.kind === 'line') {
        return {
          x: s.p0.x + (s.p1.x - s.p0.x) * t,
          y: s.p0.y + (s.p1.y - s.p0.y) * t,
        }
      }
      const a = s.a0 + s.dA * t
      return {
        x: s.center.x + s.radius * Math.cos(a),
        y: s.center.y + s.radius * Math.sin(a),
      }
    }
    acc += s.length
  }
  return null
}

/**
 * 線形を XY[] にサンプリング。直線は端点のみ、円弧は arcSamples 等分の細分。
 * 隣接セグメントが共有する端点を重複させずに 1 度ずつ出力する。
 */
export function sampleAlignment(
  vertices: AlignmentVertex[],
  arcSamples = 64,
): XY[] {
  if (vertices.length < 2) return vertices.map((v) => ({ x: v.x, y: v.y }))
  const segs = buildSegments(vertices)
  if (segs.length === 0) return vertices.map((v) => ({ x: v.x, y: v.y }))
  const out: XY[] = []
  const first = segs[0]
  if (first.kind === 'line') {
    out.push({ x: first.p0.x, y: first.p0.y })
  } else {
    out.push({
      x: first.center.x + first.radius * Math.cos(first.a0),
      y: first.center.y + first.radius * Math.sin(first.a0),
    })
  }
  for (const s of segs) {
    if (s.kind === 'line') {
      out.push({ x: s.p1.x, y: s.p1.y })
    } else {
      const N = Math.max(2, Math.round(arcSamples * (Math.abs(s.dA) / Math.PI)))
      for (let k = 1; k <= N; k++) {
        const t = k / N
        const a = s.a0 + s.dA * t
        out.push({
          x: s.center.x + s.radius * Math.cos(a),
          y: s.center.y + s.radius * Math.sin(a),
        })
      }
    }
  }
  return out
}

/** XY サンプル列の合計距離 — 後方互換のため残置（折線近似のため arc は若干過小）。 */
export function alignmentLength(samples: XY[]): number {
  let total = 0
  for (let i = 1; i < samples.length; i++) total += dist(samples[i - 1], samples[i])
  return total
}
