// 地籍測量プロジェクトで「地番から新規工区を作成」するためのパネル。
// 都道府県 → 市町村 (dataset) → 所在 (大字/丁目) → 地番 のカスケード選択。
// 決定時、親コンポーネント (ProjectListPage) の onSubmit に選択結果を渡す。
//
// 実際の工区作成 + importParcelBatch + parcel_map_bbox 設定は親側で行う
// (farm 作成には project_id を含む複数の store 呼び出しが必要なため)。

import { useEffect, useMemo, useState } from 'react'
import { Loader2, ChevronDown } from 'lucide-react'
import type { Feature, Polygon } from 'geojson'
import { useParcelMapDatasetStore } from '@/stores/parcelMapDatasetStore'
import type { ParcelMapDataset } from '@/types/database'
import type { ParcelFeatureProperties } from '@/lib/jpgis-to-geojson'
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox'

/** 総務省 全国地方公共団体コード 2 桁 → 表示名 */
const PREFECTURE_NAMES: Record<string, string> = {
  '01': '北海道', '02': '青森県', '03': '岩手県', '04': '宮城県', '05': '秋田県',
  '06': '山形県', '07': '福島県', '08': '茨城県', '09': '栃木県', '10': '群馬県',
  '11': '埼玉県', '12': '千葉県', '13': '東京都', '14': '神奈川県', '15': '新潟県',
  '16': '富山県', '17': '石川県', '18': '福井県', '19': '山梨県', '20': '長野県',
  '21': '岐阜県', '22': '静岡県', '23': '愛知県', '24': '三重県', '25': '滋賀県',
  '26': '京都府', '27': '大阪府', '28': '兵庫県', '29': '奈良県', '30': '和歌山県',
  '31': '鳥取県', '32': '島根県', '33': '岡山県', '34': '広島県', '35': '山口県',
  '36': '徳島県', '37': '香川県', '38': '愛媛県', '39': '高知県', '40': '福岡県',
  '41': '佐賀県', '42': '長崎県', '43': '熊本県', '44': '大分県', '45': '宮崎県',
  '46': '鹿児島県', '47': '沖縄県',
}

/** dataset.name から市町村名を推定
 *  例: "06201 山形市 (2025)" / "06201_山形市_公共座標10系_筆R_2025.geojson" 等の揺れに耐える */
