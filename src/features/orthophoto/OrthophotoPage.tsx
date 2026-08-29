// 全体図ページ: タイトル部に「アップロード」「登録済み一覧」を集約し、
// 画面の大半を地図（オルソ＋座標＋区域＋メモ＋写真）の表示に使う。
// 右側にメモ一覧（上半分）と写真サムネ（下半分）を折りたたみパネルで集約する。
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Upload,
  Loader2,
  Trash2,
  Image as ImageIcon,
  AlertTriangle,
  List,
  X,
  StickyNote,
  PanelRightOpen,
  PanelRightClose,
  MapPin,
  Map as MapIcon,
  Eye,
  Edit3,
  Maximize2,
  Minimize2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { useFarmStore } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useUnderdrainStore, type PipeRow } from '@/stores/underdrainStore'
import { useWorkAreaStore, type WorkAreaPoint } from '@/stores/workAreaStore'
import { Polyline as LeafletPolyline, CircleMarker, Tooltip } from 'react-leaflet'
import { useOrthophotoStore, tileBoundsLatLng } from '@/stores/orthophotoStore'
import { useFarmMemoStore, EMPTY_FARM_MEMOS, type FarmMemo } from '@/stores/farmMemoStore'
import { useAttachmentStore, type Attachment } from '@/stores/attachmentStore'
import { PhotoEditModal } from '@/features/coordinates/PhotoEditModal'
import { CoordinateMap, type ExternalPolygon } from '@/components/map/CoordinateMap'
import { ParcelMapLayer } from '@/components/map/ParcelMapLayer'
import { MapDrawingLayer, type DrawingMode } from '@/components/map/MapDrawingLayer'
import { MapDrawingToolbar } from '@/components/map/MapDrawingToolbar'
import { useMapDrawingStore, EMPTY_STROKES, type LineStyle } from '@/stores/mapDrawingStore'
import { Paintbrush } from 'lucide-react'
import { useParcelMapDatasetStore } from '@/stores/parcelMapDatasetStore'
import { useParcelImportSelection } from '@/features/parcel-maps/useParcelImportSelection'
import { ParcelBatchImportBar } from '@/features/parcel-maps/ParcelBatchImportBar'
import { useMapViewStore } from '@/stores/mapViewStore'
import { CoordinateConverter } from '@/lib/coordinates'
import { buildDxf, downloadDxf } from '@/lib/dxf'
import { buildMapDrawingDxfEntities } from '@/lib/mapDrawingDxf'
import { FileDown } from 'lucide-react'
import type { CoordinateRow } from '@/stores/coordinateStore'

