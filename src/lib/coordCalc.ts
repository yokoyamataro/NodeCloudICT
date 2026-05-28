// 座標計算（交点計算・線上計算）。平面直角座標 x=北(N) / y=東(E) を前提。
// 「右」は線の進行方向（始点→終点）を向いて右側を正とする。

export interface XY {
  x: number // 北 N
  y: number // 東 E
}

// 2点の長さ
function len(a: XY, b: XY): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

// 線(a→b)を右方向に offset(m) 平行移動した2点を返す。
export function offsetLine(a: XY, b: XY, offset: number): [XY, XY] {
  const dN = b.x - a.x
  const dE = b.y - a.y
  const L = Math.hypot(dN, dE)
  if (L === 0 || offset === 0) return [a, b]
  // 進行方向(x=N,y=E)に対する右単位ベクトル = (-dE, dN)/L
  const rx = (-dE / L) * offset
  const ry = (dN / L) * offset
  return [
    { x: a.x + rx, y: a.y + ry },
    { x: b.x + rx, y: b.y + ry },
  ]
}

// 2直線（各2点）の交点。平行ならnull。
export function intersect(a1: XY, a2: XY, b1: XY, b2: XY): XY | null {
  const x1 = a1.x, y1 = a1.y
  const x2 = a2.x, y2 = a2.y
  const x3 = b1.x, y3 = b1.y
  const x4 = b2.x, y4 = b2.y
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
  if (Math.abs(den) < 1e-9) return null
  const pre = x1 * y2 - y1 * x2
  const post = x3 * y4 - y3 * x4
  const px = (pre * (x3 - x4) - (x1 - x2) * post) / den
  const py = (pre * (y3 - y4) - (y1 - y2) * post) / den
  return { x: px, y: py }
}

// 交点計算: 2線（各2点＋右オフセットm）の交点。
export function intersectionCalc(
  line1: { a: XY; b: XY; offset: number },
  line2: { a: XY; b: XY; offset: number },
): XY | null {
  const [a1, a2] = offsetLine(line1.a, line1.b, line1.offset)
  const [b1, b2] = offsetLine(line2.a, line2.b, line2.offset)
  return intersect(a1, a2, b1, b2)
}

// 線上計算: 始点 start から 終点 toward 方向へ、延長 ext(m, +前方) ・ 左右 lat(m, +右) ずらした点。
export function onLineCalc(start: XY, toward: XY, ext: number, lat: number): XY | null {
  const dN = toward.x - start.x
  const dE = toward.y - start.y
  const L = Math.hypot(dN, dE)
  if (L === 0) return null
  const ux = dN / L
  const uy = dE / L
  const rx = -dE / L // 右単位ベクトル(x=N)
  const ry = dN / L // 右単位ベクトル(y=E)
  return {
    x: start.x + ext * ux + lat * rx,
    y: start.y + ext * uy + lat * ry,
  }
}

export { len }
