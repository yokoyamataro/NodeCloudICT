// オルソ画像（ドローン写真など）の Web タイル管理ページ
// 1) gdal2tiles などで作成した {z}/{x}/{y}.png 形式のフォルダをアップロード
// 2) 既存タイルセット一覧の確認・削除

import { useEffect, useMemo, useRef, useState } from 'react'
import { Upload, Loader2, Trash2, Image as ImageIcon, AlertTriangle } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { useFarmStore } from '@/stores/farmStore'
import { useOrthophotoStore, tileBoundsLatLng } from '@/stores/orthophotoStore'

// HTMLInputElement に webkitdirectory を追加するための型補強
type DirInputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  webkitdirectory?: ''
  directory?: ''
}

export function OrthophotoPage() {
  const { currentFarm } = useFarmStore()
  const { byFarm, fetchByFarm, createTileset, uploadTiles, deleteTileset } = useOrthophotoStore()
  const tilesets = useMemo(
    () => (currentFarm ? byFarm.get(currentFarm.id) ?? [] : []),
    [byFarm, currentFarm],
  )

  useEffect(() => {
    if (currentFarm) fetchByFarm(currentFarm.id)
  }, [currentFarm, fetchByFarm])

  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [opacity, setOpacity] = useState(85)
  const [busy, setBusy] = useState<'parsing' | 'uploading' | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const handleChooseFolder = () => fileRef.current?.click()

  const handleFolderChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!currentFarm) return
    const list = e.target.files
    e.target.value = ''
    if (!list || list.length === 0) return
    setError(null)
    setMessage(null)
    setBusy('parsing')
    try {
      // 1) 全ファイルから z/x/y.* のパターンに合うものを抽出
      const files: Array<{ relPath: string; file: File; z: number; x: number; y: number }> = []
      let minZoom = Infinity
      let maxZoom = -Infinity
      let tileFormat = 'png'
      const xByZ = new Map<number, { min: number; max: number }>()
      const yByZ = new Map<number, { min: number; max: number }>()
      for (let i = 0; i < list.length; i++) {
        const f = list[i]
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
        // 末尾 2 〜 3 セグメントが {z}/{x}/{y}.{ext} になっているものを採用
        const m = rel.match(/(?:^|\/)(\d+)\/(\d+)\/(\d+)\.(png|jpg|jpeg|webp)$/i)
        if (!m) continue
        const z = parseInt(m[1], 10)
        const x = parseInt(m[2], 10)
        const y = parseInt(m[3], 10)
        const ext = m[4].toLowerCase()
        tileFormat = ext === 'jpeg' ? 'jpg' : ext
        // 保存先は基準パスからの相対（z/x/y.ext）に正規化
        const normRel = `${z}/${x}/${y}.${ext}`
        files.push({ relPath: normRel, file: f, z, x, y })
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
          `{z}/{x}/{y}.png 形式のタイルが見つかりませんでした（選択ファイル数: ${list.length}）。` +
            'QGIS の「Generate XYZ tiles (Directory)」で出力したフォルダを丸ごと選択してください。',
        )
        setBusy(null)
        return
      }
      console.log('[orthophoto] 検出タイル', { count: files.length, minZoom, maxZoom, tileFormat })

      // 2) 最深ズームのタイル範囲から地理境界を計算
      const xr = xByZ.get(maxZoom)!
      const yr = yByZ.get(maxZoom)!
      const nw = tileBoundsLatLng(maxZoom, xr.min, yr.min)
      const se = tileBoundsLatLng(maxZoom, xr.max, yr.max)
      const bounds = {
        north: nw.north,
        west: nw.west,
        south: se.south,
        east: se.east,
      }

      // 3) DB 行を作成
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
        setError(`タイルセット行の作成に失敗しました${se ? `: ${se}` : '（権限・テーブル未作成の可能性）'}`)
        setBusy(null)
        return
      }

      // 4) Storage にアップロード
      const uploads = files.map((f) => ({ relPath: f.relPath, file: f.file }))
      setProgress({ done: 0, total: uploads.length })
      const { uploaded, failed } = await uploadTiles(tileset, uploads, (done, total) => {
        setProgress({ done, total })
      })
      setProgress(null)
      if (uploaded === 0 && failed > 0) {
        setError(
          `タイルのアップロードが全て失敗しました（${failed} 件）。` +
            'Storage バケット orthophoto-tiles の作成・権限（マイグレーション実行）を確認してください。',
        )
      } else {
        setMessage(
          `${uploaded.toLocaleString()} 件アップロード完了` +
            (failed > 0 ? ` / ${failed} 件失敗` : ''),
        )
      }
      setName('')
      // 一覧を確実に最新化
      await fetchByFarm(currentFarm.id)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'アップロードに失敗しました')
    } finally {
      setBusy(null)
    }
  }

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

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="オルソ画像" subtitle="ドローン等のオルソ画像（Web タイル）を管理" />

      <div className="flex-1 overflow-auto p-4 space-y-4">
        <section className="bg-white border rounded-lg p-4">
          <h2 className="text-sm font-bold mb-2 flex items-center gap-2">
            <Upload className="h-4 w-4 text-blue-600" />
            タイルフォルダのアップロード
          </h2>
          <p className="text-xs text-slate-600 mb-3">
            QGIS の「ラスタ ⇒ 変換 ⇒ XYZ タイルを生成」や `gdal2tiles.py` で
            作成した <code>{'{z}/{x}/{y}.png'}</code> 形式のフォルダを選択してください。
            ZIP ではなくフォルダごと選択します（ブラウザの仕様によりフォルダ選択で全タイルが
            個別アップロードされます）。
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
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

          <div className="flex items-center gap-2">
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
            {...({ webkitdirectory: '', directory: '' } as DirInputProps)}
            onChange={handleFolderChosen}
            className="hidden"
          />
        </section>

        <section className="bg-white border rounded-lg p-4">
          <h2 className="text-sm font-bold mb-2 flex items-center gap-2">
            <ImageIcon className="h-4 w-4 text-slate-700" />
            登録済みオルソ ({tilesets.length})
          </h2>
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
                          if (confirm(`${t.name} を削除しますか？（DB のみ。Storage 上のタイルは残ります）`)) {
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
        </section>
      </div>
    </div>
  )
}
