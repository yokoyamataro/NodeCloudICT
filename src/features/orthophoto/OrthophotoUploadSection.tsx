// オルソ画像 (タイルフォルダ) のアップロード。
//
// 元は全体図のヘッダにボタンを置いていたが、日常的に押すものではないので
// 設定 (工区設定) へ移した。全体図側からは入口を消してある。
//
// QGIS の「ラスタ ⇒ 変換 ⇒ XYZ タイルを生成」や gdal2tiles.py が出す
// {z}/{x}/{y}.png のフォルダを丸ごと受け取り、1 枚ずつ Storage へ上げる。
// フォルダ選択は File System Access API が使えればそちら、無ければ
// input[webkitdirectory] にフォールバックする。

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, Trash2, Upload } from 'lucide-react'
import { useOrthophotoStore, tileBoundsLatLng } from '@/stores/orthophotoStore'

interface Props {
  farmId: string
}

export function OrthophotoUploadSection({ farmId }: Props) {
  const {
    byFarm,
    fetchByFarm,
    createTileset,
    uploadTiles,
    deleteTileset,
  } = useOrthophotoStore()

  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [opacity, setOpacity] = useState(85)
  const [busy, setBusy] = useState<'parsing' | 'uploading' | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const tilesets = byFarm.get(farmId) ?? []

  useEffect(() => {
    void fetchByFarm(farmId)
  }, [farmId, fetchByFarm])

  // input[webkitdirectory] は JSX の属性として書けないので後から付ける
  useEffect(() => {
    const el = fileRef.current
    if (!el) return
    el.setAttribute('webkitdirectory', '')
    el.setAttribute('directory', '')
    el.setAttribute('mozdirectory', '')
  }, [])

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
        xr.min = Math.min(xr.min, x)
        xr.max = Math.max(xr.max, x)
        xByZ.set(z, xr)
        const yr = yByZ.get(z) ?? { min: Infinity, max: -Infinity }
        yr.min = Math.min(yr.min, y)
        yr.max = Math.max(yr.max, y)
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
        farmId,
        name: name.trim() || `オルソ_${new Date().toISOString().slice(0, 10)}`,
        minZoom,
        maxZoom,
        bounds,
        tileFormat,
        opacity: opacity / 100,
      })
      if (!tileset) {
        const se2 = useOrthophotoStore.getState().error
        setError(`タイルセット行の作成に失敗しました${se2 ? `: ${se2}` : ''}`)
        setBusy(null)
        return
      }
      const uploads = files.map((f) => ({ relPath: f.relPath, file: f.file }))
      setProgress({ done: 0, total: uploads.length })
      const { uploaded, failed, firstError } = await uploadTiles(
        tileset,
        uploads,
        (done, total) => setProgress({ done, total }),
      )
      setProgress(null)
      if (uploaded === 0 && failed > 0) {
        setError(
          `タイルのアップロードが全て失敗しました（${failed} 件）。` +
            (firstError ? `エラー: ${firstError}` : ''),
        )
      } else {
        setMessage(
          `${uploaded.toLocaleString()} 件アップロード完了` +
            (failed > 0 ? ` / ${failed} 件失敗` : ''),
        )
      }
      setName('')
      await fetchByFarm(farmId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'アップロードに失敗しました')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="bg-white border rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Upload className="h-4 w-4 text-blue-600" />
        <h2 className="text-base font-semibold">オルソ画像</h2>
        <span className="text-xs text-slate-500">登録済み {tilesets.length} 件</span>
      </div>

      <p className="text-xs text-slate-600">
        QGIS の「ラスタ ⇒ 変換 ⇒ XYZ タイルを生成」や <code>gdal2tiles.py</code> で
        作成した <code>{'{z}/{x}/{y}.png'}</code> 形式のフォルダを選択してください。
        アップロードしたオルソは全体図の背景に重ねて表示されます。
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
          onClick={() => void handleChooseFolder()}
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
        {!progress && message && <span className="text-xs text-emerald-700">{message}</span>}
        {error && (
          <span className="text-xs text-red-600 flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            {error}
          </span>
        )}
      </div>

      <input ref={fileRef} type="file" multiple onChange={handleFolderChosen} className="hidden" />

      {tilesets.length > 0 && (
        <table className="w-full text-xs border-t pt-2">
          <thead>
            <tr className="text-slate-500">
              <th className="py-1 text-left font-normal">名前</th>
              <th className="py-1 text-right font-normal">ズーム</th>
              <th className="py-1 text-right font-normal">不透明度</th>
              <th className="py-1"></th>
            </tr>
          </thead>
          <tbody>
            {tilesets.map((t) => (
              <tr key={t.id} className="border-t">
                <td className="py-1.5">{t.name}</td>
                <td className="py-1.5 text-right font-mono">
                  z{t.minZoom}–{t.maxZoom}
                </td>
                <td className="py-1.5 text-right font-mono">{Math.round(t.opacity * 100)}%</td>
                <td className="py-1.5 text-right">
                  <button
                    onClick={() => {
                      if (confirm(`「${t.name}」を削除しますか？タイルも消えます。`)) {
                        void deleteTileset(t.id)
                      }
                    }}
                    className="text-red-500 hover:text-red-700"
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
    </section>
  )
}
