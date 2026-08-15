// 09 甲差検証 — 地積測定の公差計算。
//
// 不動産登記規則の別表 (甲一〜乙三) に基づき、
// 実測面積 F (m²) に対する地積測定の公差 (m²) を返す:
//   公差 = (a + b·F^(1/4)) · F^(1/2)
//
// 係数 (a, b) は 精度区分ごと。

export type AccuracyClass = 'a1' | 'a2' | 'a3' | 'b1' | 'b2' | 'b3'

const AREA_TOLERANCE_COEFFS: Record<AccuracyClass, { a: number; b: number }> = {
  a1: { a: 0.025, b: 0.003 }, // 甲一
  a2: { a: 0.05,  b: 0.01  }, // 甲二
  a3: { a: 0.10,  b: 0.02  }, // 甲三
  b1: { a: 0.10,  b: 0.04  }, // 乙一
  b2: { a: 0.25,  b: 0.07  }, // 乙二
  b3: { a: 0.50,  b: 0.14  }, // 乙三
}

export const ACCURACY_LABEL: Record<AccuracyClass, string> = {
  a1: '甲一', a2: '甲二', a3: '甲三',
  b1: '乙一', b2: '乙二', b3: '乙三',
}

/** 地積測定の公差 (m²)。計算不能なら null */
export function calculateAreaTolerance(
  accuracy: AccuracyClass | null,
  measuredAreaSqm: number | null,
): number | null {
  if (!accuracy || measuredAreaSqm == null || measuredAreaSqm <= 0) return null
  const c = AREA_TOLERANCE_COEFFS[accuracy]
  return (c.a + c.b * Math.pow(measuredAreaSqm, 0.25)) * Math.pow(measuredAreaSqm, 0.5)
}

/** 甲差検証結果 */
export interface KoosaResult {
  /** 差 = |実測 - 登記|。片方が null なら null */
  diff: number | null
  /** 公差。精度区分 or 実測面積が欠けていれば null */
  tolerance: number | null
  /** 判定 — 'ok' / 'ng' / null (計算不能) */
  verdict: 'ok' | 'ng' | null
}

export function evaluateKoosa(
  accuracy: AccuracyClass | null,
  registeredAreaSqm: number | null,
  measuredAreaSqm: number | null,
): KoosaResult {
  const diff =
    registeredAreaSqm != null && measuredAreaSqm != null
      ? Math.abs(measuredAreaSqm - registeredAreaSqm)
      : null
  const tolerance = calculateAreaTolerance(accuracy, measuredAreaSqm)
  const verdict: KoosaResult['verdict'] =
    diff != null && tolerance != null ? (diff <= tolerance ? 'ok' : 'ng') : null
  return { diff, tolerance, verdict }
}
