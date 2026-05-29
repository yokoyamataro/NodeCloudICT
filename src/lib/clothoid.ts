// クロソイド（緩和曲線）の数値計算ライブラリ。
//
// 表記:
//   A   : クロソイドパラメータ (m)。A² = R · L の関係。
//   R   : 単曲線半径 (m)
//   L   : クロソイド長 (m) = A² / R
//   τ   : 終端での接線回転角 (rad) = L² / (2A²) = L / (2R)
//   (Xm, Ym) : TS（クロソイド始点 = 直線→クロソイド境）を原点、
//              直線方向を +x 軸としたとき、SC（クロソイド終点 = 単曲線始点）の座標。
//   p   : 単曲線中心の TS 接線からのオフセット = Ym - R(1 - cos τ)
//   k   : SC を経たときの x シフト = Xm - R sin τ
//
// 非対称クロソイド（IN, OUT で A が異なる）における IP からの接線長:
//   T_in  = (R + p_out) / sin(φ) - (R + p_in) / tan(φ) + k_in
//   T_out = (R + p_in) / sin(φ) - (R + p_out) / tan(φ) + k_out
//   ここで φ は IP の偏角（測量で言う「交角」、deflection angle）。
//   対称(p_in=p_out=p, k_in=k_out=k)のとき (R+p)tan(φ/2)+k に縮約される。
//
// 参考: 道路土工 / 鉄道土木 / 測量学の標準的な式。

export interface XY {
  x: number
  y: number
}

const EPS = 1e-9

/**
 * クロソイドの始点 TS から弧長 s 進んだ点の TS-接線座標 (X, Y) を求める。
 * 級数展開（τ = s²/(2A²) で展開）。τ ≲ π/2 程度まで実用精度。
 */
export function clothoidPoint(s: number, A: number): XY {
  if (A <= 0) return { x: s, y: 0 }
  const tau = (s * s) / (2 * A * A)
  // X = s · (1 - τ²/10 + τ⁴/216 - τ⁶/9360 + τ⁸/685440 - ...)
  // Y = s · (τ/3 - τ³/42 + τ⁵/1320 - τ⁷/75600 + ...)
  const t2 = tau * tau
  const t3 = t2 * tau
  const t4 = t2 * t2
  const t5 = t4 * tau
  const x = s * (1 - t2 / 10 + t4 / 216 - (t4 * t2) / 9360)
  const y = s * (tau / 3 - t3 / 42 + t5 / 1320)
  return { x, y }
}

/** クロソイド終端での接線方向回転角 τ (rad)。 */
export function clothoidTau(L: number, A: number): number {
  if (A <= 0) return 0
  return (L * L) / (2 * A * A)
}

/** A と R から L を求める。 */
export function clothoidLength(A: number, R: number): number {
  if (A <= 0 || R <= 0) return 0
  return (A * A) / R
}

/**
 * IP の偏角 φ (rad)、半径 R、A_in / A_out から、IP の両側接線長 T_in, T_out と
 * 各種シフト量、クロソイド長を計算する。
 *
 * 戻り値の rotSign は IP の旋回方向 (+1 = CCW, -1 = CW)。サイトの利用側で渡す。
 * φ は 0 < φ < π の正の値で渡すこと（旋回方向は別途）。
 */
export interface IpClothoidGeometry {
  R: number
  Lin: number
  Lout: number
  tauIn: number
  tauOut: number
  XmIn: number
  YmIn: number
  XmOut: number
  YmOut: number
  pIn: number
  pOut: number
  kIn: number
  kOut: number
  Tin: number
  Tout: number
  /** 単曲線（中央円弧）部分の中央角 (rad) = φ - τ_in - τ_out */
  arcDeflect: number
  /** 単曲線中央部の弧長 (m) */
  arcLength: number
  /** 幾何が成立するか（τ_in + τ_out が φ を超えない、T が正、など） */
  valid: boolean
  reason?: string
}

