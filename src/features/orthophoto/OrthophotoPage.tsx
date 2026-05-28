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
import { CoordinateConverter } from '@/lib/coordinates'
import {
  OrthophotoAnnotations,
  type ToolMode,
  type MeasureGeom,
  type LineSeg,
  DRAW_TOOLS,
  MEASURE_TOOLS,
  formatMeasureValue,
} from './OrthophotoAnnotations'
import {
  type Annotation,
  type DimensionAnnotation,
  newAnnotationId,
  loadAnnotations,
  saveAnnotations,
} from '@/lib/annotations'
import { buildDxf, downloadDxf, type DxfEntity } from '@/lib/dxf'
import { FileDown } from 'lucide-react'
import type { CoordinateRow } from '@/stores/coordinateStore'

export function OrthophotoPage() {
  const { currentFarm } = useFarmStore()
  const { projects } = useProjectListStore()
  const { byFarm, fetchByFarm, createTileset, uploadTiles, deleteTileset } = useOrthophotoStore()
  const { setZone, fetchCoordinates, importCoordinates, coordinates, selectedType } = useCoordinateStore()
  const { fetchMembers, members } = useProjectListStore()
  const { workAreas, fetchWorkAreas } = useWorkAreaStore()
  const tilesets = useMemo(
    () => (currentFarm ? byFarm.get(currentFarm.id) ?? [] : []),
    [byFarm, currentFarm],
  )

  // プロジェクトの座標系
  const projectZone = currentFarm
    ? projects.find((p) => p.id === currentFarm.project_id)?.coordinate_zone ?? null
    : null

  // 工区切替時にオルソ・座標・区域・メンバー・点種をまとめて読み込み
  useEffect(() => {
    if (!currentFarm) return
    fetchByFarm(currentFarm.id)
    fetchWorkAreas(currentFarm.id)
    if (projectZone !== null) {
      setZone(projectZone)
      fetchCoordinates(currentFarm.id)
    }
    if (currentFarm.project_id) {
      fetchMembers(currentFarm.project_id)
    }
  }, [currentFarm, projectZone, fetchByFarm, fetchWorkAreas, setZone, fetchCoordinates, fetchMembers])

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

  // ===== 作図・計測 =====
  const [tool, setTool] = useState<ToolMode>('none')
  const [drawColor, setDrawColor] = useState('#dc2626')
  const [fontSize, setFontSize] = useState(14) // px
  const [currentLayer, setCurrentLayer] = useState('0')
  const [selectedAnnoId, setSelectedAnnoId] = useState<string | null>(null)
  const [snapEnabled, setSnapEnabled] = useState(false)
  // 平行線ツール用
  const [parallelRef, setParallelRef] = useState<LineSeg | null>(null)
  const [parallelOffset, setParallelOffset] = useState<string>('')
  // Undo 履歴（直近10件）
  const [history, setHistory] = useState<Annotation[][]>([])
  const HISTORY_LIMIT = 10
  const [annotations, setAnnotationsState] = useState<Annotation[]>([])
  const [lastMeasure, setLastMeasure] = useState<MeasureGeom | null>(null)
  // コメント入力モーダル
  const [pendingComment, setPendingComment] = useState<{ pos: [number, number] } | null>(null)
  // 工区切替で読み込み・保存（履歴もリセット）
  useEffect(() => {
    if (currentFarm) setAnnotationsState(loadAnnotations(currentFarm.id))
    else setAnnotationsState([])
    setLastMeasure(null)
    setTool('none')
    setHistory([])
    setParallelRef(null)
    setParallelOffset('')
  }, [currentFarm])
  // 履歴付きで annotations を更新（直前状態をスタックへ push、最新10件のみ保持）
  const setAnnotations = (next: Annotation[]) => {
    setHistory((prev) => [...prev, annotations].slice(-HISTORY_LIMIT))
    setAnnotationsState(next)
    if (currentFarm) saveAnnotations(currentFarm.id, next)
  }
  // 元に戻す（履歴の末尾を取り出して反映）
  const undo = () => {
    setHistory((prev) => {
      if (prev.length === 0) return prev
      const last = prev[prev.length - 1]
      setAnnotationsState(last)
      if (currentFarm) saveAnnotations(currentFarm.id, last)
      return prev.slice(0, -1)
    })
  }
  // Ctrl/Cmd + Z で undo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, history])
  // 計測用の座標変換（プロジェクト座標系）
  const converter = useMemo(() => new CoordinateConverter(projectZone ?? 13), [projectZone])

  // 点(座標登録) ツール: クリック位置を座標管理に追加
  const handleAddCoordinate = (lat: number, lng: number) => {
    if (!currentFarm) return
    const xy = converter.toXY(lat, lng)
    const defaultName = `P${coordinates.length + 1}`
    const name = window.prompt('点番号', defaultName)
    if (name === null) return
    const pn = name.trim() || defaultName
    importCoordinates([{ pointNumber: pn, x: xy.x, y: xy.y, z: null, type: selectedType as CoordinateRow['type'] }])
  }

  // 計測結果を寸法線アノテーションとして保存
  const handleKeepDimension = () => {
    if (!lastMeasure) return
    const dim: DimensionAnnotation = {
      id: newAnnotationId(),
      kind: 'dimension',
      subKind: lastMeasure.kind,
      vertices: lastMeasure.vertices,
      value: lastMeasure.value,
      color: drawColor,
      size: fontSize,
      layer: currentLayer,
    }
    setAnnotations([...annotations, dim])
    setLastMeasure(null)
  }

  // 既存レイヤ名の一覧（候補表示用）
  const existingLayers = useMemo(() => {
    const set = new Set<string>(['0'])
    for (const a of annotations) if (a.layer) set.add(a.layer)
    return Array.from(set).sort()
  }, [annotations])

  // 図形以外のスナップ候補（座標管理の点 ＋ 区域の頂点）
  const extraSnapPoints = useMemo<[number, number][]>(() => {
    const out: [number, number][] = []
    for (const c of coordinates) {
      if (c.lat !== null && c.lng !== null) out.push([c.lat, c.lng])
    }
    for (const poly of workAreaPolygons) {
      for (const p of poly.positions) out.push(p)
    }
    return out
  }, [coordinates, workAreaPolygons])

  // 平行線の参照線候補に区域の辺を含める
  const extraLineSegments = useMemo<LineSeg[]>(() => {
    const out: LineSeg[] = []
    for (const poly of workAreaPolygons) {
      const v = poly.positions
      for (let i = 0; i < v.length; i++) {
        const j = (i + 1) % v.length
        out.push({ a: v[i], b: v[j] })
      }
    }
    return out
  }, [workAreaPolygons])

  // 選択中アノテーション
  const selectedAnno = annotations.find((a) => a.id === selectedAnnoId) ?? null

  // アノテーションのフィールドを更新
  const updateAnnotation = (id: string, patch: Partial<Annotation>) => {
    setAnnotations(annotations.map((a) => (a.id === id ? ({ ...a, ...patch } as Annotation) : a)))
  }
  const deleteAnnotation = (id: string) => {
    setAnnotations(annotations.filter((a) => a.id !== id))
    setSelectedAnnoId(null)
  }

  // DXF 出力（CAD慣例の X=東/Y=北 に変換して書き出す）
  const handleDxfExport = () => {
    if (annotations.length === 0) {
      alert('出力する作図がありません')
      return
    }
    const entities: DxfEntity[] = []
    // lat/lng → 平面(X=北,Y=東) → DXF(X=東,Y=北)
    const dxfXY = (lat: number, lng: number) => {
      const p = converter.toXY(lat, lng)
      return { x: p.y, y: p.x }
    }
    for (const a of annotations) {
      // 種類別の既定レイヤ（ユーザー指定が無い場合のフォールバック）
      const defaultLayer = (a.kind === 'point' ? 'POINT'
        : a.kind === 'line' ? 'LINE'
        : a.kind === 'polygon' ? 'POLYGON'
        : a.kind === 'circle' ? 'CIRCLE'
        : a.kind === 'arc' ? 'ARC'
        : a.kind === 'text' ? 'TEXT'
        : a.kind === 'comment' ? 'COMMENT'
        : 'DIM')
      const layer = a.layer && a.layer.trim() !== '' ? a.layer : defaultLayer
      switch (a.kind) {
        case 'point': {
          const p = dxfXY(a.pos[0], a.pos[1])
          entities.push({ type: 'POINT', x: p.x, y: p.y, layer })
          break
        }
        case 'line': {
          const v = a.vertices.map((vv) => dxfXY(vv[0], vv[1]))
          for (let i = 0; i < v.length - 1; i++) {
            entities.push({ type: 'LINE', x1: v[i].x, y1: v[i].y, x2: v[i + 1].x, y2: v[i + 1].y, layer })
          }
          break
        }
        case 'polygon': {
          const v = a.vertices.map((vv) => dxfXY(vv[0], vv[1]))
          for (let i = 0; i < v.length; i++) {
            const j = (i + 1) % v.length
            entities.push({ type: 'LINE', x1: v[i].x, y1: v[i].y, x2: v[j].x, y2: v[j].y, layer })
          }
          break
        }
        case 'circle': {
          const c = dxfXY(a.center[0], a.center[1])
          entities.push({ type: 'CIRCLE', cx: c.x, cy: c.y, r: a.radius, layer })
          break
        }
        case 'arc': {
          const c = dxfXY(a.center[0], a.center[1])
          entities.push({
            type: 'ARC',
            cx: c.x,
            cy: c.y,
            r: a.radius,
            startAngleDeg: a.startDeg,
            endAngleDeg: a.endDeg,
            layer,
          })
          break
        }
        case 'text':
        case 'comment': {
          const p = dxfXY(a.pos[0], a.pos[1])
          entities.push({
            type: 'TEXT',
            x: p.x,
            y: p.y,
            text: a.text,
            height: ((a.size ?? 14) / 28),
            layer,
          })
          break
        }
        case 'dimension': {
          if (a.subKind === 'dist' && a.vertices.length >= 2) {
            const [p1, p2] = a.vertices.map((v) => dxfXY(v[0], v[1]))
            entities.push({ type: 'LINE', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, layer })
            entities.push({
              type: 'TEXT',
              x: (p1.x + p2.x) / 2,
              y: (p1.y + p2.y) / 2,
              text: a.value < 1 ? `${(a.value * 100).toFixed(1)} cm` : `${a.value.toFixed(3)} m`,
              height: ((a.size ?? 14) / 28),
              layer,
            })
          } else if (a.subKind === 'area' && a.vertices.length >= 3) {
            const v = a.vertices.map((vv) => dxfXY(vv[0], vv[1]))
            for (let i = 0; i < v.length; i++) {
              const j = (i + 1) % v.length
              entities.push({ type: 'LINE', x1: v[i].x, y1: v[i].y, x2: v[j].x, y2: v[j].y, layer })
            }
            const cx = v.reduce((s, p) => s + p.x, 0) / v.length
            const cy = v.reduce((s, p) => s + p.y, 0) / v.length
            entities.push({
              type: 'TEXT',
              x: cx,
              y: cy,
              text: `${a.value.toFixed(2)} m² (${(a.value / 10000).toFixed(4)} ha)`,
              height: ((a.size ?? 14) / 28),
              layer,
            })
          } else if (a.subKind === 'perp' && a.vertices.length >= 3) {
            const [p1, p2, pp] = a.vertices.map((v) => dxfXY(v[0], v[1]))
            entities.push({ type: 'LINE', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, layer })
            const ABx = p2.x - p1.x
            const ABy = p2.y - p1.y
            const L2 = ABx * ABx + ABy * ABy
            const t = L2 === 0 ? 0 : ((pp.x - p1.x) * ABx + (pp.y - p1.y) * ABy) / L2
            const Fx = p1.x + t * ABx
            const Fy = p1.y + t * ABy
            entities.push({ type: 'LINE', x1: pp.x, y1: pp.y, x2: Fx, y2: Fy, layer })
            entities.push({
              type: 'TEXT',
              x: (pp.x + Fx) / 2,
              y: (pp.y + Fy) / 2,
              text: a.value < 1 ? `${(a.value * 100).toFixed(1)} cm` : `${a.value.toFixed(3)} m`,
              height: ((a.size ?? 14) / 28),
              layer,
            })
          }
          break
        }
      }
    }
    const dxf = buildDxf(entities)
    const farmName = currentFarm?.name || 'ortho'
    const date = new Date().toISOString().slice(0, 10)
    downloadDxf(dxf, `${farmName}_${date}.dxf`)
  }

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
        onClick={handleDxfExport}
        disabled={annotations.length === 0}
        className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
        title="作図データをDXFで出力"
      >
        <FileDown className="h-4 w-4" />
        DXF出力
        {annotations.length > 0 && <span className="ml-1 text-xs text-blue-600">({annotations.length})</span>}
      </button>
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

      {/* 大きな地図（オルソ＋座標＋区域＋作図） */}
      <div className="flex-1 relative">
        <CoordinateMap
          key={currentFarm.id}
          farmId={currentFarm.id}
          showOrtho
          externalPolygons={workAreaPolygons}
          coordinatesInteractive={false}
        >
          <OrthophotoAnnotations
            tool={tool}
            color={drawColor}
            fontSize={fontSize}
            currentLayer={currentLayer}
            annotations={annotations}
            setAnnotations={setAnnotations}
            converter={converter}
            lastMeasure={lastMeasure}
            setLastMeasure={setLastMeasure}
            onAddCoordinate={handleAddCoordinate}
            onRequestComment={(pos) => setPendingComment({ pos })}
            onSelect={(id) => setSelectedAnnoId(id)}
            snapEnabled={snapEnabled}
            extraSnapPoints={extraSnapPoints}
            extraLineSegments={extraLineSegments}
            parallelRef={parallelRef}
            setParallelRef={setParallelRef}
            parallelOffset={parallelOffset}
          />
        </CoordinateMap>

        {/* 作図ツールバー（左上オーバーレイ・上段=作図／下段=計測） */}
        <div className="absolute top-2 left-2 z-[1000] bg-white/95 border rounded-lg shadow p-2 flex flex-col gap-1 max-w-[calc(100%-1rem)]">
          {/* 上段: 作図 */}
          <div className="flex items-center gap-1 flex-wrap">
            <span className="text-[10px] text-slate-400 mr-1 select-none">作図</span>
            {DRAW_TOOLS.map((t) => {
              const active = tool === t.tool
              return (
                <button
                  key={t.tool}
                  onClick={() => setTool(t.tool)}
                  className={`px-2 py-1 text-xs rounded border ${
                    active ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}
                  title={t.help ?? t.label}
                >
                  {t.label}
                </button>
              )
            })}
            <label className="flex items-center gap-1 ml-1 text-xs text-slate-600">
              色
              <input
                type="color"
                value={drawColor}
                onChange={(e) => setDrawColor(e.target.value)}
                className="w-7 h-6 p-0 border rounded cursor-pointer"
              />
            </label>
            <label className="flex items-center gap-1 text-xs text-slate-600">
              文字
              <input
                type="number"
                min={8}
                max={48}
                value={fontSize}
                onChange={(e) => setFontSize(Math.max(8, Math.min(48, parseInt(e.target.value, 10) || 14)))}
                className="w-12 px-1 py-0.5 border rounded text-right font-mono"
                title="文字・コメント・寸法ラベルのサイズ(px)"
              />
              px
            </label>
            <label className="flex items-center gap-1 text-xs text-slate-600">
              レイヤ
              <input
                type="text"
                value={currentLayer}
                onChange={(e) => setCurrentLayer(e.target.value)}
                list="ortho-layers"
                className="w-24 px-1 py-0.5 border rounded font-mono"
                title="作図時に付与するレイヤ名（DXF出力にも反映）"
              />
              <datalist id="ortho-layers">
                {existingLayers.map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
            </label>
            <button
              onClick={() => setSnapEnabled((v) => !v)}
              className={`px-2 py-1 text-xs rounded border ${
                snapEnabled
                  ? 'bg-amber-100 border-amber-400 text-amber-800 font-medium'
                  : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
              }`}
              title="ピック(スナップ): ONで近接する点や端部に吸着します"
            >
              {snapEnabled ? '🎯 ピックON' : '🎯 ピックOFF'}
            </button>
            <button
              onClick={undo}
              disabled={history.length === 0}
              className="px-2 py-1 text-xs rounded border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              title={`元に戻す (Ctrl+Z) - 最大${HISTORY_LIMIT}回`}
            >
              ↶ 元に戻す
              {history.length > 0 && <span className="ml-1 text-blue-600">({history.length})</span>}
            </button>
            {annotations.length > 0 && (
              <button
                onClick={() => {
                  if (confirm(`作図(${annotations.length}件)をすべて削除しますか？`)) setAnnotations([])
                }}
                className="px-2 py-1 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50"
                title="作図を全消去"
              >
                全消去
              </button>
            )}
          </div>
          {/* 下段: 計測 */}
          <div className="flex items-center gap-1 flex-wrap pt-1 border-t">
            <span className="text-[10px] text-slate-400 mr-1 select-none">計測</span>
            {MEASURE_TOOLS.map((t) => {
              const active = tool === t.tool
              return (
                <button
                  key={t.tool}
                  onClick={() => setTool(t.tool)}
                  className={`px-2 py-1 text-xs rounded border ${
                    active ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}
                  title={t.help ?? t.label}
                >
                  {t.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* ツールヘルプ＋計測結果（左下） */}
        {(tool !== 'none' || lastMeasure) && (
          <div className="absolute bottom-2 left-2 z-[1000] bg-white/95 border rounded-lg shadow px-3 py-2 text-xs space-y-1 max-w-[calc(100%-1rem)]">
            {tool !== 'none' && (
              <div className="text-slate-700">
                <span className="font-semibold">
                  {[...DRAW_TOOLS, ...MEASURE_TOOLS].find((t) => t.tool === tool)?.label ?? tool}
                </span>
                <span className="ml-2 text-slate-500">
                  {[...DRAW_TOOLS, ...MEASURE_TOOLS].find((t) => t.tool === tool)?.help ?? ''}
                </span>
              </div>
            )}
            {tool === 'parallel' && (
              <div className="flex items-center gap-2">
                <span className="text-slate-600 text-[11px]">
                  {parallelRef
                    ? '参照線を選択中 → クリック位置で平行線を引きます'
                    : '基準となる線/辺をクリックしてください'}
                </span>
                <label className="flex items-center gap-1 text-slate-600">
                  幅(m)
                  <input
                    type="number"
                    step="0.001"
                    value={parallelOffset}
                    onChange={(e) => setParallelOffset(e.target.value)}
                    placeholder="空欄なら通過点"
                    className="w-20 px-1 py-0.5 border rounded text-right font-mono"
                  />
                </label>
                {parallelRef && (
                  <button
                    onClick={() => setParallelRef(null)}
                    className="px-2 py-0.5 text-[11px] border rounded hover:bg-slate-50"
                  >
                    線を選び直す
                  </button>
                )}
              </div>
            )}
            {lastMeasure && (
              <div className="flex items-center gap-2 text-sm font-mono text-emerald-700">
                <span>
                  {lastMeasure.kind === 'dist' && '距離: '}
                  {lastMeasure.kind === 'area' && '面積: '}
                  {lastMeasure.kind === 'perp' && '垂線長: '}
                  {formatMeasureValue(lastMeasure)}
                </span>
                <button
                  onClick={handleKeepDimension}
                  className="text-xs px-2 py-0.5 border border-emerald-300 text-emerald-700 rounded hover:bg-emerald-50"
                  title="この計測を寸法線として作図に保存"
                >
                  寸法線として残す
                </button>
                <button
                  onClick={() => setLastMeasure(null)}
                  className="text-xs text-slate-400 hover:text-slate-700"
                >
                  クリア
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 図形インスペクタ（選択ツールで図形クリックすると表示） */}
      {selectedAnno && (
        <div className="absolute top-2 right-2 z-[1000] bg-white border rounded-lg shadow p-3 w-64 text-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold">図形を編集</span>
            <button
              onClick={() => setSelectedAnnoId(null)}
              className="text-slate-400 hover:text-slate-700"
              title="閉じる"
            >
              ×
            </button>
          </div>
          <div className="text-xs text-slate-500 mb-2">
            種類: <b>{selectedAnno.kind}</b>
          </div>
          <label className="flex items-center justify-between gap-2 mb-2">
            <span className="text-xs text-slate-600">色</span>
            <input
              type="color"
              value={selectedAnno.color}
              onChange={(e) => updateAnnotation(selectedAnno.id, { color: e.target.value })}
              className="w-8 h-6 p-0 border rounded cursor-pointer"
            />
          </label>
          <label className="flex items-center justify-between gap-2 mb-2">
            <span className="text-xs text-slate-600">レイヤ</span>
            <input
              type="text"
              value={selectedAnno.layer ?? '0'}
              onChange={(e) => updateAnnotation(selectedAnno.id, { layer: e.target.value })}
              list="ortho-layers"
              className="flex-1 px-1 py-0.5 border rounded font-mono text-xs"
            />
          </label>
          <div className="flex justify-between mt-3 pt-2 border-t">
            <button
              onClick={() => deleteAnnotation(selectedAnno.id)}
              className="px-2 py-1 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50"
            >
              削除
            </button>
            <button
              onClick={() => setSelectedAnnoId(null)}
              className="px-2 py-1 text-xs border border-slate-300 text-slate-600 rounded hover:bg-slate-50"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* コメント入力モーダル（メンバーをメンション可） */}
      {pendingComment && (
        <CommentInputModal
          members={members.map((m) => ({
            email: m.email ?? '',
            name: m.display_name ?? m.email ?? '',
          }))}
          onCancel={() => setPendingComment(null)}
          onConfirm={(text, mentions) => {
            if (text.trim()) {
              setAnnotations([
                ...annotations,
                {
                  id: newAnnotationId(),
                  kind: 'comment',
                  pos: pendingComment.pos,
                  text: text.trim(),
                  color: drawColor,
                  size: fontSize,
                  layer: currentLayer,
                  mentions,
                },
              ])
            }
            setPendingComment(null)
          }}
        />
      )}

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

// =============================================
// コメント入力モーダル（@メンション挿入対応）
// =============================================
function CommentInputModal({
  members,
  onConfirm,
  onCancel,
}: {
  members: { email: string; name: string }[]
  onConfirm: (text: string, mentions: string[]) => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  const insertMention = (name: string) => {
    const ta = taRef.current
    if (!ta) {
      setText((t) => `${t}@${name} `)
      return
    }
    const start = ta.selectionStart ?? text.length
    const end = ta.selectionEnd ?? text.length
    const before = text.slice(0, start)
    const after = text.slice(end)
    const insert = `${start > 0 && before[start - 1] !== ' ' ? ' ' : ''}@${name} `
    const next = before + insert + after
    setText(next)
    // フォーカスとカーソル位置の復元
    setTimeout(() => {
      ta.focus()
      const p = (before + insert).length
      ta.setSelectionRange(p, p)
    }, 0)
  }

  // 入力テキストから @名前 をスキャンしてメンションリストを構築
  const computeMentions = (s: string): string[] => {
    const set = new Set<string>()
    const re = /@([^\s@]+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(s)) !== null) {
      // メンバー名と前方一致するものを採用
      const cand = m[1]
      const hit = members.find((mm) => cand.startsWith(mm.name) || cand.startsWith(mm.email))
      if (hit) set.add(hit.email || hit.name)
    }
    return Array.from(set)
  }

  return (
    <div className="fixed inset-0 z-[3000] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <div className="px-4 py-3 border-b flex items-center gap-2">
          <span className="font-semibold text-sm">コメントを入力</span>
          <button onClick={onCancel} className="ml-auto text-slate-400 hover:text-slate-700">×</button>
        </div>
        <div className="p-4 space-y-2">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            placeholder="コメント内容（@名前 でメンバーをメンションできます）"
            className="w-full px-2 py-1.5 border rounded text-sm"
            autoFocus
          />
          {members.length > 0 && (
            <div>
              <div className="text-[11px] text-slate-500 mb-1">メンション挿入</div>
              <div className="flex flex-wrap gap-1">
                {members.map((m) => (
                  <button
                    key={m.email}
                    onClick={() => insertMention(m.name || m.email)}
                    className="px-2 py-0.5 text-xs rounded border border-blue-300 text-blue-700 hover:bg-blue-50"
                    title={m.email}
                  >
                    @{m.name || m.email}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="px-4 py-3 border-t flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50">
            キャンセル
          </button>
          <button
            onClick={() => onConfirm(text, computeMentions(text))}
            disabled={!text.trim()}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            追加
          </button>
        </div>
      </div>
    </div>
  )
}
