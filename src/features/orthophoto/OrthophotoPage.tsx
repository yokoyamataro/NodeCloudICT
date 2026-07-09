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
  PanelTopOpen,
  PanelTopClose,
  MapPin,
  Eye,
  Edit3,
} from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { useFarmStore } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useWorkAreaStore, type WorkAreaPoint } from '@/stores/workAreaStore'
import { useOrthophotoStore, tileBoundsLatLng } from '@/stores/orthophotoStore'
import { useFarmMemoStore, EMPTY_FARM_MEMOS, type FarmMemo } from '@/stores/farmMemoStore'
import { useAttachmentStore, type Attachment } from '@/stores/attachmentStore'
import { PhotoEditModal } from '@/features/coordinates/PhotoEditModal'
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
    if (currentFarm.project_id) {
      fetchMembers(currentFarm.project_id)
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
    fetchMembers,
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
  } | null>(null)
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

  // 上部の作図・計測ツールバーの折りたたみ状態 (localStorage 永続化)
  const [toolbarOpen, setToolbarOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('orthophoto:toolbarOpen') !== '0' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('orthophoto:toolbarOpen', toolbarOpen ? '1' : '0') } catch { /* ignore */ }
  }, [toolbarOpen])

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
  const [showPointsLayer, setShowPointsLayer] = useState<boolean>(() => readVis('points', true))
  const [showParcelsLayer, setShowParcelsLayer] = useState<boolean>(() => readVis('parcels', true))
  const [showCamerasLayer, setShowCamerasLayer] = useState<boolean>(() => readVis('cameras', true))
  const [showMemosLayer, setShowMemosLayer] = useState<boolean>(() => readVis('memos', true))
  const [showAnnotationsLayer, setShowAnnotationsLayer] = useState<boolean>(() => readVis('annotations', true))
  useEffect(() => writeVis('points', showPointsLayer), [showPointsLayer])
  useEffect(() => writeVis('parcels', showParcelsLayer), [showParcelsLayer])
  useEffect(() => writeVis('cameras', showCamerasLayer), [showCamerasLayer])
  useEffect(() => writeVis('memos', showMemosLayer), [showMemosLayer])
  useEffect(() => writeVis('annotations', showAnnotationsLayer), [showAnnotationsLayer])

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
                { key: 'cameras', label: 'カメラ (工区写真)', on: showCamerasLayer, set: setShowCamerasLayer },
                { key: 'memos', label: 'メモ', on: showMemosLayer, set: setShowMemosLayer },
                { key: 'annotations', label: '作図要素', on: showAnnotationsLayer, set: setShowAnnotationsLayer },
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
      <PageHeader title="全体図" subtitle="オルソ・座標・区域・メモ・写真を集約した工区全体ビュー" actions={headerActions} />

      {/* 上部の作図・計測ツールバー (折りたたみ可能) */}
      <div className="border-b bg-white">
        {toolbarOpen ? (
          <div className="px-2 py-2 flex flex-col gap-1">
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
                      active
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
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
              <button
                onClick={() => setToolbarOpen(false)}
                className="ml-auto p-1 rounded hover:bg-slate-100"
                title="ツールバーを折りたたむ"
              >
                <PanelTopClose className="h-4 w-4 text-slate-500" />
              </button>
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
                      active
                        ? 'bg-emerald-600 text-white border-emerald-600'
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                    }`}
                    title={t.help ?? t.label}
                  >
                    {t.label}
                  </button>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="px-3 py-1 flex items-center gap-2">
            <span className="text-[11px] text-slate-500 select-none">作図・計測ツール</span>
            {tool !== 'none' && (
              <span className="text-[11px] font-semibold text-blue-700">
                → {[...DRAW_TOOLS, ...MEASURE_TOOLS].find((t) => t.tool === tool)?.label ?? tool}
              </span>
            )}
            {annotations.length > 0 && (
              <span className="text-[11px] text-slate-500">
                作図 {annotations.length} 件
              </span>
            )}
            <button
              onClick={() => setToolbarOpen(true)}
              className="ml-auto p-1 rounded hover:bg-slate-100"
              title="ツールバーを開く"
            >
              <PanelTopOpen className="h-4 w-4 text-slate-500" />
            </button>
          </div>
        )}
      </div>

      {/* 横並び: 左=大きな地図（オルソ＋座標＋区域＋作図＋メモ＋写真）、右=折りたたみパネル */}
      <div className="flex-1 flex min-h-0">
      <div className="flex-1 relative">
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
          {showAnnotationsLayer && (
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
          )}
        </CoordinateMap>

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
              category: meta.title ?? '現場',
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
    <div className="w-80 border-l bg-white flex flex-col min-h-0">
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

      {/* 上半分: メモ一覧 */}
      <div className="flex-1 min-h-0 flex flex-col border-b">
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
            <div className="grid grid-cols-2 gap-1.5">
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
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[3500] p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[92vh] flex flex-col"
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
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
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
          <div className="w-full md:w-64 shrink-0 overflow-y-auto p-3 bg-slate-50">
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