export function ipClothoidGeometry(
  phi: number,
  R: number,
  Ain: number,
  Aout: number,
): IpClothoidGeometry {
  const Lin = clothoidLength(Ain, R)
  const Lout = clothoidLength(Aout, R)
  const tauIn = clothoidTau(Lin, Ain)
  const tauOut = clothoidTau(Lout, Aout)
  const { x: XmIn, y: YmIn } = clothoidPoint(Lin, Ain)
  const { x: XmOut, y: YmOut } = clothoidPoint(Lout, Aout)
  const pIn = YmIn - R * (1 - Math.cos(tauIn))
  const pOut = YmOut - R * (1 - Math.cos(tauOut))
  const kIn = XmIn - R * Math.sin(tauIn)
  const kOut = XmOut - R * Math.sin(tauOut)

  const sinPhi = Math.sin(phi)
  const tanPhi = Math.tan(phi)
  const Tin =
    Math.abs(sinPhi) < EPS
      ? Infinity
      : (R + pOut) / sinPhi - (R + pIn) / tanPhi + kIn
  const Tout =
    Math.abs(sinPhi) < EPS
      ? Infinity
      : (R + pIn) / sinPhi - (R + pOut) / tanPhi + kOut

  const arcDeflect = phi - tauIn - tauOut
  const arcLength = arcDeflect * R

  let valid = true
  let reason: string | undefined
  if (R <= 0) {
    valid = false
    reason = '半径Rが不正'
  } else if (arcDeflect < -EPS) {
    valid = false
    reason = 'クロソイドが大きすぎる（τ_in+τ_out > φ）。A を小さくしてください'
  } else if (Tin < -EPS || Tout < -EPS) {
    valid = false
    reason = '接線長が負になります。R または A を見直してください'
  } else if (!Number.isFinite(Tin) || !Number.isFinite(Tout)) {
    valid = false
    reason = '偏角 φ が小さすぎる（直線同等）'
  }

  return {
    R,
    Lin,
    Lout,
    tauIn,
    tauOut,
    XmIn,
    YmIn,
    XmOut,
    YmOut,
    pIn,
    pOut,
    kIn,
    kOut,
    Tin,
    Tout,
    arcDeflect: Math.max(0, arcDeflect),
    arcLength: Math.max(0, arcLength),
    valid,
    reason,
  }
}

/**
 * OUT クロソイド (CS → ST、曲率 1/R → 0) の、CS-接線局所フレームでの位置。
 * 導出: θ_out(s) = (Ls - s²/2)/A² と置き、IN クロソイドとの関係
 *   x_out(s) =  cos τ · ΔX + sin τ · ΔY
 *   y_out(s) =  sin τ · ΔX − cos τ · ΔY
 *   ただし τ = L²/(2A²), ΔX = Xm(L) − Xm(L−s), ΔY = Ym(L) − Ym(L−s)
 */
export function clothoidPointOut(s: number, A: number, L: number): XY {
  if (A <= 0 || L <= 0) return { x: s, y: 0 }
  const tau = (L * L) / (2 * A * A)
  const Pm = clothoidPoint(L, A)
  const Pr = clothoidPoint(L - s, A)
  const dX = Pm.x - Pr.x
  const dY = Pm.y - Pr.y
  const c = Math.cos(tau)
  const sn = Math.sin(tau)
  return { x: c * dX + sn * dY, y: sn * dX - c * dY }
}

/**
 * クロソイド区間を等分割サンプリングし、点列を返す。
 *
 * 引数:
 *   p0: 始点（IN なら TS、OUT なら CS）のワールド座標
 *   tangent0: p0 における進行方向の単位ベクトル
 *   A: クロソイドパラメータ
 *   L: クロソイド長
 *   rotSign: +1 = 接線が CCW（左旋回）, -1 = CW（右旋回）
 *   direction: 'in' = 直線→曲線、'out' = 曲線→直線
 *   nSamples: 区間内の分割数（>=2）
 *   includeStart: 始点を含めるか（true なら N+1 点）
 */
export function sampleClothoid(
  p0: XY,
  tangent0: XY,
  A: number,
  L: number,
  rotSign: 1 | -1,
  direction: 'in' | 'out',
  nSamples: number,
  includeStart = true,
): XY[] {
  const out: XY[] = []
  if (L <= 0) return includeStart ? [p0] : []
  const N = Math.max(2, nSamples)
  const tx = tangent0.x
  const ty = tangent0.y
  const nxL = -ty
  const nyL = tx
  for (let i = includeStart ? 0 : 1; i <= N; i++) {
    const s = (L * i) / N
    const local = direction === 'in' ? clothoidPoint(s, A) : clothoidPointOut(s, A, L)
    const yWorld = rotSign * local.y
    out.push({
      x: p0.x + tx * local.x + nxL * yWorld,
      y: p0.y + ty * local.x + nyL * yWorld,
    })
  }
  return out
}

/** クロソイド局所座標で、始点における接線方向 (1,0) を基準にした接線方向ベクトルを返す。 */
export function clothoidTangent(
  s: number,
  A: number,
  L: number,
  direction: 'in' | 'out',
): XY {
  if (A <= 0 || L <= 0) return { x: 1, y: 0 }
  const theta =
    direction === 'in'
      ? (s * s) / (2 * A * A)
      : (L * s - (s * s) / 2) / (A * A) // 初期 +x、曲率減衰
  return { x: Math.cos(theta), y: Math.sin(theta) }
}
