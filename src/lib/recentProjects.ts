// 現場 (project) と 工区 (farm) の「最近使った」時刻を localStorage に記録し、
// リスト表示時に上位に並べるためのユーティリティ。
//
// 記録タイミング:
//   ・setCurrentProject(project) が呼ばれた時 → markProjectRecent
//   ・setCurrentFarm(farm) が呼ばれた時 → markFarmRecent
//
// 並び順:
//   ・recency の新しい順 (直近開いたものが最上位)
//   ・recency が無い (まだ 1 回も開いていない) ものは末尾に、内部順は
//     呼び出し側が保持する既定順 (created_at DESC 等)
//
// クロス端末同期は現状しない。必要になれば DB 側にログテーブルを持つ設計に。

const PROJECT_KEY = 'nodecloud:recentProjects'
const FARM_KEY = 'nodecloud:recentFarms'

// 上限を設けて古い項目を落とす (localStorage 圧迫防止)
const MAX_ITEMS = 50

type RecencyMap = Record<string, number> // id → epoch ms

function readMap(key: string): RecencyMap {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const obj = JSON.parse(raw)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return obj as RecencyMap
    }
    return {}
  } catch {
    return {}
  }
}

function writeMap(key: string, map: RecencyMap): void {
  if (typeof window === 'undefined') return
  // 上限超過分は古い順から削除
  const entries = Object.entries(map)
  if (entries.length > MAX_ITEMS) {
    entries.sort((a, b) => b[1] - a[1])
    const trimmed: RecencyMap = {}
    for (const [id, ts] of entries.slice(0, MAX_ITEMS)) trimmed[id] = ts
    map = trimmed
  }
  try {
    localStorage.setItem(key, JSON.stringify(map))
  } catch {
    // quota 等は握りつぶす (アプリの本体機能ではないため)
  }
}

/** 現場 (project) を「今使った」として記録 */
export function markProjectRecent(projectId: string): void {
  if (!projectId) return
  const map = readMap(PROJECT_KEY)
  map[projectId] = Date.now()
  writeMap(PROJECT_KEY, map)
}

/** 工区 (farm) を「今使った」として記録 */
export function markFarmRecent(farmId: string): void {
  if (!farmId) return
  const map = readMap(FARM_KEY)
  map[farmId] = Date.now()
  writeMap(FARM_KEY, map)
}

/** 特定現場の直近アクセス時刻 (ms)。無ければ null */
export function getProjectRecency(projectId: string): number | null {
  return readMap(PROJECT_KEY)[projectId] ?? null
}

/** 特定工区の直近アクセス時刻 (ms)。無ければ null */
export function getFarmRecency(farmId: string): number | null {
  return readMap(FARM_KEY)[farmId] ?? null
}

/** 全プロジェクトの recency Map */
export function getAllProjectRecency(): RecencyMap {
  return readMap(PROJECT_KEY)
}

/** 全 farm の recency Map */
export function getAllFarmRecency(): RecencyMap {
  return readMap(FARM_KEY)
}

/**
 * 配列を「recency の新しい順 → 未使用は fallback 比較関数の順」で並び替えて返す。
 * 元の配列は変更しない (immutable)。
 */
export function sortByRecency<T>(
  items: T[],
  getId: (x: T) => string,
  recency: RecencyMap,
  fallbackCompare?: (a: T, b: T) => number,
): T[] {
  const copy = items.slice()
  copy.sort((a, b) => {
    const ra = recency[getId(a)]
    const rb = recency[getId(b)]
    if (ra != null && rb != null) return rb - ra
    if (ra != null) return -1
    if (rb != null) return 1
    return fallbackCompare ? fallbackCompare(a, b) : 0
  })
  return copy
}