function extractMunicipalityLabel(d: ParcelMapDataset): string {
  const raw = d.name.replace(/\.geojson$/i, '').trim()
  // "06201_山形市_..." 形式なら 2 番目のセグメント
  const m = raw.match(/^\d{5}_([^_]+)_/)
  if (m) return m[1]
  // "06201 山形市 (2025)" 形式なら括弧前の 2 語目
  const m2 = raw.match(/^\d{5}\s+([^\s(（]+)/)
  if (m2) return m2[1]
  return raw
}

/** 「10 が 9 より先に来る」文字列比較を避けるため、先頭の数値部分でまず比較 →
 *  同値なら残りを文字列比較する。"10-5" と "10-10" の枝番同士でも数値順を維持。 */
function compareNumericStr(a: string, b: string): number {
  const numA = a.match(/^(\d+)/)?.[1]
  const numB = b.match(/^(\d+)/)?.[1]
  if (numA != null && numB != null) {
    const nA = parseInt(numA, 10)
    const nB = parseInt(numB, 10)
    if (nA !== nB) return nA - nB
    // 数値が同じ場合、残り (ハイフン以降を含む) を再帰的に numeric compare
    const restA = a.slice(numA.length).replace(/^-/, '')
    const restB = b.slice(numB.length).replace(/^-/, '')
    if (restA === '' && restB === '') return 0
    if (restA === '') return -1
    if (restB === '') return 1
    return compareNumericStr(restA, restB)
  }
  if (numA != null) return -1 // 数値ありを先に
  if (numB != null) return 1
  return a.localeCompare(b, 'ja')
}

export interface NewFarmFromParcelSelection {
  dataset: ParcelMapDataset
  feature: Feature<Polygon, ParcelFeatureProperties>
  /** 提案する工区名 (親側で編集可能) */
  suggestedFarmName: string
}

interface Props {
  /** projectCategory === 'cadastral' の datasets のみ対象にしたい場合は親でフィルタ済みを渡す想定 */
  onSelectionChange: (sel: NewFarmFromParcelSelection | null) => void
}

export function NewFarmFromParcelPanel({ onSelectionChange }: Props) {
  const datasets = useParcelMapDatasetStore((s) => s.datasets)
  const cache = useParcelMapDatasetStore((s) => s.geoJsonCache)
  const loadDatasetById = useParcelMapDatasetStore((s) => s.loadDatasetById)
  const loadingIds = useParcelMapDatasetStore((s) => s.loadingIds)
  const fetchAll = useParcelMapDatasetStore((s) => s.fetchAll)

  const [prefectureCode, setPrefectureCode] = useState<string>('')
  const [datasetId, setDatasetId] = useState<string>('')
  const [location, setLocation] = useState<string>('')
  const [selectedParent, setSelectedParent] = useState<string>('') // 本番
  const [selectedBranch, setSelectedBranch] = useState<string>('') // 枝番 ("" = 本番のみ)

  useEffect(() => {
    void fetchAll()
  }, [fetchAll])

  // 都道府県の選択肢 (dataset に prefecture_code が入っているもののみ)
  const prefectures = useMemo(() => {
    const set = new Set<string>()
    for (const d of datasets) {
      if (d.prefecture_code) set.add(d.prefecture_code)
    }
    return [...set].sort()
  }, [datasets])

  // 市町村 (dataset) の選択肢
  const municipalities = useMemo(() => {
    if (!prefectureCode) return []
    return datasets
      .filter((d) => d.prefecture_code === prefectureCode)
      .map((d) => ({
        id: d.id,
        label: extractMunicipalityLabel(d),
        registry_code: d.registry_code ?? '',
      }))
      .sort((a, b) => a.registry_code.localeCompare(b.registry_code))
  }, [datasets, prefectureCode])

  // dataset を選んだら GeoJSON を DL する (キャッシュあれば即返る)
  useEffect(() => {
    if (!datasetId) return
    void loadDatasetById(datasetId)
  }, [datasetId, loadDatasetById])
  const isLoading = datasetId ? loadingIds.has(datasetId) : false
  const fc = datasetId ? cache[datasetId] : undefined

  // 所在 (location) の一覧 (日本語ソート)
  const locations = useMemo(() => {
    if (!fc) return []
    const set = new Set<string>()
    for (const f of fc.features) {
      const loc = (f.properties.location ?? '').trim()
      if (loc) set.add(loc)
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'ja'))
  }, [fc])

  // 所在フィルタしたあとの地番一覧 (parent + branch に分解)
  //   parent = 先頭 "-" より前 (本番), branch = 残り (枝番、"" は本番のみ)
  //   例: "10"     → { parent: "10", branch: "" }
  //       "10-5"   → { parent: "10", branch: "5" }
  //       "10-5-1" → { parent: "10", branch: "5-1" }
  const parcelCandidates = useMemo(() => {
    if (!fc || !location) return []
    const list: Array<{
      key: string
      parcel_number: string
      parent: string
      branch: string
      feature: Feature<Polygon, ParcelFeatureProperties>
    }> = []
    for (const f of fc.features as Array<Feature<Polygon, ParcelFeatureProperties>>) {
      if ((f.properties.location ?? '').trim() !== location) continue
      const num = (f.properties.parcel_number ?? '').trim()
      if (!num) continue
      const dash = num.indexOf('-')
      const parent = dash < 0 ? num : num.slice(0, dash)
      const branch = dash < 0 ? '' : num.slice(dash + 1)
      const outer = f.geometry.coordinates[0]?.[0]
      const key = `${num}|${outer?.[0] ?? ''}|${outer?.[1] ?? ''}`
      list.push({ key, parcel_number: num, parent, branch, feature: f })
    }
    return list
  }, [fc, location])

  // 本番の一覧 (数値昇順 → 非数値は末尾)
  const parentNumbers = useMemo(() => {
    const set = new Set<string>()
    for (const p of parcelCandidates) set.add(p.parent)
    return [...set].sort(compareNumericStr)
  }, [parcelCandidates])

  // 選択中の本番に紐づく枝番の一覧 (数値昇順、"" = 本番のみ を先頭に)
  const branchNumbers = useMemo(() => {
    if (!selectedParent) return []
    const set = new Set<string>()
    for (const p of parcelCandidates) {
      if (p.parent === selectedParent) set.add(p.branch)
    }
    const arr = [...set]
    arr.sort((a, b) => {
      if (a === '' && b !== '') return -1
      if (b === '' && a !== '') return 1
      return compareNumericStr(a, b)
    })
    return arr
  }, [parcelCandidates, selectedParent])

  // 決定済み地番 (parent + branch 一致)
  const currentEntry = useMemo(() => {
    if (!selectedParent) return null
    return (
      parcelCandidates.find(
        (p) => p.parent === selectedParent && p.branch === selectedBranch,
      ) ?? null
    )
  }, [parcelCandidates, selectedParent, selectedBranch])

  // 親に選択結果を通知
  const currentDataset = datasetId
    ? datasets.find((d) => d.id === datasetId) ?? null
    : null
  const currentFeature = currentEntry?.feature
  useEffect(() => {
    if (!currentDataset || !currentFeature) {
      onSelectionChange(null)
      return
    }
    // 例: 「山形市 錦町 10-10」
    //   parcel_name = "location parcel_number" 形式なので、市町村名を頭に足すだけ。
    //   parcel_name が空の場合は parcel_number を使う。
    const municipality = extractMunicipalityLabel(currentDataset)
    const nameCore =
      currentFeature.properties.parcel_name?.trim() ||
      currentFeature.properties.parcel_number
    const suggestedFarmName = municipality
      ? `${municipality} ${nameCore}`.trim()
      : nameCore
    onSelectionChange({
      dataset: currentDataset,
      feature: currentFeature,
      suggestedFarmName,
    })
  }, [currentDataset, currentFeature, onSelectionChange])

  // 親の項目が変わったら子項目をリセット
  useEffect(() => { setDatasetId('') }, [prefectureCode])
  useEffect(() => { setLocation('') }, [datasetId])
  useEffect(() => {
    setSelectedParent('')
    setSelectedBranch('')
  }, [location])
  useEffect(() => { setSelectedBranch('') }, [selectedParent])

  const prefectureOptions: ComboboxOption[] = useMemo(
    () =>
      prefectures.map((code) => ({
        value: code,
        label: PREFECTURE_NAMES[code] ?? code,
      })),
    [prefectures],
  )
  const municipalityOptions: ComboboxOption[] = useMemo(
    () =>
      municipalities.map((m) => ({
        value: m.id,
        label: `${m.registry_code} ${m.label}`,
      })),
    [municipalities],
  )
  const locationOptions: ComboboxOption[] = useMemo(
    () => locations.map((loc) => ({ value: loc, label: loc })),
    [locations],
  )
  const parentOptions: ComboboxOption[] = useMemo(
    () => parentNumbers.map((n) => ({ value: n, label: n })),
    [parentNumbers],
  )

  return (
    <div className="space-y-3">
      {/* 都道府県 */}
      <div>
        <label className="block text-xs font-medium mb-1 text-slate-600">都道府県 *</label>
        <Combobox
          value={prefectureCode}
          onChange={setPrefectureCode}
          options={prefectureOptions}
          placeholder="都道府県名で検索 (例: 北)"
        />
        {prefectures.length === 0 && (
          <p className="text-[11px] text-slate-500 mt-1">
            公開中の地番マップが 1 つもありません。管理画面から公開してください。
          </p>
        )}
      </div>

      {/* 市町村 */}
      <div>
        <label className="block text-xs font-medium mb-1 text-slate-600">市町村 *</label>
        <Combobox
          value={datasetId}
          onChange={setDatasetId}
          options={municipalityOptions}
          disabled={!prefectureCode}
          placeholder="市町村名で検索"
        />
        {prefectureCode && municipalities.length === 0 && (
          <p className="text-[11px] text-slate-500 mt-1">
            この都道府県で公開中の地番マップがありません。
          </p>
        )}
      </div>

      {/* 所在 */}
      <div>
        <label className="block text-xs font-medium mb-1 text-slate-600">所在 (大字・丁目) *</label>
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-slate-500 px-2 py-2 border rounded bg-slate-50">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            地番データを読み込み中…
          </div>
        ) : (
          <Combobox
            value={location}
            onChange={setLocation}
            options={locationOptions}
            disabled={!fc}
            placeholder="大字名で検索 (例: 錦町)"
          />
        )}
      </div>

      {/* 地番 (本番 → 枝番 の 2 段階) */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs font-medium mb-1 text-slate-600">
            本番 *{' '}
            {parentNumbers.length > 0 && (
              <span className="text-slate-400 font-normal">
                ({parentNumbers.length.toLocaleString()})
              </span>
            )}
          </label>
          <Combobox
            value={selectedParent}
            onChange={setSelectedParent}
            options={parentOptions}
            disabled={!location}
            placeholder="本番"
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1 text-slate-600">
            枝番{' '}
            {branchNumbers.length > 0 && (
              <span className="text-slate-400 font-normal">
                ({branchNumbers.length.toLocaleString()})
              </span>
            )}
          </label>
          <div className="relative">
            <select
              value={selectedBranch}
              onChange={(e) => setSelectedBranch(e.target.value)}
              disabled={!selectedParent}
              className="w-full px-3 py-2 border rounded appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:bg-slate-100 disabled:text-slate-500"
            >
              {branchNumbers.length === 0 && (
                <option value="">選択してください</option>
              )}
              {branchNumbers.map((b) => (
                <option key={b} value={b}>
                  {b === '' ? '(なし)' : b}
                </option>
              ))}
            </select>
            <ChevronDown className="h-4 w-4 absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          </div>
        </div>
      </div>
      {currentEntry && (
        <div className="mt-1 text-xs text-slate-600">
          選択中: <span className="font-semibold text-slate-800">{currentEntry.parcel_number}</span>
        </div>
      )}
    </div>
  )
}
