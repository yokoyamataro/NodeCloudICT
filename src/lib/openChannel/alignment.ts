// 小水路（明渠）の線形ジオメトリ
//
// 入力: 順序付きの XY 点列（BP → IP1 ... → EP）と各 IP の
//   - R     : 単曲線半径 (m)。0 / 未指定なら直角折れ
//   - A_in  : クロソイドパラメータ A（IN 側、対称化なら A_out と同じ）
//   - A_out : クロソイドパラメータ A（OUT 側）
// 出力: 線形をサンプリングした連続点列（折点で R 補間 + 必要なら緩和曲線）
// 　　　＋ 任意距離 → 座標 (測点座標) の問い合わせ

import {
  clothoidPoint,
  clothoidPointOut,
  clothoidTangent,
  ipClothoidGeometry,
  sampleClothoid,
  type IpClothoidGeometry,
} from '../clothoid'

export interface XY {
  x: number
  y: number
}

export interface AlignmentVertex extends XY {
  /** 'bp' | 'ip' | 'ep' */
  kind: 'bp' | 'ip' | 'ep'
  /** IP のとき、単曲線の半径 (m)。0 または未指定なら直角折れ */
  radius?: number
  /** IP のとき、IN 側クロソイドパラメータ A (m)。0 / 未指定で緩和曲線なし */
  spiralAIn?: number
  /** IP のとき、OUT 側クロソイドパラメータ A (m)。0 / 未指定で緩和曲線なし */
  spiralAOut?: number
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
  | {
      kind: 'spiral'
      /** 区間の始点（'in' の場合 TS、'out' の場合 CS） */
      p0: XY
      /** p0 における進行方向の単位ベクトル */
      tangent0: XY
      A: number
      length: number
      /** +1 = CCW（左旋回）, -1 = CW（右旋回） */
      rotSign: 1 | -1
      /** 'in' = 直線→曲線（κ:0→1/R）、'out' = 曲線→直線（κ:1/R→0） */
      direction: 'in' | 'out'
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

interface IpTransition {
  i: number
  /** TS（直線→IN緩和始点）。緩和なしのとき = TC（直線→単曲線始点） */
  ts: XY
  /** SC（IN緩和終点 = 単曲線始点）。緩和なしのとき = TC（= ts） */
  sc: XY
  /** CS（単曲線終点 = OUT緩和始点）。緩和なしのとき = CT（直線→次直線への接続点） */
  cs: XY
  /** ST（OUT緩和終点 = 次直線始点）。緩和なしのとき = CT（= cs） */
  st: XY
  /** 単曲線中心 */
  center: XY
  /** 中央円弧の始角・回転角 */
  a0: number
  dA: number
  radius: number
  /** IN/OUT 緩和曲線パラメータ。0 のとき緩和なし */
  Ain: number
  Aout: number
  /** 旋回方向 +1=CCW(左), -1=CW(右) */
  rotSign: 1 | -1
  /** IN 緩和の接線方向（TS で進行する向き） */
  dirIn: XY
  /** OUT 緩和の接線方向（ST で進行する向き） */
  dirOut: XY
}

/**
 * 各 IP に対して「直線 → クロソイド(IN, A_in) → 単曲線(R) → クロソイド(OUT, A_out) → 直線」
 * を当てはめ、必要な制御点を計算する。
 * R が無効・偏角が小さすぎる・クロソイド長が IP 両側の直線長を超える等は対象外（角折れ扱い）。
 */
function computeIpTransitions(vertices: AlignmentVertex[]): IpTransition[] {
  const out: IpTransition[] = []
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
    const Ain = v.spiralAIn && v.spiralAIn > 0 ? v.spiralAIn : 0
    const Aout = v.spiralAOut && v.spiralAOut > 0 ? v.spiralAOut : 0
    const cross = dirIn.x * dirOut.y - dirIn.y * dirOut.x
    const sign: 1 | -1 = cross >= 0 ? 1 : -1

    // 隣接直線長（接線長の上限）
    const inLen = dist(prev, v)
    const outLen = dist(v, next)
    const Tmax = Math.min(inLen, outLen) * 0.95

    // クロソイドあり/なしで R を「収まる範囲で」縮小する。
    // 単純化: ユーザー指定 R を採用、収まらなければクロソイドありの式で R を縮める。
    let Reff = requestedR
    let geom: IpClothoidGeometry = ipClothoidGeometry(theta, Reff, Ain, Aout)
    const Tlimit = Math.max(geom.Tin, geom.Tout)
    if (!geom.valid || Tlimit > Tmax || !Number.isFinite(Tlimit)) {
      // 二分法で R を縮める
      let lo = 0.5
      let hi = Reff
      for (let it = 0; it < 30; it++) {
        const mid = (lo + hi) / 2
        const g = ipClothoidGeometry(theta, mid, Ain, Aout)
        const TmaxNow = Math.max(g.Tin, g.Tout)
        if (g.valid && Number.isFinite(TmaxNow) && TmaxNow <= Tmax) lo = mid
        else hi = mid
      }
      Reff = lo
      geom = ipClothoidGeometry(theta, Reff, Ain, Aout)
      if (!geom.valid) continue
    }

    // TS / ST: IP から接線長分戻った点
    const ts: XY = { x: v.x - dirIn.x * geom.Tin, y: v.y - dirIn.y * geom.Tin }
    const st: XY = { x: v.x + dirOut.x * geom.Tout, y: v.y + dirOut.y * geom.Tout }

    // SC: TS から IN-接線方向に進み、クロソイドを通って到達
    // 局所座標 (Xm_in, Ym_in) を sign に応じて法線方向に展開
    const nIn: XY = { x: -dirIn.y * sign, y: dirIn.x * sign } // 旋回内側
    const sc: XY = {
      x: ts.x + dirIn.x * geom.XmIn + nIn.x * geom.YmIn,
      y: ts.y + dirIn.y * geom.XmIn + nIn.y * geom.YmIn,
    }

    // CS: ST から OUT-逆方向に進み、クロソイドを通って到達
    const nOut: XY = { x: -dirOut.y * sign, y: dirOut.x * sign }
    const cs: XY = {
      x: st.x - dirOut.x * geom.XmOut + nOut.x * geom.YmOut,
      y: st.y - dirOut.y * geom.XmOut + nOut.y * geom.YmOut,
    }

    // 単曲線中心: SC の接線（dirIn を τ_in だけ sign 方向に回転）に対する法線上、距離 R
    const c = Math.cos(sign * geom.tauIn)
    const s = Math.sin(sign * geom.tauIn)
    const tanAtSC: XY = { x: dirIn.x * c - dirIn.y * s, y: dirIn.x * s + dirIn.y * c }
    const nAtSC: XY = { x: -tanAtSC.y * sign, y: tanAtSC.x * sign }
    const center: XY = {
      x: sc.x + nAtSC.x * Reff,
      y: sc.y + nAtSC.y * Reff,
    }

    const a0 = Math.atan2(sc.y - center.y, sc.x - center.x)
    const a1 = Math.atan2(cs.y - center.y, cs.x - center.x)
    let dA = a1 - a0
    if (sign > 0) {
      while (dA <= 0) dA += Math.PI * 2
    } else {
      while (dA >= 0) dA -= Math.PI * 2
    }

    out.push({
      i,
      ts,
      sc,
      cs,
      st,
      center,
      a0,
      dA,
      radius: Reff,
      Ain,
      Aout,
      rotSign: sign,
      dirIn,
      dirOut,
    })
  }
  return out
}

/**
 * 線形を「直線 / 単曲線 / クロソイド」のセグメント列に分解する。
 * BP → (line→) TS → (spiral) → SC → (arc) → CS → (spiral) → ST → (line→) ... → EP
 * クロソイド未指定の IP では TS=SC=TC, CS=ST=CT に縮約され、line→arc→line となる。
 */
export function buildSegments(vertices: AlignmentVertex[]): AlignmentSegment[] {
  const segs: AlignmentSegment[] = []
  if (vertices.length < 2) return segs
  const trans = computeIpTransitions(vertices)
  let cur: XY = { x: vertices[0].x, y: vertices[0].y }
  for (let i = 1; i < vertices.length; i++) {
    const t = trans.find((a) => a.i === i)
    if (t) {
      // 直線: cur → TS
      const lineLen = dist(cur, t.ts)
      if (lineLen > EPS) segs.push({ kind: 'line', p0: cur, p1: t.ts, length: lineLen })
      // IN クロソイド（TS → SC、曲率 0→1/R）
      if (t.Ain > 0) {
        const Lin = (t.Ain * t.Ain) / t.radius
        segs.push({
          kind: 'spiral',
          p0: t.ts,
          tangent0: t.dirIn,
          A: t.Ain,
          length: Lin,
          rotSign: t.rotSign,
          direction: 'in',
        })
      }
      // 単曲線
      const arcLen = t.radius * Math.abs(t.dA)
      if (arcLen > EPS) {
        segs.push({
          kind: 'arc',
          center: t.center,
          radius: t.radius,
          a0: t.a0,
          dA: t.dA,
          length: arcLen,
        })
      }
      // OUT クロソイド（CS → ST、曲率 1/R→0）
      // CS における進行方向の単位接線 = dirOut を rotSign 方向と逆に τ_out だけ回転
      if (t.Aout > 0) {
        const Lout = (t.Aout * t.Aout) / t.radius
        const tauOut = (Lout * Lout) / (2 * t.Aout * t.Aout)
        const c = Math.cos(-t.rotSign * tauOut)
        const s = Math.sin(-t.rotSign * tauOut)
        const tanAtCS: XY = {
          x: t.dirOut.x * c - t.dirOut.y * s,
          y: t.dirOut.x * s + t.dirOut.y * c,
        }
        segs.push({
          kind: 'spiral',
          p0: t.cs,
          tangent0: tanAtCS,
          A: t.Aout,
          length: Lout,
          rotSign: t.rotSign,
          direction: 'out',
        })
      }
      cur = t.st
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
 * 線形の起点 (BP) からの距離 d (m) における進行方向（単位接線ベクトル）を返す。
 * 線形が空のとき null。
 */
export function tangentAtDistance(
  segments: AlignmentSegment[],
  distance: number,
): XY | null {
  if (segments.length === 0) return null
  const target = Math.max(0, distance)
  let acc = 0
  for (let idx = 0; idx < segments.length; idx++) {
    const s = segments[idx]
    const isLast = idx === segments.length - 1
    if (target <= acc + s.length + EPS || isLast) {
      const local = target - acc
      const t = s.length < EPS ? 0 : Math.max(0, Math.min(1, local / s.length))
      if (s.kind === 'line') {
        const dx = s.p1.x - s.p0.x
        const dy = s.p1.y - s.p0.y
        const m = Math.hypot(dx, dy)
        if (m < EPS) return { x: 1, y: 0 }
        return { x: dx / m, y: dy / m }
      }
      if (s.kind === 'arc') {
        // 円弧の進行方向: pos(a) = C + R*(cos a, sin a), 単位接線 = sign(dA) * (-sin a, cos a)
        const a = s.a0 + s.dA * t
        const dir = s.dA >= 0 ? 1 : -1
        return { x: -Math.sin(a) * dir, y: Math.cos(a) * dir }
      }
      // spiral
      const localTan = clothoidTangent(local, s.A, s.length, s.direction)
      const tx = s.tangent0.x
      const ty = s.tangent0.y
      const nxL = -ty
      const nyL = tx
      const yL = s.rotSign * localTan.y
      return {
        x: tx * localTan.x + nxL * yL,
        y: ty * localTan.x + nyL * yL,
      }
    }
    acc += s.length
  }
  return null
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
    if (s.kind === 'arc')
      return {
        x: s.center.x + s.radius * Math.cos(s.a0),
        y: s.center.y + s.radius * Math.sin(s.a0),
      }
    return { x: s.p0.x, y: s.p0.y }
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
      if (s.kind === 'arc') {
        const a = s.a0 + s.dA * t
        return {
          x: s.center.x + s.radius * Math.cos(a),
          y: s.center.y + s.radius * Math.sin(a),
        }
      }
      // spiral
      const localPos =
        s.direction === 'in'
          ? clothoidPoint(local, s.A)
          : clothoidPointOut(local, s.A, s.length)
      const tx = s.tangent0.x
      const ty = s.tangent0.y
      const nxL = -ty
      const nyL = tx
      const yL = s.rotSign * localPos.y
      return {
        x: s.p0.x + tx * localPos.x + nxL * yL,
        y: s.p0.y + ty * localPos.x + nyL * yL,
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
  // 始点
  const first = segs[0]
  if (first.kind === 'line') {
    out.push({ x: first.p0.x, y: first.p0.y })
  } else if (first.kind === 'arc') {
    out.push({
      x: first.center.x + first.radius * Math.cos(first.a0),
      y: first.center.y + first.radius * Math.sin(first.a0),
    })
  } else {
    out.push({ x: first.p0.x, y: first.p0.y })
  }
  for (const s of segs) {
    if (s.kind === 'line') {
      out.push({ x: s.p1.x, y: s.p1.y })
    } else if (s.kind === 'arc') {
      const N = Math.max(2, Math.round(arcSamples * (Math.abs(s.dA) / Math.PI)))
      for (let k = 1; k <= N; k++) {
        const t = k / N
        const a = s.a0 + s.dA * t
        out.push({
          x: s.center.x + s.radius * Math.cos(a),
          y: s.center.y + s.radius * Math.sin(a),
        })
      }
    } else {
      // spiral: arcSamples の τ 比率で分割
      const tau = (s.length * s.length) / (2 * s.A * s.A)
      const N = Math.max(8, Math.round(arcSamples * (tau / Math.PI)))
      const pts = sampleClothoid(
        s.p0,
        s.tangent0,
        s.A,
        s.length,
        s.rotSign,
        s.direction,
        N,
        false,
      )
      for (const p of pts) out.push(p)
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

/** 円弧の始点 (BC) / 終点 (EC)、緩和曲線の TS/SC/CS/ST を BP からの追加距離で列挙する。 */
export interface CurveMarker {
  kind: 'bc' | 'ec' | 'ts' | 'sc' | 'cs' | 'st'
  distance: number
}

export function getCurveMarkers(segments: AlignmentSegment[]): CurveMarker[] {
  const out: CurveMarker[] = []
  let acc = 0
  for (const s of segments) {
    if (s.kind === 'arc') {
      out.push({ kind: 'bc', distance: acc })
      out.push({ kind: 'ec', distance: acc + s.length })
    } else if (s.kind === 'spiral') {
      if (s.direction === 'in') {
        out.push({ kind: 'ts', distance: acc })
        out.push({ kind: 'sc', distance: acc + s.length })
      } else {
        out.push({ kind: 'cs', distance: acc })
        out.push({ kind: 'st', distance: acc + s.length })
      }
    }
    acc += s.length
  }
  return out
}

/**
 * R=0（または未指定）で角折れとなっている IP の、BP からの追加距離を列挙する。
 * 単曲線が当たっている IP（路線上の頂点を通らない）は対象外。
 */
export function getCornerIpStations(
  vertices: AlignmentVertex[],
): { vertexIndex: number; distance: number }[] {
  const out: { vertexIndex: number; distance: number }[] = []
  if (vertices.length < 2) return out
  const transMap = new Map<number, IpTransition>()
  for (const a of computeIpTransitions(vertices)) transMap.set(a.i, a)
  let acc = 0
  let cur: XY = { x: vertices[0].x, y: vertices[0].y }
  for (let i = 1; i < vertices.length; i++) {
    const tr = transMap.get(i)
    if (tr) {
      acc += dist(cur, tr.ts)
      if (tr.Ain > 0) acc += (tr.Ain * tr.Ain) / tr.radius
      acc += tr.radius * Math.abs(tr.dA)
      if (tr.Aout > 0) acc += (tr.Aout * tr.Aout) / tr.radius
      cur = tr.st
      // 単曲線 IP は経路を通らないので除外
      continue
    }
    const v = vertices[i]
    const target: XY = { x: v.x, y: v.y }
    acc += dist(cur, target)
    cur = target
    // BP/EP ではなく、kind が IP の頂点 = 折点
    if (i < vertices.length - 1 && v.kind === 'ip') {
      out.push({ vertexIndex: i, distance: acc })
    }
  }
  return out
}
