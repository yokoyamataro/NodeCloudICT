// サイトオーナー用: 地番マップ (JPGIS/JSIMA) データセットの登録・管理。
// /admin/parcel-maps
//
// フロー:
//   1. JPGIS XML ファイル + 名前 + 座標系 を入力してアップロード
//   2. クライアントで parseJpgisXml + jpgisToGeoJson を実行
//   3. Storage に XML と GeoJSON を保存し、parcel_map_datasets に INSERT
//   4. 一覧の active トグルで「今から全ユーザーに見えるか」を制御
//
// Phase 2b: active は複数同時 OK。表示側は視野 bbox と交差する dataset だけをオンデマンド DL。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Loader2,
  Map as MapIcon,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Eye,
  EyeOff,
  X,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { isAdmin } from '@/lib/admin'
import { useParcelMapDatasetStore } from '@/stores/parcelMapDatasetStore'
import { JGD2011_ZONES } from '@/lib/coordinates'
import type { ParcelMapDataset } from '@/types/database'

/** 総務省 全国地方公共団体コード の 2 桁都道府県コード → 表示名 */
const PREFECTURE_NAMES: Record<string, string> = {
  '01': '北海道',
  '02': '青森県',
  '03': '岩手県',
  '04': '宮城県',
  '05': '秋田県',
  '06': '山形県',
  '07': '福島県',
  '08': '茨城県',
  '09': '栃木県',
  '10': '群馬県',
  '11': '埼玉県',
  '12': '千葉県',
  '13': '東京都',
  '14': '神奈川県',
  '15': '新潟県',
  '16': '富山県',
  '17': '石川県',
  '18': '福井県',
  '19': '山梨県',
  '20': '長野県',
  '21': '岐阜県',
  '22': '静岡県',
  '23': '愛知県',
  '24': '三重県',
  '25': '滋賀県',
  '26': '京都府',
  '27': '大阪府',
  '28': '兵庫県',
  '29': '奈良県',
  '30': '和歌山県',
  '31': '鳥取県',
  '32': '島根県',
  '33': '岡山県',
  '34': '広島県',
  '35': '山口県',
  '36': '徳島県',
  '37': '香川県',
  '38': '愛媛県',
  '39': '高知県',
  '40': '福岡県',
  '41': '佐賀県',
  '42': '長崎県',
  '43': '熊本県',
  '44': '大分県',
  '45': '宮崎県',
  '46': '鹿児島県',
  '47': '沖縄県',
}
/** 手動アップロード等で prefecture_code が無いものをまとめるキー */
const OTHER_PREFECTURE_KEY = '__other__'

