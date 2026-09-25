// 実測記録 の 「行」 を 作る 共通 ロジック。
//
// PC の 実測記録 画面 と スマホ の 実測 シート で 同じ 並び / 同じ 式 を 使う ため、
// グループ化 (同じ 当初 の 座標 に リンク した 記録 を 実測1 / 実測2 に 束ねる) と
// 1 行 分 の 計算 を ここ に 置く。
//
// 用語:
//   当初        … 設計座標 (座標管理 と リンク 済み の 場合 の み)
//   実測平均    … 実測1 と 実測2 の 平均 (実測2 が 無ければ 実測1)
//   スライド値  … 当初 + スライド量 (当初 を 実測 に 寄せた 値)
//   補正実測値  … 実測平均 − スライド量 (実測 を 当初 に 寄せた 値。 出力 の 既定)

import type {
  StakingRecord,
  StakingTargetType,
  SurveyCategory,
} from '@/stores/stakingStore'

/** 同じ 当初 の 座標 に リンク した 記録 を 実測1 / 実測2 に 束ねた もの */
export interface StakingGroup {
  key: string
  designName: string
  designX: number | null
  designY: number | null
  designZ: number | null
  surveyCategory: SurveyCategory
  targetType: StakingTargetType
  m1: StakingRecord | null
  m2: StakingRecord | null
}

/**
 * 1 行 分 の 計算値。 画面 の 表 と Excel 出力 で 同じ 式 を 使う ため に
 * ここ 1 か所 に まとめる。
 */
export function deriveRow(
  g: { designX: number | null; designY: number | null; designZ: number | null;
       m1: { measuredX: number; measuredY: number; measuredZ: number | null; accuracy: number | null } | null;
       m2: { measuredX: number; measuredY: number; measuredZ: number | null; accuracy: number | null } | null },
  xOffset: number,
  yOffset: number,
  zOffset: number,
) {
  const m1 = g.m1
  const m2 = g.m2
  // 差 (m2 - m1)
  const diffX = m1 && m2 ? m2.measuredX - m1.measuredX : null
  const diffY = m1 && m2 ? m2.measuredY - m1.measuredY : null
  const diffZ =
    m1 && m2 && m1.measuredZ != null && m2.measuredZ != null
      ? m2.measuredZ - m1.measuredZ
      : null
  // 平均 (m2 が あれば 平均、無ければ m1)
  const avgX = m1 && m2 ? (m1.measuredX + m2.measuredX) / 2 : m1?.measuredX ?? null
  const avgY = m1 && m2 ? (m1.measuredY + m2.measuredY) / 2 : m1?.measuredY ?? null
  const avgZ =
    m1 && m2 && m1.measuredZ != null && m2.measuredZ != null
      ? (m1.measuredZ + m2.measuredZ) / 2
      : m1?.measuredZ ?? null
  // 実測平均 - 設計 (生 の 差、補正 適用前 の バイアス)
  const dvsX = avgX != null && g.designX != null ? avgX - g.designX : null
  const dvsY = avgY != null && g.designY != null ? avgY - g.designY : null
  const dvsZ = avgZ != null && g.designZ != null ? avgZ - g.designZ : null
  const dvsH = dvsX != null && dvsY != null ? Math.hypot(dvsX, dvsY) : null
  // スライド設計: 設計値 に スライド量 を 加算 して 実測 に 寄せる
  const slidedDX = g.designX != null ? g.designX + xOffset : null
  const slidedDY = g.designY != null ? g.designY + yOffset : null
  const slidedDZ = g.designZ != null ? g.designZ + zOffset : null
  // 逆スライド実測: 実測平均 から スライド量 を 引いて 設計 に 寄せる (出力 の 既定)
  const revSlideMX = avgX != null ? avgX - xOffset : null
  const revSlideMY = avgY != null ? avgY - yOffset : null
  const revSlideMZ = avgZ != null ? avgZ - zOffset : null
  // 精度: m1 と m2 の 悪い方 (Max)。 未取得 は 除外
  const acc =
    m1?.accuracy != null && m2?.accuracy != null
      ? Math.max(m1.accuracy, m2.accuracy)
      : m1?.accuracy ?? m2?.accuracy ?? null
  return {
    diffX, diffY, diffZ,
    avgX, avgY, avgZ,
    dvsX, dvsY, dvsZ, dvsH,
    slidedDX, slidedDY, slidedDZ,
    revSlideMX, revSlideMY, revSlideMZ,
    acc,
  }
}


