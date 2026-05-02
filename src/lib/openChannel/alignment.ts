// 小水路（明渠）の線形ジオメトリ
//
// 入力: 順序付きの XY 点列（BP → IP1 ... → EP）と各 IP の半径 R（0 = 角）
// 出力: 線形をサンプリングした連続点列（折点で R 補間）

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

/**
 * IP に半径 R の単曲線を当てて、その IP 周辺で線形を「IPからの直前ベクトル方向に T 戻った点（TC）→ 円弧 → 続く方向に T 進んだ点（CT）」のサンプル列に置き換える。
 *
 * @returns alignment 全体を等間隔近似でサンプリングした XY[]。直線部分は端点のみ、曲線部分は arcSamples 等分。
 */
export function sampleAlignment(
  vertices: AlignmentVertex[],
  arcSamples = 16,
): XY[] {
  if (vertices.length < 2) return vertices.slice()
  const out: XY[] = []
  // 各頂点について、円弧化が必要なら円弧の TC/CT と中心を求める
  // i 番目の頂点が IP で R>0 のとき、直前の直線 (V[i-1]→V[i]) の終端を TC、直後の直線 (V[i]→V[i+1]) の始端を CT に置換
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i]
    const isMid = i > 0 && i < vertices.length - 1
    const radius = v.kind === 'ip' && v.radius && v.radius > 0 ? v.radius : 0
    if (!isMid || radius === 0) {
      out.push({ x: v.x, y: v.y })
      continue
    }
    const prev = vertices[i - 1]
    const next = vertices[i + 1]
    const dirIn = normalize(sub(v, prev))
    const dirOut = normalize(sub(next, v))
    // 偏角 θ（0..π）。dot = cos θ
    const dot = Math.max(-1, Math.min(1, dirIn.x * dirOut.x + dirIn.y * dirOut.y))
    const theta = Math.acos(dot) // 偏角
    if (theta < EPS) {
      // ほぼ直線：そのまま
      out.push({ x: v.x, y: v.y })
      continue
    }
    // 接線長 T = R * tan(θ/2)
    const T = radius * Math.tan(theta / 2)
    // 隣接区間長を超えるなら R を縮める（簡易）
    const inLen = dist(prev, v)
    const outLen = dist(v, next)
    const Tmax = Math.min(inLen, outLen) * 0.95
    const Teff = Math.min(T, Tmax)
    const Reff = Teff / Math.tan(theta / 2)
    // TC = IP + (-dirIn) * Teff
    const tc = { x: v.x - dirIn.x * Teff, y: v.y - dirIn.y * Teff }
    // CT = IP + dirOut * Teff
    const ct = { x: v.x + dirOut.x * Teff, y: v.y + dirOut.y * Teff }
    // 中心 = TC + 法線 (in 方向に対して 90°、ベンドの内側) * R
    // dirIn の左側（CCW 90°）に向くベクトル
    const nIn: XY = { x: -dirIn.y, y: dirIn.x }
    // 偏向方向: dirOut の dirIn 周りの符号で判別
    const cross = dirIn.x * dirOut.y - dirIn.y * dirOut.x
    const sign = cross >= 0 ? 1 : -1
    const center = {
      x: tc.x + nIn.x * sign * Reff,
      y: tc.y + nIn.y * sign * Reff,
    }
    // 円弧をサンプリング
    const a0 = Math.atan2(tc.y - center.y, tc.x - center.x)
    const a1 = Math.atan2(ct.y - center.y, ct.x - center.x)
    let dA = a1 - a0
    if (sign > 0) {
      // CCW
      while (dA <= 0) dA += Math.PI * 2
    } else {
      // CW
      while (dA >= 0) dA -= Math.PI * 2
    }
    const N = Math.max(2, Math.round(arcSamples * (Math.abs(dA) / Math.PI)))
    for (let k = 0; k <= N; k++) {
      const a = a0 + (dA * k) / N
      out.push({
        x: center.x + Reff * Math.cos(a),
        y: center.y + Reff * Math.sin(a),
      })
    }
  }
  return out
}

/**
 * 線形の総延長 (m)
 */
export function alignmentLength(samples: XY[]): number {
  let total = 0
  for (let i = 1; i < samples.length; i++) total += dist(samples[i - 1], samples[i])
  return total
}
