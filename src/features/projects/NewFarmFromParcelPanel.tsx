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
  const [parcelQuery, setParcelQuery] = useState<string>('')
  const [selectedParcelKey, setSelectedParcelKey] = useState<string>('')

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

  // 所在 (location) の一覧
  const locations = useMemo(() => {
    if (!fc) return []
    const set = new Set<string>()
    for (const f of fc.features) {
      const loc = (f.properties.location ?? '').trim()
      if (loc) set.add(loc)
    }
    return [...set].sort()
  }, [fc])

  // 所在フィルタしたあとの地番一覧
  const parcelCandidates = useMemo(() => {
    if (!fc || !location) return []
    const list: Array<{
      key: string
      parcel_number: string
      feature: Feature<Polygon, ParcelFeatureProperties>
    }> = []
    for (const f of fc.features as Array<Feature<Polygon, ParcelFeatureProperties>>) {
      if ((f.properties.location ?? '').trim() !== location) continue
      const num = (f.properties.parcel_number ?? '').trim()
      if (!num) continue
      const outer = f.geometry.coordinates[0]?.[0]
      const key = `${num}|${outer?.[0] ?? ''}|${outer?.[1] ?? ''}`
      list.push({ key, parcel_number: num, feature: f })
    }
    list.sort((a, b) => a.parcel_number.localeCompare(b.parcel_number, 'ja'))
    return list
  }, [fc, location])

  // 検索フィルタ
  const filteredCandidates = useMemo(() => {
    const q = parcelQuery.trim().toLowerCase()
    if (!q) return parcelCandidates
    return parcelCandidates.filter((p) =>
      p.parcel_number.toLowerCase().includes(q),
    )
  }, [parcelCandidates, parcelQuery])

  // 親に選択結果を通知
  const currentDataset = datasetId
    ? datasets.find((d) => d.id === datasetId) ?? null
    : null
  const currentFeature =
    selectedParcelKey
      ? parcelCandidates.find((p) => p.key === selectedParcelKey)?.feature
      : undefined
  useEffect(() => {
    if (!currentDataset || !currentFeature) {
      onSelectionChange(null)
      return
    }
    const name = currentFeature.properties.parcel_name?.trim()
    const suggestedFarmName = name && name.length > 0
      ? name
      : currentFeature.properties.parcel_number
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
    setParcelQuery('')
    setSelectedParcelKey('')
  }, [location])

  return (
    <div className="space-y-3">
      {/* 都道府県 */}
      <div>
        <label className="block text-xs font-medium mb-1 text-slate-600">都道府県 *</label>
        <div className="relative">
          <select
            value={prefectureCode}
            onChange={(e) => setPrefectureCode(e.target.value)}
            className="w-full px-3 py-2 border rounded appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          >
            <option value="">選択してください</option>
            {prefectures.map((code) => (
              <option key={code} value={code}>
                {PREFECTURE_NAMES[code] ?? code}
              </option>
            ))}
          </select>
          <ChevronDown className="h-4 w-4 absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
        </div>
        {prefectures.length === 0 && (
          <p className="text-[11px] text-slate-500 mt-1">
            公開中の地番マップが 1 つもありません。管理画面から公開してください。
          </p>
        )}
      </div>

      {/* 市町村 */}
      <div>
        <label className="block text-xs font-medium mb-1 text-slate-600">市町村 *</label>
        <div className="relative">
          <select
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}
            disabled={!prefectureCode}
            className="w-full px-3 py-2 border rounded appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:bg-slate-100 disabled:text-slate-500"
          >
            <option value="">選択してください</option>
            {municipalities.map((m) => (
              <option key={m.id} value={m.id}>
                {m.registry_code} {m.label}
              </option>
            ))}
          </select>
          <ChevronDown className="h-4 w-4 absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
        </div>
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
          <div className="relative">
            <select
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              disabled={!fc}
              className="w-full px-3 py-2 border rounded appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:bg-slate-100 disabled:text-slate-500"
            >
              <option value="">選択してください</option>
              {locations.map((loc) => (
                <option key={loc} value={loc}>
                  {loc}
                </option>
              ))}
            </select>
            <ChevronDown className="h-4 w-4 absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          </div>
        )}
      </div>

      {/* 地番 (検索付き) */}
      <div>
        <label className="block text-xs font-medium mb-1 text-slate-600">
          地番 * {parcelCandidates.length > 0 && (
            <span className="text-slate-400 font-normal">
              ({filteredCandidates.length.toLocaleString()} / {parcelCandidates.length.toLocaleString()} 件)
            </span>
          )}
        </label>
        <input
          type="text"
          value={parcelQuery}
          onChange={(e) => setParcelQuery(e.target.value)}
          disabled={!location}
          placeholder={location ? '地番で絞り込み (例: 10-10)' : ''}
          className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm mb-1 disabled:bg-slate-100"
        />
        <select
          size={6}
          value={selectedParcelKey}
          onChange={(e) => setSelectedParcelKey(e.target.value)}
          disabled={!location}
          className="w-full px-2 py-1 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:bg-slate-100"
        >
          {filteredCandidates.slice(0, 500).map((p) => (
            <option key={p.key} value={p.key}>
              {p.parcel_number}
            </option>
          ))}
        </select>
        {filteredCandidates.length > 500 && (
          <p className="text-[11px] text-amber-700 mt-1">
            先頭 500 件だけ表示しています。検索で絞り込んでください。
          </p>
        )}
      </div>
    </div>
  )
}
