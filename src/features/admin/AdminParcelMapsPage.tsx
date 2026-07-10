// サイトオーナー用: 地番マップ (JPGIS/JSIMA) データセットの登録・管理。
// /admin/parcel-maps
//
// フロー:
//   1. JPGIS XML ファイル + 名前 + 座標系 を入力してアップロード
//   2. クライアントで parseJpgisXml + jpgisToGeoJson を実行
//   3. Storage に XML と GeoJSON を保存し、parcel_map_datasets に INSERT
//   4. 一覧の active トグルで「今から全ユーザーに見えるか」を制御
//
// active は同時に 1 件だけ (setActive 内で自動排他)。

import { useCallback, useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import {
  ArrowLeft,
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

export function AdminParcelMapsPage() {
  const { user } = useAuth()
  const {
    datasets,
    loading,
    error,
    fetchAll,
    uploadDataset,
    setActive,
    deleteDataset,
  } = useParcelMapDatasetStore()

  const [showUpload, setShowUpload] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

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
    try {
      const created = await uploadDataset({
        file,
        name: name.trim(),
        description: description.trim() || null,
        zone,
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
    }
  }

  const handleToggleActive = async (
    datasetId: string,
    currentActive: boolean,
  ) => {
    await setActive(datasetId, !currentActive)
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
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-slate-600 text-xs sticky top-0">
              <tr>
                <th className="text-left px-3 py-2">名称</th>
                <th className="text-left px-3 py-2 w-24">系</th>
                <th className="text-left px-3 py-2 w-24">地番数</th>
                <th className="text-left px-3 py-2 w-24">元形式</th>
                <th className="text-left px-3 py-2 w-32">登録日</th>
                <th className="text-left px-3 py-2 w-36">状態</th>
                <th className="text-left px-3 py-2 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {datasets.map((d) => (
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
                          ? 'このデータセットが全ユーザーに公開されています'
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
    </div>
  )
}