export function OrthophotoPage() {
  const { currentFarm } = useFarmStore()
  const { projects } = useProjectListStore()
  const { byFarm, fetchByFarm, createTileset, uploadTiles, deleteTileset } = useOrthophotoStore()
  const { setZone, fetchCoordinates, importCoordinates, coordinates, selectedType } = useCoordinateStore()
  const { workAreas, fetchWorkAreas } = useWorkAreaStore()
  // メモ + 写真（右側パネルと地図上マーカーの両方で使う）
  const farmMemos = useFarmMemoStore((s) =>
    currentFarm ? s.byFarm.get(currentFarm.id) ?? EMPTY_FARM_MEMOS : EMPTY_FARM_MEMOS,
  )
  const fetchFarmMemos = useFarmMemoStore((s) => s.fetchByFarm)
  const {
    fetchByEntityIds: fetchAttachments,
    getSignedUrl,
    uploadPhoto,
    removeAttachment,
  } = useAttachmentStore()
  const attachmentsByEntity = useAttachmentStore((s) => s.byEntity)
  const tilesets = useMemo(
    () => (currentFarm ? byFarm.get(currentFarm.id) ?? [] : []),
    [byFarm, currentFarm],
  )

  // プロジェクトの座標系
  const projectZone = currentFarm
    ? projects.find((p) => p.id === currentFarm.project_id)?.coordinate_zone ?? null
    : null

  // 工区切替時にオルソ・座標・区域・メンバー・点種・メモ・写真をまとめて読み込み
  useEffect(() => {
    if (!currentFarm) return
    fetchByFarm(currentFarm.id)
    fetchWorkAreas(currentFarm.id)
    if (projectZone !== null) {
      setZone(projectZone)
      fetchCoordinates(currentFarm.id)
    }
    void fetchFarmMemos(currentFarm.id)
    void fetchAttachments('farm_photo', [currentFarm.id])
  }, [
    currentFarm,
    projectZone,
    fetchByFarm,
    fetchWorkAreas,
    setZone,
    fetchCoordinates,
    fetchFarmMemos,
    fetchAttachments,
  ])

  // 地図用メモ（位置がある分のみ）
  const memosForMap = useMemo(
    () =>
      farmMemos
        .filter((m) => m.lat != null && m.lng != null)
        .map((m) => ({
          id: m.id,
          content: m.content,
          lat: m.lat as number,
          lng: m.lng as number,
        })),
    [farmMemos],
  )

  // 地図 + サムネパネル用の写真リスト（位置あり）
  const farmPhotosForMap = useMemo(() => {
    if (!currentFarm)
      return [] as Array<{
        id: string
        lat: number
        lng: number
        headingDeg: number | null
        filePath: string
        caption: string | null
      }>
    const list = attachmentsByEntity.get(`farm_photo:${currentFarm.id}`) ?? []
    return list
      .filter((a) => a.lat != null && a.lng != null)
      .map((a) => ({
        id: a.id,
        lat: a.lat as number,
        lng: a.lng as number,
        headingDeg: a.headingDeg,
        filePath: a.filePath,
        caption: a.caption,
      }))
  }, [currentFarm, attachmentsByEntity])

  // 工区写真の全件（位置の有無に関わらずサムネ一覧で見せる）
  const farmPhotosAll = useMemo(() => {
    if (!currentFarm) return []
    return attachmentsByEntity.get(`farm_photo:${currentFarm.id}`) ?? []
  }, [currentFarm, attachmentsByEntity])

  // 右側パネルの折りたたみ状態
  const [panelOpen, setPanelOpen] = useState(true)

  // 工区写真の編集: マップマーカー / パネルの 編集ボタンから呼ぶ
  const [editingFarmPhoto, setEditingFarmPhoto] = useState<{
    file: File
    oldAttachmentId: string
    initialLat: number | null
    initialLng: number | null
    initialHeadingDeg: number | null
    initialCaption: string | null
    initialTakenAt: Date | null
    initialTitle: string | null
  } | null>(null)
  // 写真タイトルの候補 (既定 + 最近使用したもの) — モバイル側と同じ仕組み
  const PHOTO_TITLE_DEFAULTS = ['全景', '道路', '建物', '水路'] as const
  const [photoTitleRecents, setPhotoTitleRecents] = useState<string[]>(() => {
    try {
      const s = localStorage.getItem('orthophoto:photo:recentTitles')
      const arr = s ? JSON.parse(s) : null
      if (Array.isArray(arr)) return arr.filter((x) => typeof x === 'string')
    } catch { /* ignore */ }
    return []
  })
  const photoTitleSuggestions = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const s of [...PHOTO_TITLE_DEFAULTS, ...photoTitleRecents]) {
      const t = s.trim()
      if (!t || seen.has(t)) continue
      seen.add(t)
      out.push(t)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoTitleRecents])
  const pushPhotoTitleRecent = (prefix: string) => {
    const p = prefix.trim()
    if (!p) return
    setPhotoTitleRecents((prev) => {
      const next = [p, ...prev.filter((x) => x !== p)].slice(0, 8)
      try { localStorage.setItem('orthophoto:photo:recentTitles', JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }
  // 既存の工区写真タイトル一覧 (自動採番用)
  const existingFarmPhotoTitles = useMemo(() => {
    if (!currentFarm) return [] as string[]
    const list = attachmentsByEntity.get(`farm_photo:${currentFarm.id}`) ?? []
    return list.map((a) => a.category ?? '').filter((s) => s && s !== '現場')
  }, [currentFarm, attachmentsByEntity])
  // マーカー popup または パネル から呼ぶ 編集ハンドラ:
  // Storage から実体を DL → File 化 → PhotoEditModal を開く。
  const handleFarmPhotoEdit = async (photoId: string) => {
    if (!currentFarm) return
    const list = attachmentsByEntity.get(`farm_photo:${currentFarm.id}`) ?? []
    const meta = list.find((a) => a.id === photoId)
    if (!meta) return
    try {
      const url = await getSignedUrl(meta.filePath)
      if (!url) {
        alert('写真のダウンロードに失敗しました')
        return
      }
      const res = await fetch(url)
      const blob = await res.blob()
      const name = meta.filePath.split('/').pop() || 'photo.jpg'
      const orgFile = new File([blob], name, { type: blob.type || 'image/jpeg' })
      setEditingFarmPhoto({
        file: orgFile,
        oldAttachmentId: meta.id,
        initialLat: meta.lat,
        initialLng: meta.lng,
        initialHeadingDeg: meta.headingDeg,
        initialCaption: meta.caption,
        initialTakenAt: meta.takenAt ? new Date(meta.takenAt) : null,
        // タイトルは category に格納。旧値 '現場' はスキップ
        initialTitle: meta.category && meta.category !== '現場' ? meta.category : null,
      })
    } catch (err) {
      console.error('[orthophoto farm_photo edit] failed', err)
      alert('写真の読み込みに失敗しました')
    }
  }

  const handleFarmPhotoDelete = async (photoId: string) => {
    if (!confirm('この写真を削除しますか?')) return
    try {
      await removeAttachment(photoId)
    } catch (err) {
      console.error('[orthophoto farm_photo delete] failed', err)
      alert('写真の削除に失敗しました')
    }
  }


  // 表示設定 (点種 / 地番 / カメラ / メモ / 作図要素の表示切替)。localStorage 永続化
  const readVis = (key: string, def: boolean): boolean => {
    try {
      const v = localStorage.getItem(`orthophoto:vis:${key}`)
      if (v === '0') return false
      if (v === '1') return true
    } catch { /* ignore */ }
    return def
  }
  const writeVis = (key: string, v: boolean) => {
    try { localStorage.setItem(`orthophoto:vis:${key}`, v ? '1' : '0') } catch { /* ignore */ }
  }
  // 法務省地図 (地番) の背景表示。全ページ共通 (useMapViewStore)
  const showParcelMap = useMapViewStore((s) => s.showParcelMap)
  const setShowParcelMap = useMapViewStore((s) => s.setShowParcelMap)
  const parcelDatasets = useParcelMapDatasetStore((s) => s.datasets)
  const fetchParcelDatasets = useParcelMapDatasetStore((s) => s.fetchAll)
  const hasActiveParcelDataset = parcelDatasets.some((d) => d.active)
  useEffect(() => {
    void fetchParcelDatasets()
  }, [fetchParcelDatasets])
  // 一括取込 (共通フック)。法務省地図 OFF で自動リセット
  const parcelSelection = useParcelImportSelection({ resetTrigger: showParcelMap })
  const {
    selectionMode,
    selectedKeys,
    toggleSelect: toggleSelectedParcel,
    message: parcelImportMessage,
  } = parcelSelection
  useEffect(() => {
    if (parcelImportMessage) setMessage(parcelImportMessage)
  }, [parcelImportMessage])

  const [showPointsLayer, setShowPointsLayer] = useState<boolean>(() => readVis('points', true))
  const [showParcelsLayer, setShowParcelsLayer] = useState<boolean>(() => readVis('parcels', true))
  const [showCamerasLayer, setShowCamerasLayer] = useState<boolean>(() => readVis('cameras', true))
  const [showMemosLayer, setShowMemosLayer] = useState<boolean>(() => readVis('memos', true))
  const [showAnnotationsLayer, setShowAnnotationsLayer] = useState<boolean>(() => readVis('annotations', true))
  const [showPipesLayer, setShowPipesLayer] = useState<boolean>(() => readVis('pipes', true))

  // ペイント描画: 起動 / モード / 色 / 太さ
  const [showDrawing, setShowDrawing] = useState(false)
  const [drawingMode, setDrawingMode] = useState<DrawingMode>('off')
  const [drawingColor, setDrawingColor] = useState('#ef4444')
  const [drawingWidth, setDrawingWidth] = useState(3)
  const [drawingLineStyle, setDrawingLineStyle] = useState<LineStyle>('solid')
  useEffect(() => {
    if (!showDrawing) setDrawingMode('off')
  }, [showDrawing])
  const drawingItems = useMapDrawingStore((s) =>
    currentFarm ? s.byFarm.get(currentFarm.id) ?? EMPTY_STROKES : EMPTY_STROKES,
  )
  const drawingUndoLen = useMapDrawingStore((s) => s.undoStack.length)
  const drawingRedoLen = useMapDrawingStore((s) => s.redoStack.length)
  const drawingUndo = useMapDrawingStore((s) => s.undo)
  const drawingRedo = useMapDrawingStore((s) => s.redo)
  useEffect(() => writeVis('points', showPointsLayer), [showPointsLayer])
  useEffect(() => writeVis('parcels', showParcelsLayer), [showParcelsLayer])
  useEffect(() => writeVis('cameras', showCamerasLayer), [showCamerasLayer])
  useEffect(() => writeVis('memos', showMemosLayer), [showMemosLayer])
  useEffect(() => writeVis('annotations', showAnnotationsLayer), [showAnnotationsLayer])
  useEffect(() => writeVis('pipes', showPipesLayer), [showPipesLayer])

  // 暗渠 (pipes) を読み取り専用オーバーレイとして表示
  const fetchPipes = useUnderdrainStore((s) => s.fetchPipes)
  const pipes = useUnderdrainStore((s) => s.pipes)
  useEffect(() => {
    if (currentFarm) void fetchPipes(currentFarm.id)
  }, [currentFarm, fetchPipes])
  const pipeOverlay = useMemo(() => {
    if (projectZone == null) {
      return {
        lines: [] as Array<{ id: string; positions: [number, number][] }>,
        vertices: [] as Array<{ key: string; lat: number; lng: number; label: string }>,
      }
    }
    const conv = new CoordinateConverter(projectZone)
    const lines: Array<{ id: string; positions: [number, number][] }> = []
    const vertices: Array<{ key: string; lat: number; lng: number; label: string }> = []
    for (const pipe of pipes as PipeRow[]) {
      if (pipe.vertices.length === 0) continue
      const positions: [number, number][] = []
      const total = pipe.vertices.length
      for (let i = 0; i < total; i++) {
        const v = pipe.vertices[i]
        try {
          const { lat, lng } = conv.toLatLng(v.x, v.y)
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
          positions.push([lat, lng])
          let suffix: string
          if (i === 0) suffix = 'C'
          else if (i === total - 1) suffix = 'A'
          else suffix = `B${total - 1 - i}`
          vertices.push({
            key: `pv-${pipe.id}-${i}`,
            lat,
            lng,
            label: `${pipe.number}${suffix}`,
          })
        } catch {
          /* skip */
        }
      }
      if (positions.length >= 2) {
        lines.push({ id: pipe.id, positions })
      }
    }
    return { lines, vertices }
  }, [pipes, projectZone])

  // 表示設定パネルの開閉 (ヘッダの「表示」ボタンから)
  const [showVisMenu, setShowVisMenu] = useState(false)
  const visMenuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!showVisMenu) return
    const onClick = (e: MouseEvent) => {
      if (visMenuRef.current && !visMenuRef.current.contains(e.target as Node)) {
        setShowVisMenu(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [showVisMenu])

  // displayCoordinateIds が Set/undefined の切替で参照が変わらないように memo 化
  const emptyCoordSet = useMemo(() => new Set<string>(), [])

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
  // ---- ペイント (作図・計測) の設定 ----
  // 作図・計測ツールはペイントへ統合したので、状態はペイント側の設定だけを持つ
  const [snapEnabled, setSnapEnabled] = useState(false)
  const [drawLayer, setDrawLayer] = useState('0')
  const [drawFontSize, setDrawFontSize] = useState(14)
  const [registerCoordinate, setRegisterCoordinate] = useState(false)

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

  // 既存レイヤ名の一覧（レイヤ名入力の候補）
  const existingLayers = useMemo(() => {
    const set = new Set<string>(['0'])
    for (const d of drawingItems) if (d.layer) set.add(d.layer)
    return Array.from(set).sort()
  }, [drawingItems])

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

  // DXF 出力。作図・計測をペイントへ統合したので、出力元もペイント (map_drawings)。
  const handleDxfExport = () => {
    if (drawingItems.length === 0) {
      alert('出力するペイントがありません')
      return
    }
    const entities = buildMapDrawingDxfEntities(drawingItems, converter)
    if (entities.length === 0) {
      alert('出力できる図形がありません')
      return
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
        <PageHeader title="全体図" subtitle="オルソ・座標・区域・メモ・写真を集約した工区全体ビュー" />
        <div className="flex-1 flex items-center justify-center text-sm text-slate-500">
          工区を選択してください
        </div>
      </div>
    )
  }

  const headerActions = (
    <div className="flex items-center gap-2">
      {/* 表示設定 (点種 / 地番 / カメラ / メモ / 作図要素) */}
      <div className="relative" ref={visMenuRef}>
        <button
          onClick={() => setShowVisMenu((v) => !v)}
          className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
          title="地図上に表示するレイヤを切替"
        >
          <Eye className="h-4 w-4" />
          表示
        </button>
        {showVisMenu && (
          <div className="absolute right-0 mt-1 z-[2000] bg-white border rounded-lg shadow-lg p-2 w-52 text-sm">
            <div className="text-[11px] text-slate-500 mb-1 px-1">表示するレイヤ</div>
            {(
              [
                { key: 'points', label: '点種 (座標マーカー)', on: showPointsLayer, set: setShowPointsLayer },
                { key: 'parcels', label: '地番 (区域ポリゴン)', on: showParcelsLayer, set: setShowParcelsLayer },
                { key: 'pipes', label: '暗渠配線', on: showPipesLayer, set: setShowPipesLayer },
                { key: 'cameras', label: 'カメラ (工区写真)', on: showCamerasLayer, set: setShowCamerasLayer },
                { key: 'memos', label: 'メモ', on: showMemosLayer, set: setShowMemosLayer },
                { key: 'annotations', label: 'ペイント', on: showAnnotationsLayer, set: setShowAnnotationsLayer },
              ] as const
            ).map((row) => (
              <label
                key={row.key}
                className="flex items-center gap-2 px-1 py-1 rounded hover:bg-slate-50 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={row.on}
                  onChange={(e) => row.set(e.target.checked)}
                />
                <span className="text-xs">{row.label}</span>
              </label>
            ))}
          </div>
        )}
      </div>
      <button
        onClick={handleDxfExport}
        disabled={drawingItems.length === 0}
        className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
        title="ペイントをDXFで出力"
      >
        <FileDown className="h-4 w-4" />
        DXF出力
        {drawingItems.length > 0 && <span className="ml-1 text-xs text-blue-600">({drawingItems.length})</span>}
      </button>
      <button
        onClick={() => setShowDrawing((v) => !v)}
        className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded ${
          showDrawing
            ? 'bg-blue-600 text-white border-blue-600'
            : 'hover:bg-slate-50'
        }`}
        title="地図に手書きペイント (ペン / 消しゴム / 色 / 太さ)"
      >
        <Paintbrush className="h-4 w-4" />
        ペイント
        {drawingItems.length > 0 && (
          <span className={`ml-1 text-xs ${showDrawing ? 'text-white/80' : 'text-blue-600'}`}>
            ({drawingItems.length})
          </span>
        )}
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
      <PageHeader title="全体図" subtitle="オルソ・座標・区域・メモ・写真を集約した工区全体ビュー" actions={headerActions} />

      {/* 横並び: 左=大きな地図（オルソ＋座標＋区域＋作図＋メモ＋写真）、右=折りたたみパネル */}
      <div className="flex-1 flex min-h-0 relative">
      <div className="flex-1 relative">
        {/* ペイント描画ツールバー: 起動中のみ表示。地図上部中央にフローティング */}
        {showDrawing && currentFarm?.id && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[1250]">
            <MapDrawingToolbar
              mode={drawingMode}
              onChangeMode={setDrawingMode}
              color={drawingColor}
              onChangeColor={setDrawingColor}
              widthPx={drawingWidth}
              onChangeWidth={setDrawingWidth}
              lineStyle={drawingLineStyle}
              onChangeLineStyle={setDrawingLineStyle}
              canUndo={drawingUndoLen > 0}
              canRedo={drawingRedoLen > 0}
              onUndo={() => void drawingUndo()}
              onRedo={() => void drawingRedo()}
              snapEnabled={snapEnabled}
              onToggleSnap={() => setSnapEnabled((v) => !v)}
              layer={drawLayer}
              onChangeLayer={setDrawLayer}
              existingLayers={existingLayers}
              fontSize={drawFontSize}
              onChangeFontSize={setDrawFontSize}
              registerCoordinate={registerCoordinate}
              onToggleRegisterCoordinate={() => setRegisterCoordinate((v) => !v)}
            />
          </div>
        )}
        <CoordinateMap
          key={currentFarm.id}
          farmId={currentFarm.id}
          showOrtho
          externalPolygons={showParcelsLayer ? workAreaPolygons : []}
          coordinatesInteractive={false}
          farmMemos={showMemosLayer ? memosForMap : []}
          farmPhotos={showCamerasLayer ? farmPhotosForMap : []}
          photoGetSignedUrl={getSignedUrl}
          onPhotoEdit={handleFarmPhotoEdit}
          onPhotoDelete={handleFarmPhotoDelete}
          // 点種を非表示: 空 Set を渡して全マーカーを除外
          displayCoordinateIds={showPointsLayer ? undefined : emptyCoordSet}
        >
          {/* 作図要素を非表示にしても計測ツールは使えるように、コンポーネントは常時マウントし
              既存の作図要素の描画だけを hideDrawn で切り替える */}
          {/* 法務省地図 (地番) の背景レイヤ。表示 + 選択モードは useMapViewStore /
              useParcelImportSelection で他ページと共通挙動 */}
          {hasActiveParcelDataset && showParcelMap && (
            <ParcelMapLayer
              visible={true}
              bbox={null}
              selectedKeys={selectedKeys}
              onToggleSelect={toggleSelectedParcel}
              selectionMode={selectionMode}
              disableClicks={showDrawing && drawingMode !== 'off'}
            />
          )}
          {/* 描画レイヤ: showDrawing OFF でも既存ストロークは表示。ON でペン/消しゴム有効 */}
          <MapDrawingLayer
            farmId={currentFarm.id}
            mode={showDrawing ? drawingMode : 'off'}
            color={drawingColor}
            widthPx={drawingWidth}
            lineStyle={drawingLineStyle}
            converter={converter}
            layer={drawLayer}
            fontSize={drawFontSize}
            snapEnabled={snapEnabled}
            extraSnapPoints={extraSnapPoints}
            onAddCoordinate={handleAddCoordinate}
            registerCoordinate={registerCoordinate}
            hidden={!showAnnotationsLayer}
          />
          {/* 暗渠 (読み取り専用オーバーレイ)。編集は暗渠モジュールで。 */}
          {showPipesLayer &&
            pipeOverlay.lines.map((line) => (
              <LeafletPolyline
                key={`pipe-${line.id}`}
                positions={line.positions}
                pathOptions={{
                  color: '#0891b2',
                  weight: 2,
                  opacity: 0.7,
                  dashArray: '4 4',
                }}
              />
            ))}
          {showPipesLayer &&
            pipeOverlay.vertices.map((v) => (
              <CircleMarker
                key={v.key}
                center={[v.lat, v.lng]}
                radius={3}
                pathOptions={{
                  color: '#0e7490',
                  fillColor: '#67e8f9',
                  fillOpacity: 0.9,
                  weight: 1,
                }}
              >
                <Tooltip direction="top" offset={[0, -4]} opacity={0.9}>
                  <span className="text-[10px] font-mono">{v.label}</span>
                </Tooltip>
              </CircleMarker>
            ))}
        </CoordinateMap>

        {/* 法務省地図トグル + 一括取込ボタン (左下、Leaflet attribution の対角) */}
        {hasActiveParcelDataset && (
          <div className="absolute bottom-6 left-2 z-[1000] flex flex-col items-start gap-2">
            {showParcelMap && (
              <ParcelBatchImportBar
                farmId={currentFarm.id}
                zone={projectZone}
                selection={parcelSelection}
              />
            )}
            <button
              onClick={() => setShowParcelMap(!showParcelMap)}
              className={`flex items-center gap-1 px-3 py-1.5 text-sm rounded border shadow ${
                showParcelMap
                  ? 'bg-orange-500 text-white border-orange-500 hover:bg-orange-600'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
              title="法務省地図データを背景に表示する"
            >
              <MapIcon className="h-4 w-4" />
              法務省地図
            </button>
          </div>
        )}

        {/* ツールヘルプ＋計測結果（左下） */}
      </div>

      {/* 右側パネル: 上半分にメモ一覧、下半分に写真サムネ。折りたたみ可能。 */}
      <OverviewSidePanel
        open={panelOpen}
        onToggle={() => setPanelOpen((v) => !v)}
        memos={farmMemos}
        photos={farmPhotosAll}
        getSignedUrl={getSignedUrl}
        onEditPhoto={handleFarmPhotoEdit}
        onDeletePhoto={handleFarmPhotoDelete}
        farmName={currentFarm.name}
      />
      </div>{/* /flex-1 flex */}

      {/* 工区写真の編集モーダル */}
      {editingFarmPhoto && currentFarm && (
        <PhotoEditModal
          file={editingFarmPhoto.file}
          enableLocationEdit
          initialLat={editingFarmPhoto.initialLat}
          initialLng={editingFarmPhoto.initialLng}
          initialHeadingDeg={editingFarmPhoto.initialHeadingDeg}
          initialCaption={editingFarmPhoto.initialCaption}
          initialTakenAt={editingFarmPhoto.initialTakenAt}
          initialTitle={editingFarmPhoto.initialTitle}
          titleSuggestions={photoTitleSuggestions}
          existingTitles={existingFarmPhotoTitles}
          onUseTitlePrefix={pushPhotoTitleRecent}
          onCancel={() => setEditingFarmPhoto(null)}
          onConfirm={async (blob, _name, meta) => {
            const projectId = currentFarm.project_id
            if (!projectId) return
            const oldId = editingFarmPhoto.oldAttachmentId
            const r = await uploadPhoto({
              projectId,
              entityType: 'farm_photo',
              entityId: currentFarm.id,
              file: blob,
              // タイトル (例: '全景-3') を category に保存。未指定なら旧値を維持
              category: meta.title ?? editingFarmPhoto.initialTitle ?? '現場',
              caption: meta.caption,
              takenAt: meta.takenAt ?? new Date(),
              lat: meta.lat,
              lng: meta.lng,
              headingDeg: meta.headingDeg,
              skipResize: true,
            })
            if (r) {
              try {
                await removeAttachment(oldId)
              } catch (err) {
                console.warn('[orthophoto farm_photo edit] remove old failed', err)
              }
              setEditingFarmPhoto((prev) =>
                prev ? { ...prev, oldAttachmentId: r.id } : null,
              )
              void fetchAttachments('farm_photo', [currentFarm.id])
            } else {
              alert('写真の更新に失敗しました')
            }
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
// 全体図の右パネル（メモ一覧 + 写真サムネ。折りたたみ可）
// =============================================
function OverviewSidePanel({
  open,
  onToggle,
  memos,
  photos,
  getSignedUrl,
  onEditPhoto,
  onDeletePhoto,
  farmName,
}: {
  open: boolean
  onToggle: () => void
  memos: FarmMemo[]
  photos: Attachment[]
  getSignedUrl: (filePath: string) => Promise<string | null>
  onEditPhoto: (photoId: string) => void
  onDeletePhoto: (photoId: string) => void
  farmName: string
}) {
  // ダウンロード / 写真帳出力: それぞれ選択モーダルを開く
  const [downloadOpen, setDownloadOpen] = useState(false)
  const [photoBookOpen, setPhotoBookOpen] = useState(false)
  // 写真セクションだけを大きく表示するモード (メモ一覧を折りたたみ、パネルを広げる)
  const [photoMaximized, setPhotoMaximized] = useState(false)
  // 拡大モードのサムネサイズ (0=最小 ... 3=最大)。cols は minmax(px, 1fr) の px 値
  const PHOTO_SIZE_STEPS = [90, 130, 180, 240] as const
  const [photoSizeStep, setPhotoSizeStep] = useState(0)
  if (!open) {
    return (
      <div className="w-9 border-l bg-slate-50 flex flex-col items-center pt-2">
        <button
          onClick={onToggle}
          className="p-1.5 text-slate-500 hover:bg-slate-200 rounded"
          title="パネルを開く"
        >
          <PanelRightOpen className="h-5 w-5" />
        </button>
        <div className="mt-3 text-[10px] text-slate-400 [writing-mode:vertical-rl]">
          メモ {memos.length} / 写真 {photos.length}
        </div>
      </div>
    )
  }
  return (
    <div
      className={
        photoMaximized
          ? // 全画面表示: 親 (flex-1 flex min-h-0 relative) の全域を占有し、地図領域まで覆う
            'absolute inset-0 z-[1200] border-l bg-white flex flex-col min-h-0'
          : 'w-80 border-l bg-white flex flex-col min-h-0'
      }
    >
      <div className="px-3 py-2 border-b flex items-center gap-2 bg-slate-50">
        <span className="text-sm font-semibold flex-1">メモ / 写真</span>
        <button
          onClick={onToggle}
          className="p-1 text-slate-500 hover:bg-slate-200 rounded"
          title="パネルを閉じる"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

      {/* 上半分: メモ一覧 (photo maximized 時は完全に隠す) */}
      <div
        className={`${
          photoMaximized ? 'hidden' : 'flex-1'
        } min-h-0 flex flex-col border-b`}
      >
        <div className="px-3 py-1.5 text-[11px] text-slate-500 flex items-center gap-1 bg-slate-50">
          <StickyNote className="h-3 w-3 text-amber-500" />
          メモ ({memos.length})
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
          {memos.length === 0 ? (
            <div className="text-center text-xs text-slate-400 py-4">
              メモはまだありません
            </div>
          ) : (
            memos.map((m) => (
              <div
                key={m.id}
                className="text-xs p-2 border rounded bg-amber-50/40 hover:bg-amber-50 cursor-default"
              >
                <div className="whitespace-pre-wrap break-words text-slate-800 line-clamp-3">
                  {m.content || <span className="text-slate-400">(本文なし)</span>}
                </div>
                <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-500 flex-wrap">
                  <span>{new Date(m.createdAt).toLocaleString('ja-JP')}</span>
                  {m.lat != null && m.lng != null && (
                    <span className="inline-flex items-center gap-0.5">
                      <MapPin className="h-2.5 w-2.5" />
                      {m.lat.toFixed(5)}, {m.lng.toFixed(5)}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 下半分: 写真サムネ。ダウンロード / Excel 出力は各ボタンで選択モーダルへ */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="px-3 py-1.5 text-[11px] text-slate-500 flex items-center gap-1 bg-slate-50">
          <ImageIcon className="h-3 w-3 text-blue-500" />
          写真 ({photos.length})
          {photoMaximized && (
            <div className="ml-2 flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => setPhotoSizeStep((n) => Math.max(0, n - 1))}
                disabled={photoSizeStep === 0}
                className="p-0.5 rounded hover:bg-slate-200 text-slate-500 disabled:opacity-30"
                title="小さく"
              >
                <ZoomOut className="h-3.5 w-3.5" />
              </button>
              <span className="text-[10px] text-slate-400 tabular-nums w-6 text-center">
                {photoSizeStep + 1}/{PHOTO_SIZE_STEPS.length}
              </span>
              <button
                type="button"
                onClick={() =>
                  setPhotoSizeStep((n) =>
                    Math.min(PHOTO_SIZE_STEPS.length - 1, n + 1),
                  )
                }
                disabled={photoSizeStep === PHOTO_SIZE_STEPS.length - 1}
                className="p-0.5 rounded hover:bg-slate-200 text-slate-500 disabled:opacity-30"
                title="大きく"
              >
                <ZoomIn className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={() => setPhotoMaximized((v) => !v)}
            className="ml-auto p-0.5 rounded hover:bg-slate-200 text-slate-500"
            title={photoMaximized ? '写真表示を通常サイズに戻す' : '写真表示を大きくする'}
          >
            {photoMaximized ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
        <div className="px-2 py-1.5 border-b bg-white flex items-center gap-1 flex-wrap">
          <button
            type="button"
            onClick={() => setDownloadOpen(true)}
            disabled={photos.length === 0}
            className="text-[11px] px-1.5 py-0.5 border rounded text-blue-700 border-blue-300 hover:bg-blue-50 disabled:opacity-40 inline-flex items-center gap-0.5"
            title="ダウンロード: 対象の写真を選択して ZIP 保存"
          >
            <FileDown className="h-3 w-3" />
            ダウンロード
          </button>
          <button
            type="button"
            onClick={() => setPhotoBookOpen(true)}
            disabled={photos.length === 0}
            className="text-[11px] px-1.5 py-0.5 border rounded text-emerald-700 border-emerald-300 hover:bg-emerald-50 disabled:opacity-40 inline-flex items-center gap-0.5"
            title="写真帳: 出力する写真と順番を選ぶ"
          >
            <FileDown className="h-3 w-3" />
            Excel 写真帳
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {photos.length === 0 ? (
            <div className="text-center text-xs text-slate-400 py-4">
              写真はまだありません
            </div>
          ) : (
            <div
              className={photoMaximized ? 'grid gap-1.5' : 'grid gap-1.5 grid-cols-2'}
              style={
                photoMaximized
                  ? {
                      gridTemplateColumns: `repeat(auto-fill, minmax(${PHOTO_SIZE_STEPS[photoSizeStep]}px, 1fr))`,
                    }
                  : undefined
              }
            >
              {photos.map((p) => (
                <PanelPhotoThumb
                  key={p.id}
                  attachment={p}
                  getSignedUrl={getSignedUrl}
                  onEdit={() => onEditPhoto(p.id)}
                  onDelete={() => onDeletePhoto(p.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {downloadOpen && (
        <PhotoDownloadSelectorModal
          photos={photos}
          getSignedUrl={getSignedUrl}
          farmName={farmName}
          onClose={() => setDownloadOpen(false)}
        />
      )}
      {photoBookOpen && (
        <PhotoBookOrderModal
          photos={photos}
          getSignedUrl={getSignedUrl}
          farmName={farmName}
          onClose={() => setPhotoBookOpen(false)}
        />
      )}
    </div>
  )
}

function PanelPhotoThumb({
  attachment,
  getSignedUrl,
  onEdit,
  onDelete,
}: {
  attachment: Attachment
  getSignedUrl: (filePath: string) => Promise<string | null>
  onEdit: () => void
  onDelete: () => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let cancelled = false
    void getSignedUrl(attachment.filePath).then((u) => {
      if (cancelled) return
      if (u) setUrl(u)
      else setError(true)
    })
    return () => {
      cancelled = true
    }
  }, [attachment.filePath, getSignedUrl])
  // タイトル (旧: category に保存している。旧値 '現場' は表示しない)
  const title = attachment.category && attachment.category !== '現場' ? attachment.category : ''
  const memo = attachment.caption ?? ''
  return (
    <div
      className="group border rounded overflow-hidden bg-white hover:ring-2 hover:ring-blue-300 flex flex-col"
      title={memo || title || attachment.filePath.split('/').pop() || ''}
    >
      {/* サムネ (クリックで別窓プレビュー) */}
      <a
        href={url ?? undefined}
        target="_blank"
        rel="noreferrer"
        className="block aspect-square relative bg-slate-100"
        onClick={(e) => {
          if (!url) e.preventDefault()
        }}
      >
        {error ? (
          <div className="w-full h-full flex items-center justify-center text-[10px] text-slate-400">
            読み込み失敗
          </div>
        ) : url ? (
          <img src={url} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
          </div>
        )}

        {/* 右上: 編集 / 削除 (ホバー時のみ) */}
        <div className="absolute top-1 right-1 hidden group-hover:flex gap-1 z-10">
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onEdit()
            }}
            className="p-1 bg-white/95 text-blue-700 rounded shadow hover:bg-white"
            title="編集 (位置・向き・メモ・トリミング)"
          >
            <Edit3 className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onDelete()
            }}
            className="p-1 bg-white/95 text-red-600 rounded shadow hover:bg-white"
            title="削除"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </a>

      {/* サムネ下部: タイトル + メモ */}
      <div className="px-1.5 py-1 text-[11px] leading-tight border-t bg-white">
        {title && (
          <div className="font-semibold text-slate-800 truncate" title={title}>
            {title}
          </div>
        )}
        <div
          className={`${
            memo ? 'text-slate-600' : 'text-slate-300'
          } line-clamp-2 break-words`}
          title={memo}
        >
          {memo || '(メモなし)'}
        </div>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------
// 選択された工区写真を ZIP で一括ダウンロード
// -----------------------------------------------------------------
async function downloadPhotosZip(
  photos: Attachment[],
  getSignedUrl: (filePath: string) => Promise<string | null>,
  farmName: string,
): Promise<void> {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  const usedNames = new Set<string>()
  const buildName = (a: Attachment): string => {
    const base = a.caption?.trim() || a.category?.trim() || a.filePath.split('/').pop() || 'photo'
    const stem = base.replace(/\.[a-zA-Z0-9]+$/, '')
    let name = `${stem}.jpg`
    let i = 2
    while (usedNames.has(name)) name = `${stem} (${i++}).jpg`
    usedNames.add(name)
    return name
  }
  for (const a of photos) {
    try {
      const url = await getSignedUrl(a.filePath)
      if (!url) continue
      const res = await fetch(url)
      const blob = await res.blob()
      zip.file(buildName(a), blob)
    } catch (err) {
      console.warn('[downloadPhotosZip] skipped', a.id, err)
    }
  }
  const zipBlob = await zip.generateAsync({ type: 'blob' })
  const now = new Date()
  const yyyymmdd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  triggerDownload(zipBlob, `${sanitizeFilename(farmName)}_photos_${yyyymmdd}.zip`)
}

// -----------------------------------------------------------------
// 選択された工区写真を Excel 写真帳 (.xlsx) で出力
//   2 列 × 3 段 = 1 ページ 6 枚のレイアウト。7 枚目からは自動改ページ。
//   1 枚あたり: 画像 (上段) + タイトル / 撮影日 / 位置 / メモ (下段)
// -----------------------------------------------------------------
async function downloadPhotosExcel(
  photos: Attachment[],
  getSignedUrl: (filePath: string) => Promise<string | null>,
  farmName: string,
): Promise<void> {
  const { default: ExcelJS } = await import('exceljs')
  const wb = new ExcelJS.Workbook()
  wb.creator = 'NodeCloud'
  const ws = wb.addWorksheet('写真帳', {
    pageSetup: {
      paperSize: 9, // A4
      orientation: 'portrait',
      horizontalCentered: true,
      margins: {
        left: 0.5, right: 0.5, top: 0.5, bottom: 0.5,
        header: 0.3, footer: 0.3,
      },
    },
  })

  // 2 列レイアウト。列幅 (char) は 1 char ≒ 7 px 換算
  ws.columns = [
    { key: 'left', width: 42 },
    { key: 'right', width: 42 },
  ]

  const IMG_ROW_H = 150 // pt (~ 200 px)
  const META_ROW_H = 55 // pt (~ 73 px, 3 行程度の wrap 可)
  const IMG_W = 285
  const IMG_H = 195
  const ROWS_PER_PHOTO = 2 // 画像行 + メタ行

  const buildMeta = (a: Attachment): string => {
    const parts: string[] = []
    if (a.category) parts.push(a.category)
    if (a.takenAt) {
      const d = new Date(a.takenAt)
      if (!Number.isNaN(d.getTime())) {
        parts.push(
          `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`,
        )
      }
    }
    if (a.lat != null && a.lng != null) parts.push(`${a.lat.toFixed(5)}, ${a.lng.toFixed(5)}`)
    if (a.headingDeg != null) parts.push(`方位 ${a.headingDeg.toFixed(0)}°`)
    const header = parts.join(' / ')
    return a.caption ? `${header}\n${a.caption}` : header
  }

  for (let i = 0; i < photos.length; i++) {
    const a = photos[i]
    const pageIdx = Math.floor(i / 6)
    const idxInPage = i % 6 // 0..5
    const col = idxInPage % 2 // 0=A, 1=B
    const rowPair = Math.floor(idxInPage / 2) // 0, 1, 2
    // 1 ページ = 6 行 (2 rows per photo × 3 pairs)
    const imgRowIdx = pageIdx * 6 + rowPair * ROWS_PER_PHOTO + 1 // 1-indexed
    const metaRowIdx = imgRowIdx + 1

    ws.getRow(imgRowIdx).height = IMG_ROW_H
    ws.getRow(metaRowIdx).height = META_ROW_H

    // メタ書き込み
    const metaCell = ws.getCell(metaRowIdx, col + 1)
    metaCell.value = buildMeta(a)
    metaCell.alignment = { wrapText: true, vertical: 'top', horizontal: 'left' }
    metaCell.font = { size: 10 }
    metaCell.border = {
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    }
    // 画像行にも同色のボーダーを回してカード風に
    const imgCell = ws.getCell(imgRowIdx, col + 1)
    imgCell.border = {
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    }

    // 画像挿入
    try {
      const url = await getSignedUrl(a.filePath)
      if (!url) continue
      const res = await fetch(url)
      const buffer = await res.arrayBuffer()
      const imageId = wb.addImage({ buffer, extension: 'jpeg' })
      ws.addImage(imageId, {
        tl: { col: col + 0.05, row: imgRowIdx - 1 + 0.05 },
        ext: { width: IMG_W, height: IMG_H },
      })
    } catch (err) {
      console.warn('[downloadPhotosExcel] image insert failed', a.id, err)
    }

    // 各ページの最終メタ行の後に改ページ (最後のページは不要)
    const isLastInPage = idxInPage === 5
    const isLastPhoto = i === photos.length - 1
    if (isLastInPage && !isLastPhoto) {
      ws.getRow(metaRowIdx).addPageBreak()
    }
  }

  const out = await wb.xlsx.writeBuffer()
  const now = new Date()
  const yyyymmdd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const blob = new Blob([out], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  triggerDownload(blob, `${sanitizeFilename(farmName)}_photobook_${yyyymmdd}.xlsx`)
}

// -----------------------------------------------------------------
// 写真帳の 出力対象 + 順番 を決めるモーダル
//   全写真から順にクリックすると順番付きで選択、再度クリックで除外。
//   ↑ / ↓ ボタンで順番を入れ替えできる。
// -----------------------------------------------------------------
function PhotoBookOrderModal({
  photos,
  getSignedUrl,
  farmName,
  onClose,
}: {
  photos: Attachment[]
  getSignedUrl: (filePath: string) => Promise<string | null>
  farmName: string
  onClose: () => void
}) {
  const [orderIds, setOrderIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  // 全画面 (maximize) 表示 / 通常 (max-w-3xl) 表示のトグル
  const [maximized, setMaximized] = useState(false)

  const toggle = (id: string) => {
    setOrderIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }
  const move = (id: string, dir: -1 | 1) => {
    setOrderIds((prev) => {
      const idx = prev.indexOf(id)
      if (idx === -1) return prev
      const target = idx + dir
      if (target < 0 || target >= prev.length) return prev
      const next = prev.slice()
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return next
    })
  }

  const orderedPhotos = orderIds
    .map((id) => photos.find((p) => p.id === id))
    .filter((p): p is Attachment => !!p)

  const handleExport = async () => {
    if (orderedPhotos.length === 0) return
    setBusy(true)
    try {
      await downloadPhotosExcel(orderedPhotos, getSignedUrl, farmName)
      onClose()
    } catch (err) {
      console.error('[PhotoBookOrderModal] export failed', err)
      alert('写真帳の出力に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={`fixed inset-0 bg-black/50 flex items-center justify-center z-[3500] ${
        maximized ? 'p-0' : 'p-4'
      }`}
      onClick={onClose}
    >
      <div
        className={`bg-white shadow-xl flex flex-col ${
          maximized
            ? 'w-full h-full rounded-none max-w-none max-h-none'
            : 'w-full max-w-3xl max-h-[92vh] rounded-lg'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center gap-2 shrink-0">
          <span className="text-sm font-semibold flex-1">
            写真帳 (Excel) — 出力する写真と順番を選ぶ
          </span>
          <span className="text-xs text-slate-500">
            選択 {orderIds.length} / 全 {photos.length}
          </span>
          <button
            onClick={() => setMaximized((v) => !v)}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
            title={maximized ? '通常サイズに戻す' : '全画面表示'}
          >
            {maximized ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
            title="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden flex flex-col md:flex-row">
          {/* 左: 全写真グリッド (クリックで toggle) */}
          <div className="flex-1 min-h-0 overflow-y-auto p-3 border-b md:border-b-0 md:border-r">
            <div className="text-[11px] text-slate-500 mb-2">
              クリックで選択 / 解除
            </div>
            {photos.length === 0 ? (
              <div className="text-center text-xs text-slate-400 py-8">写真がありません</div>
            ) : (
              <div
                className={`grid gap-2 ${
                  maximized
                    ? 'grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10'
                    : 'grid-cols-3 sm:grid-cols-4'
                }`}
              >
                {photos.map((p) => {
                  const orderIdx = orderIds.indexOf(p.id)
                  return (
                    <PhotoBookThumb
                      key={p.id}
                      attachment={p}
                      getSignedUrl={getSignedUrl}
                      orderIndex={orderIdx === -1 ? null : orderIdx + 1}
                      onClick={() => toggle(p.id)}
                    />
                  )
                })}
              </div>
            )}
          </div>

          {/* 右: 選択リスト (↑↓ で順番を変更) */}
          <div
            className={`w-full shrink-0 overflow-y-auto p-3 bg-slate-50 ${
              maximized ? 'md:w-96' : 'md:w-64'
            }`}
          >
            <div className="text-[11px] text-slate-500 mb-2">出力順</div>
            {orderedPhotos.length === 0 ? (
              <div className="text-xs text-slate-400 py-4 text-center">
                左のサムネから選択してください
              </div>
            ) : (
              <ul className="space-y-1">
                {orderedPhotos.map((p, i) => (
                  <li
                    key={p.id}
                    className="flex items-center gap-1 bg-white border rounded px-1.5 py-1"
                  >
                    <span className="text-[11px] w-5 text-slate-500 tabular-nums text-right">
                      {i + 1}
                    </span>
                    <span
                      className="flex-1 min-w-0 text-xs truncate"
                      title={p.caption ?? p.category ?? p.filePath.split('/').pop() ?? ''}
                    >
                      {p.caption || p.category || p.filePath.split('/').pop() || '写真'}
                    </span>
                    <button
                      onClick={() => move(p.id, -1)}
                      disabled={i === 0}
                      className="p-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                      title="上へ"
                    >
                      ▲
                    </button>
                    <button
                      onClick={() => move(p.id, 1)}
                      disabled={i === orderedPhotos.length - 1}
                      className="p-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                      title="下へ"
                    >
                      ▼
                    </button>
                    <button
                      onClick={() => toggle(p.id)}
                      className="p-0.5 text-slate-400 hover:text-red-600"
                      title="外す"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="px-4 py-3 border-t flex items-center gap-2 shrink-0">
          <div className="text-[11px] text-slate-500">
            レイアウト: 2 列 × 3 段 (1 ページ 6 枚)
          </div>
          <div className="flex-1" />
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleExport}
            disabled={busy || orderedPhotos.length === 0}
            className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-1"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
            Excel 出力
          </button>
        </div>
      </div>
    </div>
  )
}

function PhotoBookThumb({
  attachment,
  getSignedUrl,
  orderIndex,
  onClick,
}: {
  attachment: Attachment
  getSignedUrl: (filePath: string) => Promise<string | null>
  orderIndex: number | null
  onClick: () => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void getSignedUrl(attachment.filePath).then((u) => {
      if (!cancelled) setUrl(u)
    })
    return () => {
      cancelled = true
    }
  }, [attachment.filePath, getSignedUrl])
  const selected = orderIndex != null
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative aspect-square border rounded overflow-hidden bg-slate-100 group ${
        selected
          ? 'ring-2 ring-emerald-500 border-emerald-500'
          : 'hover:ring-2 hover:ring-emerald-300'
      }`}
      title={attachment.caption ?? attachment.filePath.split('/').pop() ?? ''}
    >
      {url ? (
        <img src={url} alt="" className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
        </div>
      )}
      {selected && (
        <span className="absolute top-1 left-1 bg-emerald-600 text-white text-[11px] font-bold rounded-full w-6 h-6 flex items-center justify-center shadow">
          {orderIndex}
        </span>
      )}
    </button>
  )
}

// -----------------------------------------------------------------
// ダウンロード対象を選ぶモーダル (順番は不要 = ZIP 化)
// -----------------------------------------------------------------
function PhotoDownloadSelectorModal({
  photos,
  getSignedUrl,
  farmName,
  onClose,
}: {
  photos: Attachment[]
  getSignedUrl: (filePath: string) => Promise<string | null>
  farmName: string
  onClose: () => void
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const toggle = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const allSelected = photos.length > 0 && selectedIds.size === photos.length
  const toggleAll = () => {
    if (allSelected) setSelectedIds(new Set())
    else setSelectedIds(new Set(photos.map((p) => p.id)))
  }

  const handleDownload = async () => {
    const targets = photos.filter((p) => selectedIds.has(p.id))
    if (targets.length === 0) return
    setBusy(true)
    try {
      await downloadPhotosZip(targets, getSignedUrl, farmName)
      onClose()
    } catch (err) {
      console.error('[PhotoDownloadSelectorModal] failed', err)
      alert('ダウンロードに失敗しました')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[3500] p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center gap-2 shrink-0">
          <span className="text-sm font-semibold flex-1">
            写真ダウンロード — 対象を選択
          </span>
          <span className="text-xs text-slate-500">
            選択 {selectedIds.size} / 全 {photos.length}
          </span>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
            title="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-3 py-1.5 border-b bg-slate-50 flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={toggleAll}
            disabled={photos.length === 0}
            className="text-[11px] px-2 py-0.5 border rounded text-slate-600 hover:bg-white disabled:opacity-40"
          >
            {allSelected ? '選択解除' : '全選択'}
          </button>
          <span className="text-[11px] text-slate-500 ml-auto">
            クリックで選択 / 解除
          </span>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          {photos.length === 0 ? (
            <div className="text-center text-xs text-slate-400 py-8">
              写真がありません
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {photos.map((p) => (
                <DownloadThumb
                  key={p.id}
                  attachment={p}
                  getSignedUrl={getSignedUrl}
                  selected={selectedIds.has(p.id)}
                  onClick={() => toggle(p.id)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t flex items-center gap-2 shrink-0">
          <div className="text-[11px] text-slate-500">
            2 枚以上は ZIP でまとめます
          </div>
          <div className="flex-1" />
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleDownload}
            disabled={busy || selectedIds.size === 0}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
            ダウンロード
          </button>
        </div>
      </div>
    </div>
  )
}

function DownloadThumb({
  attachment,
  getSignedUrl,
  selected,
  onClick,
}: {
  attachment: Attachment
  getSignedUrl: (filePath: string) => Promise<string | null>
  selected: boolean
  onClick: () => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void getSignedUrl(attachment.filePath).then((u) => {
      if (!cancelled) setUrl(u)
    })
    return () => {
      cancelled = true
    }
  }, [attachment.filePath, getSignedUrl])
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative aspect-square border rounded overflow-hidden bg-slate-100 ${
        selected
          ? 'ring-2 ring-blue-500 border-blue-500'
          : 'hover:ring-2 hover:ring-blue-300'
      }`}
      title={attachment.caption ?? attachment.filePath.split('/').pop() ?? ''}
    >
      {url ? (
        <img src={url} alt="" className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
        </div>
      )}
      {selected && (
        <span className="absolute top-1 left-1 bg-blue-600 text-white rounded-full w-5 h-5 flex items-center justify-center shadow">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-3 w-3"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
      )}
    </button>
  )
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_')
}
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