/**
 * 記録 を 手簿・記簿 用 に フラット (1 記録 = 1 行) で 並べる。
 *  観測 データ を 素直 に 一覧 する ため の 関数。
 *  差分 / 平均 の 計算 は 「座標精度管理表」 の 方 で 別途 行う。
 */
export function flattenStakingRecords(records: StakingRecord[]): StakingGroup[] {
  const sorted = [...records].sort((a, b) =>
    b.recordedAt.localeCompare(a.recordedAt),
  )
  return sorted.map<StakingGroup>((r) => ({
    key: r.id,
    designName: r.targetName ?? '',
    designX: r.targetX,
    designY: r.targetY,
    designZ: r.targetZ,
    surveyCategory: r.surveyCategory,
    targetType: r.targetType,
    m1: r,
    m2: null,
  }))
}

/**
 * 記録 を 行 に 束ねる。 (旧 実測1/実測2 ペア表示 用、精度管理 で 使用)
 *  (1) 当初 の 座標 に リンク 済み … targetRefId ごと。 3 件 以上 は 2 件 ずつ 追加行。
 *  (2) free 記録 … pairedWithId が 相互 参照 に なって いる 2 件 を ペア に。
 * 並び は 実測1 の 記録日時 の 新しい 順。
 */
export function groupStakingRecords(records: StakingRecord[]): StakingGroup[] {
  const byRef = new Map<string, StakingRecord[]>()
  const freeRecords: StakingRecord[] = []
  for (const r of records) {
    if (r.targetType === 'coordinate' && r.targetRefId) {
      const arr = byRef.get(r.targetRefId) ?? []
      arr.push(r)
      byRef.set(r.targetRefId, arr)
    } else {
      freeRecords.push(r)
    }
  }
  for (const arr of byRef.values()) {
    arr.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
  }
  const out: StakingGroup[] = []
  for (const [refId, arr] of byRef.entries()) {
    const design = arr[0]
    for (let i = 0; i < arr.length; i += 2) {
      out.push({
        key: i === 0 ? refId : `${refId}-${i}`,
        designName: design.targetName ?? '',
        designX: design.targetX,
        designY: design.targetY,
        designZ: design.targetZ,
        surveyCategory: arr[i].surveyCategory,
        targetType: design.targetType,
        m1: arr[i] ?? null,
        m2: arr[i + 1] ?? null,
      })
    }
  }
  const freeById = new Map(freeRecords.map((r) => [r.id, r]))
  const consumed = new Set<string>()
  for (const r of freeRecords) {
    if (consumed.has(r.id)) continue
    const partner = r.pairedWithId ? freeById.get(r.pairedWithId) : null
    const isSymmetric = partner && partner.pairedWithId === r.id
    if (partner && isSymmetric && !consumed.has(partner.id)) {
      const pair = [r, partner].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
      out.push({
        key: `pair-${pair[0].id}`,
        designName: '',
        designX: null,
        designY: null,
        designZ: null,
        surveyCategory: pair[0].surveyCategory,
        targetType: pair[0].targetType,
        m1: pair[0],
        m2: pair[1],
      })
      consumed.add(pair[0].id)
      consumed.add(pair[1].id)
    } else {
      out.push({
        key: r.id,
        designName: '',
        designX: null,
        designY: null,
        designZ: null,
        surveyCategory: r.surveyCategory,
        targetType: r.targetType,
        m1: r,
        m2: null,
      })
      consumed.add(r.id)
    }
  }
  out.sort((a, b) => (b.m1?.recordedAt ?? '').localeCompare(a.m1?.recordedAt ?? ''))
  return out
}
