// オルソ画像ページ: タイトル部に「アップロード」「登録済み一覧」を集約し、
// 画面の大半を地図（オルソ＋座標＋区域）の表示に使う。
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Upload,
  Loader2,
  Trash2,
  Image as ImageIcon,
  AlertTriangle,
  List,
  X,
} from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { useFarmStore } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useWorkAreaStore, type WorkAreaPoint } from '@/stores/workAreaStore'
import { useOrthophotoStore, tileBoundsLatLng } from '@/stores/orthophotoStore'
import { CoordinateMap, type ExternalPolygon } from '@/components/map/CoordinateMap'

export function OrthophotoPage() {
  const { currentFarm } = useFarmStore()
  const { projects } = useProjectListStore()
  const { byFarm, fetchByFarm, createTileset, uploadTiles, deleteTileset } = useOrthophotoStore()
  const { setZone, fetchCoordinates } = useCoordinateStore()
  const { workAreas, fetchWorkAreas } = useWorkAreaStore()
  const tilesets = useMemo(
    () => (currentFarm ? byFarm.get(currentFarm.id) ?? [] : []),
    [byFarm, currentFarm],
  )

  // プロジェクトの座標系
  const projectZone = currentFarm
    ? projects.find((p) => p.id === currentFarm.project_id)?.coordinate_zone ?? null
    : null

  // 工区切替時にオルソ・座標・区域をまとめて読み込み
  useEffect(() => {
    if (!currentFarm) return
    fetchByFarm(currentFarm.id)
    fetchWorkAreas(currentFarm.id)
    if (projectZone !== null) {
      setZone(projectZone)
      fetchCoordinates(currentFarm.id)
    }
  }, [currentFarm, projectZone, fetchByFarm, fetchWorkAreas, setZone, fetchCoordinates])

  // 区域ポリゴン（全工種を表示）
  const workAreaPolygons = useMemo<ExternalPolygon[]>(() => {
    const out: ExternalPolygon[] = []
    for (const [, areas] of Object.entries(workAreas) as [
      string,
      { id: string; name: string; points: WorkAreaPoint[] }[] | undefined,
    ][]) {
      if (!areas) continue
      for (const area of areas) {
        const pts = area.points.filter((p) => p.lat !== null && p.lng !== null)
        const positions = pts.map((p) => [p.lat as number, p.lng as number] as [number, number])
        if (positions.length >= 3) {
          out.push({ id: area.id, name: area.name, positions, pointIds: pts.map((p) => p.id) })
        }
      }
    }
    return out
  }, [workAreas])

  // ===== アップロード用 state =====
  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [opacity, setOpacity] = useState(85)
  const [busy, setBusy] = useState<'parsing' | 'uploading' | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  // モーダル表示
  const [showUpload, setShowUpload] = useState(false)
  const [showList, setShowList] = useState(false)

  // input(webkitdirectory) 属性付与
  useEffect(() => {
    const el = fileRef.current
    if (el) {
      el.setAttribute('webkitdirectory', '')
      el.setAttribute('directory', '')
      el.setAttribute('mozdirectory', '')
    }
  }, [showUpload])

  // フォルダ選択
  const handleChooseFolder = async () => {
    setError(null)
    setMessage(null)
    const w = window as unknown as {
      showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>
    }
    if (typeof w.showDirectoryPicker === 'function') {
      try {
        const dir = await w.showDirectoryPicker()
        setBusy('parsing')
        const collected: Array<{ relPath: string; file: File }> = []
        const recurse = async (handle: FileSystemDirectoryHandle, prefix: string) => {
          // @ts-expect-error values() は型定義に無い場合がある
          for await (const entry of handle.values()) {
            if (entry.kind === 'file') {
              const fh = entry as FileSystemFileHandle
              const file = await fh.getFile()
              collected.push({ relPath: prefix + entry.name, file })
            } else if (entry.kind === 'directory') {
              await recurse(entry as FileSystemDirectoryHandle, prefix + entry.name + '/')
            }
          }
        }
        await recurse(dir, '')
        await processFiles(collected)
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') {
          setBusy(null)
          return
        }
        setError(err instanceof Error ? err.message : 'フォルダの読み取りに失敗しました')
        setBusy(null)
      }
      return
    }
    fileRef.current?.click()
  }

  const handleFolderChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files
    e.target.value = ''
    if (!list || list.length === 0) {
      setError('ファイルが選択されませんでした。')
      return
    }
    const collected: Array<{ relPath: string; file: File }> = []
    for (let i = 0; i < list.length; i++) {
      const f = list[i]
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
      collected.push({ relPath: rel, file: f })
    }
    await processFiles(collected)
  }

  const processFiles = async (collected: Array<{ relPath: string; file: File }>) => {
    setError(null)
    setMessage(null)
    if (!currentFarm) {
      setError('工区が選択されていません。')
      setBusy(null)
      return
    }
    setBusy('parsing')
    try {
      const files: Array<{ relPath: string; file: File; z: number; x: number; y: number }> = []
      let minZoom = Infinity
      let maxZoom = -Infinity
      let tileFormat = 'png'
      const xByZ = new Map<number, { min: number; max: number }>()
      const yByZ = new Map<number, { min: number; max: number }>()
      for (const { relPath, file: f } of collected) {
        const m = relPath.match(/(?:^|\/)(\d+)\/(\d+)\/(\d+)\.(png|jpg|jpeg|webp)$/i)
        if (!m) continue
        const z = parseInt(m[1], 10)
        const x = parseInt(m[2], 10)
        const y = parseInt(m[3], 10)
        const ext = m[4].toLowerCase()
        tileFormat = ext === 'jpeg' ? 'jpg' : ext
        files.push({ relPath: `${z}/${x}/${y}.${ext}`, file: f, z, x, y })
        if (z < minZoom) minZoom = z
        if (z > maxZoom) maxZoom = z
        const xr = xByZ.get(z) ?? { min: Infinity, max: -Infinity }
        xr.min = Math.min(xr.min, x); xr.max = Math.max(xr.max, x)
        xByZ.set(z, xr)
        const yr = yByZ.get(z) ?? { min: Infinity, max: -Infinity }
        yr.min = Math.min(yr.min, y); yr.max = Math.max(yr.max, y)
        yByZ.set(z, yr)
      }
      if (files.length === 0) {
        setError(
          `{z}/{x}/{y}.png 形式のタイルが見つかりませんでした（選択ファイル数: ${collected.length}）。` +
            'QGIS の「Generate XYZ tiles (Directory)」で出力したフォルダを丸ごと選択してください。',
        )
        setBusy(null)
        return
      }
      const xr = xByZ.get(maxZoom)!
      const yr = yByZ.get(maxZoom)!
      const nw = tileBoundsLatLng(maxZoom, xr.min, yr.min)
      const se = tileBoundsLatLng(maxZoom, xr.max, yr.max)
      const bounds = { north: nw.north, west: nw.west, south: se.south, east: se.east }

      setBusy('uploading')
      const tileset = await createTileset({
        farmId: currentFarm.id,
        name: name.trim() || `オルソ_${new Date().toISOString().slice(0, 10)}`,
        minZoom,
        maxZoom,
        bounds,
        tileFormat,
        opacity: opacity / 100,
      })
      if (!tileset) {
        const se = useOrthophotoStore.getState().error
        setError(`タイルセット行の作成に失敗しました${se ? `: ${se}` : ''}`)
        setBusy(null)
        return
      }
      const uploads = files.map((f) => ({ relPath: f.relPath, file: f.file }))
      setProgress({ done: 0, total: uploads.length })
      const { uploaded, failed, firstError } = await uploadTiles(tileset, uploads, (done, total) => {
        setProgress({ done, total })
      })
      setProgress(null)
      if (uploaded === 0 && failed > 0) {
        setError(
          `タイルのアップロードが全て失敗しました（${failed} 件）。` +
            (firstError ? `エラー: ${firstError}` : ''),
        )
      } else {
        setMessage(`${uploaded.toLocaleString()} 件アップロード完了` + (failed > 0 ? ` / ${failed} 件失敗` : ''))
      }
      setName('')
      await fetchByFarm(currentFarm.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'アップロードに失敗しました')
    } finally {
      setBusy(null)
    }
  }

  // ===== レンダリング =====

  if (!currentFarm) {
    return (
      <div className="h-full flex flex-col">
        <PageHeader title="オルソ画像" subtitle="ドローン等のオルソ画像（Web タイル）" />
        <div className="flex-1 flex items-center justify-center text-sm text-slate-500">
          工区を選択してください
        </div>
      </div>
    )
  }

  const headerActions = (
    <div className="flex items-center gap-2">
      <button
        onClick={() => setShowList(true)}
        className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
        title="登録済みオルソ一覧"
      >
        <List className="h-4 w-4" />
        登録済み
        <span className="ml-1 text-xs text-blue-600">({tilesets.length})</span>
      </button>
      <button
        onClick={() => setShowUpload(true)}
        className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
        title="オルソ画像のアップロード"
      >
        <Upload className="h-4 w-4" />
        アップロード
      </button>
    </div>
  )

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="オルソ画像" subtitle="ドローン等のオルソ画像（Web タイル）" actions={headerActions} />

      {/* 大きな地図（オルソ＋座標＋区域） */}
      <div className="flex-1 relative">
        <CoordinateMap
          key={currentFarm.id}
          farmId={currentFarm.id}
          showOrtho
          externalPolygons={workAreaPolygons}
        />
      </div>

      {/* アップロードモーダル */}
      {showUpload && (
        <div className="fixed inset-0 z-[3000] bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
            <div className="px-4 py-3 border-b flex items-center gap-2">
              <Upload className="h-4 w-4 text-blue-600" />
              <span className="font-semibold text-sm">タイルフォルダのアップロード</span>
              <button onClick={() => setShowUpload(false)} className="ml-auto text-slate-400 hover:text-slate-700">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <p className="text-xs text-slate-600">
                QGIS の「ラスタ ⇒ 変換 ⇒ XYZ タイルを生成」や <code>gdal2tiles.py</code> で
                作成した <code>{'{z}/{x}/{y}.png'}</code> 形式のフォルダを選択してください。
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-slate-600">表示名（任意）</span>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="例: 2026-05-19 ドローン撮影"
                    className="px-2 py-1.5 border rounded text-sm"
                    disabled={busy !== null}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-slate-600">不透明度: {opacity}%</span>
                  <input
                    type="range"
                    min={20}
                    max={100}
                    value={opacity}
                    onChange={(e) => setOpacity(parseInt(e.target.value, 10))}
                    disabled={busy !== null}
                  />
                </label>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={handleChooseFolder}
                  disabled={busy !== null}
                  className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  フォルダを選択してアップロード
                </button>
                {progress && (
                  <div className="flex items-center gap-2 text-xs text-slate-700">
                    <span>
                      {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
                    </span>
                    <div className="w-40 h-2 bg-slate-200 rounded overflow-hidden">
                      <div
                        className="h-full bg-blue-600 transition-[width] duration-150"
                        style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
                      />
                    </div>
                  </div>
                )}
                {!progress && message && (
                  <span className="text-xs text-emerald-700">{message}</span>
                )}
                {error && (
                  <span className="text-xs text-red-600 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    {error}
                  </span>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                multiple
                onChange={handleFolderChosen}
                className="hidden"
              />
            </div>
            <div className="px-4 py-3 border-t flex justify-end">
              <button
                onClick={() => setShowUpload(false)}
                disabled={busy !== null}
                className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 登録済みオルソ一覧モーダル */}
      {showList && (
        <div className="fixed inset-0 z-[3000] bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl">
            <div className="px-4 py-3 border-b flex items-center gap-2">
              <ImageIcon className="h-4 w-4 text-slate-700" />
              <span className="font-semibold text-sm">登録済みオルソ ({tilesets.length})</span>
              <button onClick={() => setShowList(false)} className="ml-auto text-slate-400 hover:text-slate-700">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-4 max-h-[60vh] overflow-y-auto">
              {tilesets.length === 0 ? (
                <div className="text-xs text-slate-400 py-4 text-center">登録されていません</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-2 py-1 text-left">名称</th>
                      <th className="px-2 py-1 text-right">ズーム</th>
                      <th className="px-2 py-1 text-right">不透明度</th>
                      <th className="px-2 py-1 text-left">作成日</th>
                      <th className="px-2 py-1 w-8"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {tilesets.map((t) => (
                      <tr key={t.id}>
                        <td className="px-2 py-1">{t.name}</td>
                        <td className="px-2 py-1 text-right font-mono">
                          {t.minZoom}–{t.maxZoom}
                        </td>
                        <td className="px-2 py-1 text-right">{Math.round(t.opacity * 100)}%</td>
                        <td className="px-2 py-1 text-xs text-slate-500">
                          {new Date(t.createdAt).toLocaleString('ja-JP')}
                        </td>
                        <td className="px-2 py-1">
                          <button
                            onClick={() => {
                              if (confirm(`${t.name} を削除しますか？（DBのみ。Storage上のタイルは残ります）`)) {
                                deleteTileset(t.id)
                              }
                            }}
                            className="p-1 text-red-500 hover:bg-red-50 rounded"
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
            <div className="px-4 py-3 border-t flex justify-end">
              <button
                onClick={() => setShowList(false)}
                className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