export function AdminParcelMapsPage() {
  const { user } = useAuth()
  const {
    datasets,
    loading,
    error,
    fetchAll,
    uploadDataset,
    setActive,
    setActiveMany,
    deleteDataset,
  } = useParcelMapDatasetStore()

  const [showUpload, setShowUpload] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState<{
    phase: string
    done: number
    total: number
  } | null>(null)

  // 一覧フィルタ (全国データ 1700+ 件対応)
  const [filterText, setFilterText] = useState('')
  const [prefectureFilter, setPrefectureFilter] = useState<string>('') // '' = 全て
  const [activeOnly, setActiveOnly] = useState(false)

  // upload form state
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [zone, setZone] = useState<number>(13)

  const refetch = useCallback(() => {
    void fetchAll()
  }, [fetchAll])

  useEffect(() => {
    refetch()
  }, [refetch])

  const resetForm = () => {
    setFile(null)
    setName('')
    setDescription('')
    setZone(13)
    setUploadError(null)
  }

  const handleUpload = async () => {
    if (!file) {
      setUploadError('XML ファイルを選択してください')
      return
    }
    if (!name.trim()) {
      setUploadError('データセット名を入力してください')
      return
    }
    setUploading(true)
    setUploadError(null)
    setUploadProgress(null)
    try {
      const created = await uploadDataset({
        file,
        name: name.trim(),
        description: description.trim() || null,
        zone,
        onProgress: (p) => {
          const label =
            p.phase === 'parsing'
              ? 'ファイル解析'
              : p.phase === 'uploading'
                ? 'アップロード'
                : p.phase === 'saving'
                  ? 'メタデータ保存'
                  : '完了'
          setUploadProgress({ phase: label, done: p.done, total: p.total })
        },
      })
      if (!created) {
        setUploadError(
          useParcelMapDatasetStore.getState().error ??
            'アップロードに失敗しました',
        )
        return
      }
      setShowUpload(false)
      resetForm()
    } finally {
      setUploading(false)
      setUploadProgress(null)
    }
  }

  const handleToggleActive = async (
    datasetId: string,
    currentActive: boolean,
  ) => {
    await setActive(datasetId, !currentActive)
  }

  const prefectureOptions = useMemo(() => {
    const set = new Set<string>()
    for (const d of datasets) {
      if (d.prefecture_code) set.add(d.prefecture_code)
    }
    return [...set].sort()
  }, [datasets])

  const filteredDatasets = useMemo(() => {
    const q = filterText.trim().toLowerCase()
    return datasets.filter((d) => {
      if (activeOnly && !d.active) return false
      if (prefectureFilter && d.prefecture_code !== prefectureFilter) return false
      if (q) {
        const hay = `${d.name} ${d.description ?? ''} ${d.registry_code ?? ''}`
          .toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [datasets, filterText, prefectureFilter, activeOnly])

  const activeCount = useMemo(
    () => datasets.filter((d) => d.active).length,
    [datasets],
  )

  // 都道府県ごとにグルーピング (filter 済みの中で)
  const groupedByPrefecture = useMemo(() => {
    const groups = new Map<string, ParcelMapDataset[]>()
    for (const d of filteredDatasets) {
      const key = d.prefecture_code ?? OTHER_PREFECTURE_KEY
      const arr = groups.get(key)
      if (arr) arr.push(d)
      else groups.set(key, [d])
    }
    // key を並び順に (都道府県コード昇順 → 手動アップロード '__other__' は末尾)
    return [...groups.entries()].sort(([a], [b]) => {
      if (a === OTHER_PREFECTURE_KEY) return 1
      if (b === OTHER_PREFECTURE_KEY) return -1
      return a.localeCompare(b)
    })
  }, [filteredDatasets])

  // 折りたたみ状態 (default: 全て閉じる。ただし該当グループが 1 つだけなら開く)
  const [expandedPrefectures, setExpandedPrefectures] = useState<Set<string>>(
    new Set(),
  )
  useEffect(() => {
    if (groupedByPrefecture.length === 1) {
      setExpandedPrefectures(new Set([groupedByPrefecture[0][0]]))
    }
  }, [groupedByPrefecture])
  const togglePrefecture = (key: string) => {
    setExpandedPrefectures((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleBulkActive = async (
    prefKey: string,
    prefDatasets: ParcelMapDataset[],
    active: boolean,
  ) => {
    const targets = prefDatasets.filter((d) => d.active !== active).map((d) => d.id)
    if (targets.length === 0) return
    const label = prefKey === OTHER_PREFECTURE_KEY
      ? 'その他'
      : PREFECTURE_NAMES[prefKey] ?? prefKey
    if (
      !confirm(
        `${label} の ${targets.length} 件を${active ? '一括公開' : '一括非公開'}にします。よろしいですか?`,
      )
    ) {
      return
    }
    await setActiveMany(targets, active)
  }

  const handleDelete = async (datasetId: string, datasetName: string) => {
    if (
      !confirm(
        `「${datasetName}」を削除します。Storage の XML / GeoJSON も同時に消えます。よろしいですか?`,
      )
    ) {
      return
    }
    await deleteDataset(datasetId)
  }

  if (!isAdmin(user?.email)) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="h-screen flex flex-col bg-slate-50">
      <header className="bg-white border-b px-4 py-3 flex items-center gap-3">
        <Link to="/" className="p-1.5 hover:bg-slate-100 rounded" title="トップへ">
          <ArrowLeft className="h-4 w-4 text-slate-600" />
        </Link>
        <MapIcon className="h-5 w-5 text-blue-600" />
        <h1 className="text-lg font-bold flex-1">地番マップ (法務省地図)</h1>
        <Link
          to="/admin/users"
          className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
        >
          ユーザー管理
        </Link>
        <button
          onClick={() => {
            setShowUpload((s) => !s)
            resetForm()
          }}
          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          <Plus className="h-3.5 w-3.5" />
          新規アップロード
        </button>
        <button
          onClick={refetch}
          disabled={loading}
          className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          再取得
        </button>
      </header>

      {error && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      {showUpload && (
        <div className="px-4 py-3 bg-blue-50 border-b border-blue-200">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold text-slate-700">新規アップロード</div>
            <button
              onClick={() => {
                setShowUpload(false)
                resetForm()
              }}
              className="p-1 text-slate-500 hover:bg-slate-200 rounded"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-xs sm:col-span-2">
              <span className="block text-slate-600 mb-0.5">
                JPGIS/JSIMA XML または GeoJSON ファイル *
              </span>
              <input
                type="file"
                accept=".xml,.XML,.geojson,.json,application/xml,text/xml,application/geo+json,application/json"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-xs"
              />
              <span className="block mt-0.5 text-[10px] text-slate-500">
                G 空間情報センターの 法務省登記所備付地図データ (WGS84 GeoJSON) を
                そのままアップロードできます。属性の「座標系」から系番号は自動検出します。
              </span>
            </label>
            <label className="text-xs">
              <span className="block text-slate-600 mb-0.5">データセット名 *</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例: 山形県○○市 R7地図"
                className="w-full px-2 py-1 border rounded"
              />
            </label>
            <label className="text-xs">
              <span className="block text-slate-600 mb-0.5">座標系 *</span>
              <select
                value={zone}
                onChange={(e) => setZone(parseInt(e.target.value, 10))}
                className="w-full px-2 py-1 border rounded bg-white"
              >
                {Object.entries(JGD2011_ZONES).map(([z, info]) => (
                  <option key={z} value={z}>
                    {info.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs sm:col-span-2">
              <span className="block text-slate-600 mb-0.5">説明 (任意)</span>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="任意"
                className="w-full px-2 py-1 border rounded"
              />
            </label>
          </div>
          {uploadProgress && (
            <div className="mt-2 flex items-center gap-2 text-xs text-slate-700 bg-white border border-slate-200 rounded p-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
              <span>
                {uploadProgress.phase}
                {uploadProgress.total > 0 && (
                  <>
                    <span className="font-mono ml-1">
                      {uploadProgress.done.toLocaleString()} /{' '}
                      {uploadProgress.total.toLocaleString()}
                    </span>
                    <span className="ml-1 text-slate-500">
                      (
                      {Math.round((uploadProgress.done / uploadProgress.total) * 100)}
                      %)
                    </span>
                  </>
                )}
              </span>
              <div className="flex-1 h-2 bg-slate-200 rounded overflow-hidden">
                <div
                  className="h-full bg-blue-600 transition-[width] duration-150"
                  style={{
                    width: `${Math.min(100, (uploadProgress.done / Math.max(1, uploadProgress.total)) * 100)}%`,
                  }}
                />
              </div>
            </div>
          )}
          {uploadError && (
            <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
              {uploadError}
            </div>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <button
              onClick={() => {
                setShowUpload(false)
                resetForm()
              }}
              disabled={uploading}
              className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
            >
              キャンセル
            </button>
            <button
              onClick={handleUpload}
              disabled={uploading || !file || !name.trim()}
              className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              アップロード
            </button>
          </div>
          <div className="mt-2 text-[10px] text-slate-500">
            アップロード時にクライアントで JPGIS → GeoJSON 変換を行うため、
            数千地番規模のファイルでは数十秒かかることがあります。
          </div>
        </div>
      )}

      {datasets.length > 0 && (
        <div className="px-4 py-2 bg-white border-b flex items-center gap-2 text-xs">
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="名称 / 登記所コードで検索"
            className="px-2 py-1 border rounded w-64"
          />
          <select
            value={prefectureFilter}
            onChange={(e) => setPrefectureFilter(e.target.value)}
            className="px-2 py-1 border rounded bg-white"
          >
            <option value="">都道府県 (全て)</option>
            {prefectureOptions.map((code) => (
              <option key={code} value={code}>
                {PREFECTURE_NAMES[code] ?? code}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
            />
            公開中のみ
          </label>
          <span className="ml-auto text-slate-500">
            {filteredDatasets.length.toLocaleString()} / {datasets.length.toLocaleString()} 件
            {' · '}
            <span className="text-emerald-700 font-medium">
              公開 {activeCount.toLocaleString()} 件
            </span>
          </span>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {loading && datasets.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-500 text-sm">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            読み込み中…
          </div>
        ) : datasets.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-sm">
            データセットがまだありません。右上の「新規アップロード」から追加してください。
          </div>
        ) : filteredDatasets.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-sm">
            フィルタに一致するデータセットがありません。
          </div>
        ) : (
          <div className="divide-y">
            {groupedByPrefecture.map(([prefKey, prefDatasets]) => {
              const isOpen = expandedPrefectures.has(prefKey)
              const label = prefKey === OTHER_PREFECTURE_KEY
                ? 'その他 (手動アップロード)'
                : PREFECTURE_NAMES[prefKey] ?? prefKey
              const activeInGroup = prefDatasets.filter((d) => d.active).length
              const allActive = activeInGroup === prefDatasets.length
              const noneActive = activeInGroup === 0
              return (
                <div key={prefKey} className="bg-white">
                  <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 hover:bg-slate-100">
                    <button
                      onClick={() => togglePrefecture(prefKey)}
                      className="p-0.5 text-slate-500 hover:text-slate-800"
                      aria-label={isOpen ? '閉じる' : '開く'}
                    >
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </button>
                    <button
                      onClick={() => togglePrefecture(prefKey)}
                      className="flex-1 text-left font-semibold text-slate-800"
                    >
                      {label}
                      <span className="ml-2 text-xs font-normal text-slate-500">
                        {prefDatasets.length.toLocaleString()} 件
                        {' · '}
                        <span className="text-emerald-700 font-medium">
                          公開 {activeInGroup.toLocaleString()}
                        </span>
                      </span>
                    </button>
                    <button
                      onClick={() =>
                        handleBulkActive(prefKey, prefDatasets, true)
                      }
                      disabled={allActive}
                      className="flex items-center gap-1 px-2 py-1 text-xs rounded border bg-emerald-50 border-emerald-300 text-emerald-800 hover:bg-emerald-100 disabled:opacity-40 disabled:cursor-not-allowed"
                      title={
                        allActive
                          ? '全て公開中'
                          : `${prefDatasets.length - activeInGroup} 件を公開`
                      }
                    >
                      <Eye className="h-3.5 w-3.5" />
                      一括公開
                    </button>
                    <button
                      onClick={() =>
                        handleBulkActive(prefKey, prefDatasets, false)
                      }
                      disabled={noneActive}
                      className="flex items-center gap-1 px-2 py-1 text-xs rounded border bg-slate-50 border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
                      title={
                        noneActive
                          ? '全て非公開'
                          : `${activeInGroup} 件を非公開`
                      }
                    >
                      <EyeOff className="h-3.5 w-3.5" />
                      一括非公開
                    </button>
                  </div>
                  {isOpen && (
                    <table className="w-full text-sm">
                      <thead className="bg-slate-100 text-slate-600 text-xs">
                        <tr>
                          <th className="text-left px-3 py-1.5">名称</th>
                          <th className="text-left px-3 py-1.5 w-24">系</th>
                          <th className="text-left px-3 py-1.5 w-24">地番数</th>
                          <th className="text-left px-3 py-1.5 w-24">元形式</th>
                          <th className="text-left px-3 py-1.5 w-32">登録日</th>
                          <th className="text-left px-3 py-1.5 w-36">状態</th>
                          <th className="text-left px-3 py-1.5 w-16"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {prefDatasets.map((d) => (
                          <tr key={d.id} className="border-b hover:bg-slate-50/50">
                            <td className="px-3 py-2 align-top">
                              <div className="font-medium">{d.name}</div>
                              {d.description && (
                                <div className="text-xs text-slate-500 mt-0.5">
                                  {d.description}
                                </div>
                              )}
                              <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                                {d.id}
                              </div>
                            </td>
                            <td className="px-3 py-2 align-top text-xs">
                              第 {d.coordinate_zone} 系
                            </td>
                            <td className="px-3 py-2 align-top text-xs">
                              {d.parcel_count?.toLocaleString() ?? '-'}
                            </td>
                            <td className="px-3 py-2 align-top text-xs">
                              {d.source_kind === 'geojson' ? 'GeoJSON' : 'JPGIS'}
                            </td>
                            <td className="px-3 py-2 align-top text-xs text-slate-500">
                              {new Date(d.created_at).toLocaleDateString('ja-JP')}
                            </td>
                            <td className="px-3 py-2 align-top">
                              <button
                                onClick={() => handleToggleActive(d.id, d.active)}
                                className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded border ${
                                  d.active
                                    ? 'bg-emerald-50 border-emerald-300 text-emerald-800 hover:bg-emerald-100'
                                    : 'bg-slate-50 border-slate-300 text-slate-500 hover:bg-slate-100'
                                }`}
                                title={
                                  d.active
                                    ? '公開中 (クリックで非公開に)'
                                    : '非公開 (クリックで公開)'
                                }
                              >
                                {d.active ? (
                                  <>
                                    <Eye className="h-3.5 w-3.5" /> 公開中
                                  </>
                                ) : (
                                  <>
                                    <EyeOff className="h-3.5 w-3.5" /> 非公開
                                  </>
                                )}
                              </button>
                            </td>
                            <td className="px-3 py-2 align-top">
                              <button
                                onClick={() => handleDelete(d.id, d.name)}
                                className="p-1 text-red-600 hover:bg-red-50 rounded"
                                title="削除"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
