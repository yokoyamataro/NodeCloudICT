// 全体図ページ: 画面をほぼ全部 地図 (オルソ + 座標 + 区域 + ペイント + メモ + 写真)
// に使う。ページヘッダは置かない。
//
// メモと写真は 地図上のマーカーで 見る (右パネルは廃止)。写真の
// ダウンロードは マーカーの吹き出しから 1 枚ずつ。
//
// 左に縦長のパネルを置き、表示要素 (測点 / 地番 / 暗渠配線 …) と
// ペイントのレイヤを そこで まとめて 管理する。レイヤの並び順が
// そのまま 描画順になる (一覧で上にあるほど 地図でも上)。
//
// オルソ画像のアップロードは 日常的に押すものではないので 設定へ移した
// (OrthophotoUploadSection)。ここに残しているのは 登録済み一覧の 確認だけ。
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Loader2,
  X,
  Map as MapIcon,
  Maximize2,
  Minimize2,
} from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { COORDINATE_TYPE_NAMES, type CoordinateType } from '@/lib/coordinates'
import { useOpenChannelStore } from '@/stores/openChannelStore'
import { getActiveLandxmlFile, downloadLandxmlText } from '@/lib/landxmlFiles'
import { parseLandXml } from '@/lib/landxml/parser'
import {
  renderTin,
  hypsometricColor,
  type RenderedTin,
} from '@/lib/landxml/tinRender'
import {
  buildSegments,
  pointAtDistance,
  sampleAlignment,
  tangentAtDistance,
  type AlignmentVertex,
} from '@/lib/openChannel/alignment'
import { useUnderdrainStore, type PipeRow } from '@/stores/underdrainStore'
import { useWorkAreaStore, type WorkAreaPoint } from '@/stores/workAreaStore'
import {
  Polyline as LeafletPolyline,
  Polygon as LeafletPolygon,
  CircleMarker,
  Pane,
  Tooltip,
} from 'react-leaflet'
import { useOrthophotoStore } from '@/stores/orthophotoStore'
import { useFarmMemoStore, EMPTY_FARM_MEMOS } from '@/stores/farmMemoStore'
import { useAttachmentStore, type Attachment } from '@/stores/attachmentStore'
import { PhotoEditModal } from '@/features/coordinates/PhotoEditModal'
import { CoordinateMap, type ExternalPolygon } from '@/components/map/CoordinateMap'
import { ParcelMapLayer } from '@/components/map/ParcelMapLayer'
import {
  MapDrawingLayer,
  type DrawingMode,
  type SelectMethod,
} from '@/components/map/MapDrawingLayer'
import { MapDrawingToolbar } from '@/components/map/MapDrawingToolbar'
import { MapDrawingCommandBar } from '@/components/map/mapDrawingCommandBar'
import { OverviewExportMenu, type ExportItem } from './OverviewExportMenu'
import {
  OverviewLayerPanel,
  useLayerOrder,
  type ElementRow,
} from './OverviewLayerPanel'
import {
  useMapDrawingStore,
  EMPTY_STROKES,
  DEFAULT_LAYERS,
  DEFAULT_SNAP_TYPES,
  type ArrowStyle,
  type LineStyle,
  type SnapType,
} from '@/stores/mapDrawingStore'
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
  const { fetchByFarm } = useOrthophotoStore()
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
  // 一括取込の結果メッセージ。以前はアップロードモーダル内に出していたが、
  // モーダルを設定へ移したので、地図の上に短く出す
  const [parcelToast, setParcelToast] = useState<string | null>(null)
  useEffect(() => {
    if (!parcelImportMessage) return
    setParcelToast(parcelImportMessage)
    const id = window.setTimeout(() => setParcelToast(null), 5000)
    return () => window.clearTimeout(id)
  }, [parcelImportMessage])

  const [showPointsLayer, setShowPointsLayer] = useState<boolean>(() => readVis('points', true))
  const [showParcelsLayer, setShowParcelsLayer] = useState<boolean>(() => readVis('parcels', true))
  const [showCamerasLayer, setShowCamerasLayer] = useState<boolean>(() => readVis('cameras', true))
  const [showMemosLayer, setShowMemosLayer] = useState<boolean>(() => readVis('memos', true))
  const [showPipesLayer, setShowPipesLayer] = useState<boolean>(() => readVis('pipes', true))
  const [showChannelsLayer, setShowChannelsLayer] = useState<boolean>(() => readVis('channels', true))

  // ペイント描画: モード / 色 / 太さ (ツールバーは常時表示なので起動フラグは持たない)
  const [drawingMode, setDrawingMode] = useState<DrawingMode>('off')
  const [drawingColor, setDrawingColor] = useState('#ef4444')
  const [drawingWidth, setDrawingWidth] = useState(3)
  const [drawingLineStyle, setDrawingLineStyle] = useState<LineStyle>('solid')
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
  useEffect(() => writeVis('pipes', showPipesLayer), [showPipesLayer])
  useEffect(() => writeVis('channels', showChannelsLayer), [showChannelsLayer])

  // グループ の 子項目 (線形物 の 各 channel × 4 種、測点 の 各 点種) の 非表示 集合。
  // 工区 単位 で localStorage 永続化。 キー は 「ch:<channelId>:<type>」「coord:<type>」等。
  const subHiddenKey = currentFarm
    ? `overview:subHidden:${currentFarm.id}`
    : 'overview:subHidden:none'
  const [subHidden, setSubHidden] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(subHiddenKey)
      const parsed = raw ? (JSON.parse(raw) as unknown) : null
      if (Array.isArray(parsed)) return new Set(parsed.filter((v): v is string => typeof v === 'string'))
    } catch {
      /* ignore */
    }
    return new Set()
  })
  useEffect(() => {
    try {
      const raw = localStorage.getItem(subHiddenKey)
      const parsed = raw ? (JSON.parse(raw) as unknown) : null
      setSubHidden(
        new Set(
          Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [],
        ),
      )
    } catch {
      setSubHidden(new Set())
    }
  }, [subHiddenKey])
  const setSubVis = useCallback(
    (key: string, on: boolean) => {
      setSubHidden((prev) => {
        const next = new Set(prev)
        if (on) next.delete(key)
        else next.add(key)
        try {
          localStorage.setItem(subHiddenKey, JSON.stringify(Array.from(next)))
        } catch {
          /* ignore */
        }
        return next
      })
    },
    [subHiddenKey],
  )
  const subOn = useCallback((key: string) => !subHidden.has(key), [subHidden])

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

  // 線形物 (open channel) を 読み取り専用 オーバーレイ として 表示。
  // alignmentPoints は 座標 ID 参照 なので coordinates で 解決。
  const fetchOpenChannels = useOpenChannelStore((s) => s.fetchChannels)
  const openChannels = useOpenChannelStore((s) => s.channels)
  useEffect(() => {
    if (currentFarm) void fetchOpenChannels(currentFarm.id)
  }, [currentFarm, fetchOpenChannels])

  // LandXML (kind='ground' / 'design') を Storage から fetch → パース → TIN 化。
  // 各 kind は 工区 単位 で 1 枚 (getActiveLandxmlFile)。 無ければ null で 何も描画しない。
  const [groundXmlText, setGroundXmlText] = useState<string | null>(null)
  const [designXmlText, setDesignXmlText] = useState<string | null>(null)
  useEffect(() => {
    if (!currentFarm) {
      setGroundXmlText(null)
      setDesignXmlText(null)
      return
    }
    let cancelled = false
    const load = async (kind: 'ground' | 'design') => {
      try {
        const active = await getActiveLandxmlFile(currentFarm.id, kind)
        if (!active || cancelled) return null
        const text = await downloadLandxmlText(active.storagePath)
        return cancelled ? null : text
      } catch (e) {
        console.error(`[landxml fetch ${kind}]`, e)
        return null
      }
    }
    void Promise.all([load('ground'), load('design')]).then(([g, d]) => {
      if (cancelled) return
      setGroundXmlText(g)
      setDesignXmlText(d)
    })
    return () => {
      cancelled = true
    }
  }, [currentFarm])
  const buildTin = useCallback(
    (xmlText: string | null, sourceName: string): RenderedTin | null => {
      if (!xmlText || projectZone == null) return null
      try {
        const parsed = parseLandXml(xmlText, sourceName)
        if (parsed.surfaces.length === 0) return null
        // 三角形 が 一番多い Surface を 採用 (通常 は 1 面)
        const surface = parsed.surfaces.reduce((best, s) =>
          s.triangles.length > best.triangles.length ? s : best,
        )
        const conv = new CoordinateConverter(projectZone)
        return renderTin(surface, conv)
      } catch (e) {
        console.error(`[tin parse ${sourceName}]`, e)
        return null
      }
    },
    [projectZone],
  )
  const groundTin = useMemo(() => buildTin(groundXmlText, 'ground'), [groundXmlText, buildTin])
  const designTin = useMemo(() => buildTin(designXmlText, 'design'), [designXmlText, buildTin])
  const channelOverlay = useMemo(() => {
    type Line = { id: string; channelId: string; positions: [number, number][]; name: string }
    type Stake = {
      key: string
      channelId: string
      lat: number
      lng: number
      offset: number
      note: string | null
    }
    type Vertex = {
      key: string
      channelId: string
      lat: number
      lng: number
      label: 'BP' | 'IP' | 'EP'
      channelName: string
    }
    type Station = {
      key: string
      channelId: string
      lat: number
      lng: number
      label: string
    }
    if (projectZone == null) {
      return {
        lines: [] as Line[],
        stakes: [] as Stake[],
        vertices: [] as Vertex[],
        stations: [] as Station[],
      }
    }
    const conv = new CoordinateConverter(projectZone)
    const lines: Line[] = []
    const stakes: Stake[] = []
    const vertices: Vertex[] = []
    const stations: Station[] = []
    for (const ch of openChannels) {
      const verts: AlignmentVertex[] = []
      const total = ch.alignmentPoints.length
      for (let i = 0; i < total; i++) {
        const p = ch.alignmentPoints[i]
        const c = coordinates.find((cc) => cc.id === p.coordId)
        if (!c) continue
        const label: 'BP' | 'IP' | 'EP' =
          total <= 1 || i === 0 ? 'BP' : i === total - 1 ? 'EP' : 'IP'
        verts.push({
          x: c.x,
          y: c.y,
          kind: label.toLowerCase() as AlignmentVertex['kind'],
          radius: p.radius,
          spiralAIn: p.spiralAIn,
          spiralAOut: p.spiralAOut,
        })
        try {
          const { lat, lng } = conv.toLatLng(c.x, c.y)
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            vertices.push({
              key: `oc-v-${ch.id}-${i}`,
              channelId: ch.id,
              lat,
              lng,
              label,
              channelName: ch.name,
            })
          }
        } catch {
          /* skip */
        }
      }
      if (verts.length < 2) continue
      const sampled = sampleAlignment(verts, 32)
      const positions: [number, number][] = []
      for (const s of sampled) {
        try {
          const { lat, lng } = conv.toLatLng(s.x, s.y)
          if (Number.isFinite(lat) && Number.isFinite(lng)) positions.push([lat, lng])
        } catch {
          /* skip */
        }
      }
      if (positions.length >= 2) lines.push({ id: ch.id, channelId: ch.id, positions, name: ch.name })
      const segments = buildSegments(verts)
      const sign = ch.sideOrientation === 'reverse' ? -1 : 1
      for (const w of ch.widthStakes) {
        const cp = pointAtDistance(segments, w.distance)
        const t = tangentAtDistance(segments, w.distance)
        if (!cp || !t) continue
        const px = cp.x - t.y * sign * w.offset
        const py = cp.y + t.x * sign * w.offset
        try {
          const { lat, lng } = conv.toLatLng(px, py)
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
          stakes.push({
            key: `oc-w-${w.id}`,
            channelId: ch.id,
            lat,
            lng,
            offset: w.offset,
            note: w.note ?? null,
          })
        } catch {
          /* skip */
        }
      }
      // 中間点 (stations): 中心線 上 の 距離 で 定義 → 世界座標 → LatLng
      for (const st of ch.stations ?? []) {
        const cp = pointAtDistance(segments, st.distance)
        if (!cp) continue
        try {
          const { lat, lng } = conv.toLatLng(cp.x, cp.y)
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
          stations.push({
            key: `oc-s-${st.id}`,
            channelId: ch.id,
            lat,
            lng,
            label: st.label,
          })
        } catch {
          /* skip */
        }
      }
    }
    return { lines, stakes, vertices, stations }
  }, [openChannels, coordinates, projectZone])

  // 線形物 の 子項目: 各 channel × 4 タイプ (中心線 / 幅杭 / 線形点 / 中間点)。
  // channel 単位 の 親トグル も サブキー ch:<id> で 管理 する。
  const channelSubRows = useMemo<ElementRow[]>(() => {
    return openChannels.map((ch) => ({
      key: `channel-${ch.id}`,
      label: ch.name,
      on: subOn(`ch:${ch.id}`),
      set: (v: boolean) => setSubVis(`ch:${ch.id}`, v),
      children: [
        {
          key: 'center',
          label: '中心線',
          on: subOn(`ch:${ch.id}:center`),
          set: (v: boolean) => setSubVis(`ch:${ch.id}:center`, v),
        },
        {
          key: 'stakes',
          label: '幅杭',
          on: subOn(`ch:${ch.id}:stakes`),
          set: (v: boolean) => setSubVis(`ch:${ch.id}:stakes`, v),
        },
        {
          key: 'vertices',
          label: '線形点 (BP/IP/EP)',
          on: subOn(`ch:${ch.id}:vertices`),
          set: (v: boolean) => setSubVis(`ch:${ch.id}:vertices`, v),
        },
        {
          key: 'stations',
          label: '中間点',
          on: subOn(`ch:${ch.id}:stations`),
          set: (v: boolean) => setSubVis(`ch:${ch.id}:stations`, v),
        },
      ],
    }))
  }, [openChannels, subOn, setSubVis])

  // 測点 の 子項目: 現在 使用中 の 点種 (control / boundary / …) 単位。
  const coordTypesInUse = useMemo(() => {
    const seen = new Set<string>()
    for (const c of coordinates) if (c.type) seen.add(c.type)
    return Array.from(seen).sort()
  }, [coordinates])
  const coordSubRows = useMemo<ElementRow[]>(() => {
    return coordTypesInUse.map((t) => ({
      key: `type-${t}`,
      label: COORDINATE_TYPE_NAMES[t as CoordinateType] ?? t,
      on: subOn(`coord:${t}`),
      set: (v: boolean) => setSubVis(`coord:${t}`, v),
    }))
  }, [coordTypesInUse, subOn, setSubVis])

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

  // 地図の組み込み要素。左パネルの一覧に ペイントのレイヤと 並べて出す。
  // 測点 / 線形物 は 子項目 (children) を 持つ グループ として 描画される。
  // 要素 が 0 件 の レイヤ は パネル に 出さない (暗渠配線 が 無ければ 「暗渠配線」を 非表示 等)。
  const elementRows = useMemo<ElementRow[]>(() => {
    const rows: ElementRow[] = []
    if (coordinates.length > 0) {
      rows.push({
        key: 'points',
        label: '測点',
        on: showPointsLayer,
        set: setShowPointsLayer,
        children: coordSubRows.length > 0 ? coordSubRows : undefined,
      })
    }
    if (workAreaPolygons.length > 0) {
      rows.push({ key: 'parcels', label: '地番 (区域)', on: showParcelsLayer, set: setShowParcelsLayer })
    }
    if (pipes.length > 0) {
      rows.push({ key: 'pipes', label: '暗渠配線', on: showPipesLayer, set: setShowPipesLayer })
    }
    if (openChannels.length > 0) {
      rows.push({
        key: 'channels',
        label: '線形物',
        on: showChannelsLayer,
        set: setShowChannelsLayer,
        children: channelSubRows.length > 0 ? channelSubRows : undefined,
      })
    }
    // TIN (LandXML) レイヤ。 ground / design それぞれ 存在すれば グループ化 して 追加。
    // サブ 3 種類: 色分けメッシュ / 等高線 / ワイヤーフレーム。
    const tinChildren = (prefix: string): ElementRow[] => [
      {
        key: 'mesh',
        label: '色分けメッシュ',
        on: subOn(`${prefix}:mesh`),
        set: (v: boolean) => setSubVis(`${prefix}:mesh`, v),
      },
      {
        key: 'contour',
        label: '等高線',
        on: subOn(`${prefix}:contour`),
        set: (v: boolean) => setSubVis(`${prefix}:contour`, v),
      },
      {
        key: 'wireframe',
        label: 'ワイヤーフレーム',
        on: subOn(`${prefix}:wireframe`),
        set: (v: boolean) => setSubVis(`${prefix}:wireframe`, v),
      },
    ]
    if (groundTin) {
      rows.push({
        key: 'tin-ground',
        label: '現況 (LandXML)',
        on: subOn('tin:ground'),
        set: (v: boolean) => setSubVis('tin:ground', v),
        children: tinChildren('tin:ground'),
      })
    }
    if (designTin) {
      rows.push({
        key: 'tin-design',
        label: '設計面 (LandXML)',
        on: subOn('tin:design'),
        set: (v: boolean) => setSubVis('tin:design', v),
        children: tinChildren('tin:design'),
      })
    }
    if (farmPhotosForMap.length > 0) {
      rows.push({ key: 'cameras', label: '写真', on: showCamerasLayer, set: setShowCamerasLayer })
    }
    if (memosForMap.length > 0) {
      rows.push({ key: 'memos', label: 'メモ', on: showMemosLayer, set: setShowMemosLayer })
    }
    return rows
  }, [
    coordinates,
    workAreaPolygons,
    pipes,
    openChannels,
    farmPhotosForMap,
    memosForMap,
    showPointsLayer,
    showParcelsLayer,
    showPipesLayer,
    showChannelsLayer,
    showCamerasLayer,
    showMemosLayer,
    coordSubRows,
    channelSubRows,
    groundTin,
    designTin,
    subOn,
    setSubVis,
  ])

  // displayCoordinateIds が Set/undefined の切替で参照が変わらないように memo 化
  const emptyCoordSet = useMemo(() => new Set<string>(), [])
  // 測点 (points) の 実描画対象 ID。
  //   showPointsLayer=false → 空 Set (全非表示)
  //   全 点種 が 表示 → undefined (全表示: CoordinateMap 側で filter しない)
  //   一部 点種 のみ 表示 → 該当点種 の ID Set
  const visibleCoordIds = useMemo<Set<string> | undefined>(() => {
    if (!showPointsLayer) return emptyCoordSet
    const hiddenTypes = new Set<string>()
    for (const t of coordTypesInUse) if (subHidden.has(`coord:${t}`)) hiddenTypes.add(t)
    if (hiddenTypes.size === 0) return undefined
    const s = new Set<string>()
    for (const c of coordinates) {
      if (c.type && !hiddenTypes.has(c.type)) s.add(c.id)
    }
    return s
  }, [showPointsLayer, emptyCoordSet, coordTypesInUse, subHidden, coordinates])

  // モーダル表示
  // 写真帳 / 写真の一括DL。右パネルを廃止したのでヘッダから開く
  const [photoBookOpen, setPhotoBookOpen] = useState(false)

  // ===== 作図・計測 =====
  // ---- ペイント (作図・計測) の設定 ----
  // 作図・計測ツールはペイントへ統合したので、状態はペイント側の設定だけを持つ
  const [selectMethod, setSelectMethod] = useState<SelectMethod>('point')
  const [drawArrow, setDrawArrow] = useState<ArrowStyle>('none')
  /** 選択中の作図要素。左パネルの「描画の設定」を これに効かせる */
  const [selectedDrawingIds, setSelectedDrawingIds] = useState<string[]>([])
  const [snapEnabled, setSnapEnabled] = useState(false)
  const [snapTypes, setSnapTypes] = useState<SnapType[]>(DEFAULT_SNAP_TYPES)
  const toggleSnapType = (t: SnapType) =>
    setSnapTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))
  const [drawLayer, setDrawLayer] = useState<string>(DEFAULT_LAYERS[0])
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
    const set = new Set<string>(DEFAULT_LAYERS)
    for (const d of drawingItems) if (d.layer) set.add(d.layer)
    return Array.from(set)
  }, [drawingItems])

  /**
   * 「描画の設定」を どこに効かせるか。
   * 何も選んでいなければ これから描くものの設定、選んでいれば その図形へ 反映する。
   */
  const updateStrokeAttrs = useMapDrawingStore((s) => s.updateStrokeAttrs)
  const deleteStroke = useMapDrawingStore((s) => s.deleteStroke)
  const applyToSelection = (attrs: Parameters<typeof updateStrokeAttrs>[1]) => {
    for (const id of selectedDrawingIds) void updateStrokeAttrs(id, attrs)
  }
  // Delete / Backspace で 選択中 の 作図要素 を まとめて 削除。
  // 入力欄 (INPUT / TEXTAREA / contentEditable) に フォーカス 中 は 通常 の
  // 文字削除 に 干渉 しない。 修飾キー (Ctrl / Cmd / Alt) 付き は 無視。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (selectedDrawingIds.length === 0) return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return
      e.preventDefault()
      const ids = [...selectedDrawingIds]
      setSelectedDrawingIds([])
      for (const id of ids) void deleteStroke(id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedDrawingIds, deleteStroke])
  /** 選んでいるのが 図枠だけか。図枠は 見た目を 変えられないので 設定を 出さない */
  const selectionIsFramesOnly =
    selectedDrawingIds.length > 0 &&
    selectedDrawingIds.every(
      (id) => drawingItems.find((d) => d.id === id)?.kind === 'frame',
    )

  // レイヤの並び順と表示状態 (この端末での見え方。工区ごとに localStorage へ)
  const elementKeys = useMemo(() => elementRows.map((r) => r.key), [elementRows])
  const {
    ids: panelIds,
    layerOrder: orderedLayers,
    hidden: hiddenLayers,
    move: movePanelRow,
    toggleHidden: toggleLayerHidden,
  } = useLayerOrder(currentFarm?.id ?? '', existingLayers, elementKeys)

  /** 組み込み要素の重ね順。一覧で上にあるほど 大きい zIndex にする */
  const elementPanes = useMemo(() => {
    const out: Record<string, number> = {}
    panelIds.forEach((id, i) => {
      if (!id.startsWith('el:')) return
      // Leaflet の overlayPane(400)〜markerPane(600) の間に収める。
      // 一覧で上にあるほど 大きい zIndex = 手前
      out[id.slice(3)] = 590 - i
    })
    return out as Partial<Record<'points' | 'parcels' | 'cameras' | 'memos', number>> & {
      pipes?: number
      channels?: number
      'tin-ground'?: number
      'tin-design'?: number
    }
  }, [panelIds])
  // 暗渠 / 線形物 / TIN は このページで直接描いているので、z 値だけ取り出す
  const pipesZIndex = elementPanes.pipes ?? 450
  const channelsZIndex = elementPanes.channels ?? 455
  // TIN は 「地形背景」の 位置付け で、他要素 の 手前 に 出さない 前提
  const groundTinZIndex = elementPanes['tin-ground'] ?? 410
  const designTinZIndex = elementPanes['tin-design'] ?? 415

  /** ペイントのレイヤごとの重ね順。組み込み要素と 同じ体系で 並べる */
  const layerZIndex = useMemo(() => {
    const out: Record<string, number> = {}
    panelIds.forEach((id, i) => {
      if (id.startsWith('el:')) return
      out[id] = 590 - i
    })
    return out
  }, [panelIds])

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

  // 区域ポリゴンの辺。交点 / 線上のピックで ペイントの線と 同じように 相手にする
  const extraSegments = useMemo<Array<[{ lat: number; lng: number }, { lat: number; lng: number }]>>(
    () => {
      const out: Array<[{ lat: number; lng: number }, { lat: number; lng: number }]> = []
      for (const poly of workAreaPolygons) {
        const v = poly.positions
        for (let i = 0; i < v.length; i += 1) {
          const j = (i + 1) % v.length
          out.push([
            { lat: v[i][0], lng: v[i][1] },
            { lat: v[j][0], lng: v[j][1] },
          ])
        }
      }
      return out
    },
    [workAreaPolygons],
  )

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

  // ===== レンダリング =====

  if (!currentFarm) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-slate-500">
        工区を選択してください
      </div>
    )
  }

  // 書き出しメニューの中身。今後 種類が増えたらここに足す
  const exportItems: ExportItem[] = [
    {
      key: 'dxf',
      label: 'DXF (ペイント)',
      hint: drawingItems.length > 0 ? `${drawingItems.length} 件` : undefined,
      icon: 'dxf',
      disabled: drawingItems.length === 0,
      onSelect: handleDxfExport,
    },
    {
      key: 'photobook',
      label: '写真帳 (Excel)',
      hint: farmPhotosAll.length > 0 ? `${farmPhotosAll.length} 枚` : undefined,
      icon: 'photobook',
      disabled: farmPhotosAll.length === 0,
      onSelect: () => setPhotoBookOpen(true),
    },
  ]

  return (
    <div className="h-full flex flex-col">
      {/* 画面いっぱいを地図に使いたいので ページヘッダは置かない。
          ページ全体の操作 (書き出し) は このツールバー行に 集約する */}
      <div className="border-b bg-white px-2 py-1.5 flex items-start gap-2">
        <div className="flex-1 min-w-0">
        <MapDrawingToolbar
          variant="bar"
          showAttributes={false}
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
          selectMethod={selectMethod}
          onChangeSelectMethod={setSelectMethod}
          snapEnabled={snapEnabled}
          onToggleSnap={() => setSnapEnabled((v) => !v)}
          snapTypes={snapTypes}
          onToggleSnapType={toggleSnapType}
          layer={drawLayer}
          onChangeLayer={setDrawLayer}
          existingLayers={existingLayers}
          registerCoordinate={registerCoordinate}
          onToggleRegisterCoordinate={() => setRegisterCoordinate((v) => !v)}
        />
        </div>
        {/* 書き出しは 道具と 混ざらないよう 右端に 離して置く */}
        <OverviewExportMenu items={exportItems} />
      </div>
      {/* 今の道具の詳細入力 (文字の内容 / 円の半径 / 平行線の幅…)。
          地図に重ねず、道具アイコンのすぐ下に出す */}
      <MapDrawingCommandBar className="border-b bg-white px-2 py-1.5" />

      {/* 左パネル (表示要素 + レイヤ) と 地図の横並び */}
      <div className="flex-1 flex min-h-0">
      <OverviewLayerPanel
        farmId={currentFarm.id}
        ids={panelIds}
        elements={elementRows}
        hiddenLayers={hiddenLayers}
        onMove={movePanelRow}
        onToggleLayer={toggleLayerHidden}
        currentLayer={drawLayer}
        onSelectLayer={(l) => {
          setDrawLayer(l)
          applyToSelection({ layer: l })
        }}
        onAddLayer={(l) => {
          setDrawLayer(l)
          applyToSelection({ layer: l })
        }}
        color={drawingColor}
        onChangeColor={(c) => {
          setDrawingColor(c)
          applyToSelection({ color: c })
        }}
        lineStyle={drawingLineStyle}
        onChangeLineStyle={(v) => {
          setDrawingLineStyle(v)
          applyToSelection({ lineStyle: v })
        }}
        widthPx={drawingWidth}
        onChangeWidth={(px) => {
          setDrawingWidth(px)
          applyToSelection({ widthPx: px })
        }}
        arrow={drawArrow}
        onChangeArrow={(a) => {
          setDrawArrow(a)
          applyToSelection({ arrow: a })
        }}
        selectedCount={selectedDrawingIds.length}
        hideStyleSettings={drawingMode === 'frame' || selectionIsFramesOnly}
      />

      {/* 地図 (オルソ + 座標 + 区域 + ペイント + メモ + 写真)。
          メモ・写真は地図上のマーカーで見る (右パネルは廃止) */}
      <div className="flex-1 relative min-h-0">
        <CoordinateMap
          key={currentFarm.id}
          elementPanes={elementPanes}
          farmId={currentFarm.id}
          showOrtho
          externalPolygons={showParcelsLayer ? workAreaPolygons : []}
          coordinatesInteractive={false}
          farmMemos={showMemosLayer ? memosForMap : []}
          farmPhotos={showCamerasLayer ? farmPhotosForMap : []}
          photoGetSignedUrl={getSignedUrl}
          onPhotoEdit={handleFarmPhotoEdit}
          onPhotoDelete={handleFarmPhotoDelete}
          // 点種を非表示: 空 Set を渡して全マーカーを除外。
          // 子項目 (点種) で 一部 非表示 なら 表示対象 の 点種 に 絞った Set を 渡す。
          displayCoordinateIds={visibleCoordIds}
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
              disableClicks={drawingMode !== 'off'}
            />
          )}
          {/* ペイントのレイヤ。ツールバーは常時表示、mode='off' なら既存ストロークの表示のみ */}
          <MapDrawingLayer
            farmId={currentFarm.id}
            mode={drawingMode}
            color={drawingColor}
            widthPx={drawingWidth}
            lineStyle={drawingLineStyle}
            converter={converter}
            layer={drawLayer}
            fontSize={drawFontSize}
            onChangeFontSize={setDrawFontSize}
            arrow={drawArrow}
            selectMethod={selectMethod}
            onSelectionChange={setSelectedDrawingIds}
            snapEnabled={snapEnabled}
            snapTypes={snapTypes}
            extraSnapPoints={extraSnapPoints}
            extraSegments={extraSegments}
            layerOrder={orderedLayers}
            hiddenLayers={hiddenLayers}
            layerZIndex={layerZIndex}
            onAddCoordinate={handleAddCoordinate}
            registerCoordinate={registerCoordinate}
          />
          {/* TIN (LandXML) ─ 現況 / 設計面。
              サブ 3 種類 (色分けメッシュ / 等高線 / ワイヤーフレーム) を 個別に 表示切替。
              地形背景 の 位置付け で、他要素 より 奥 の ペイン に 入れる */}
          <TinPane
            paneName="ov-tin-ground"
            zIndex={groundTinZIndex}
            tin={groundTin}
            visible={subOn('tin:ground')}
            meshOn={subOn('tin:ground:mesh')}
            contourOn={subOn('tin:ground:contour')}
            wireframeOn={subOn('tin:ground:wireframe')}
            contourColor="#78350f"
            wireframeColor="#7f1d1d"
            keyPrefix="ground"
          />
          <TinPane
            paneName="ov-tin-design"
            zIndex={designTinZIndex}
            tin={designTin}
            visible={subOn('tin:design')}
            meshOn={subOn('tin:design:mesh')}
            contourOn={subOn('tin:design:contour')}
            wireframeOn={subOn('tin:design:wireframe')}
            contourColor="#312e81"
            wireframeColor="#1e3a8a"
            keyPrefix="design"
          />
          {/* 暗渠 (読み取り専用オーバーレイ)。編集は暗渠モジュールで。
              重ね順を レイヤパネルで 変えられるよう 専用ペインに入れる */}
          <Pane name="ov-pipes" style={{ zIndex: pipesZIndex }}>
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
          </Pane>
          {/* 線形物 (open channel): 中心線 + 幅杭 + BP/IP/EP + 中間点。
              各要素 は レイヤパネル で channel × タイプ 単位 に 表示切替。
              重ね順は レイヤ一覧 で 変更可 (channelsZIndex) */}
          <Pane name="ov-channels" style={{ zIndex: channelsZIndex }}>
            {showChannelsLayer &&
              channelOverlay.lines
                .filter((l) => subOn(`ch:${l.channelId}`) && subOn(`ch:${l.channelId}:center`))
                .map((line) => (
                  <LeafletPolyline
                    key={`oc-line-${line.id}`}
                    positions={line.positions}
                    pathOptions={{ color: '#6366f1', weight: 3, opacity: 0.9 }}
                  >
                    <Tooltip sticky direction="top" opacity={0.9}>
                      {line.name}
                    </Tooltip>
                  </LeafletPolyline>
                ))}
            {showChannelsLayer &&
              channelOverlay.stakes
                .filter((s) => subOn(`ch:${s.channelId}`) && subOn(`ch:${s.channelId}:stakes`))
                .map((s) => (
                  <CircleMarker
                    key={s.key}
                    center={[s.lat, s.lng]}
                    radius={4}
                    pathOptions={{
                      color: '#f59e0b',
                      weight: 1.5,
                      fillColor: '#fbbf24',
                      fillOpacity: 0.9,
                    }}
                  >
                    <Tooltip direction="top" offset={[0, -4]} opacity={0.9}>
                      <span className="text-[10px] font-mono">
                        幅杭 offset={s.offset >= 0 ? '+' : ''}
                        {s.offset.toFixed(2)}m{s.note ? ` (${s.note})` : ''}
                      </span>
                    </Tooltip>
                  </CircleMarker>
                ))}
            {showChannelsLayer &&
              channelOverlay.vertices
                .filter((v) => subOn(`ch:${v.channelId}`) && subOn(`ch:${v.channelId}:vertices`))
                .map((v) => {
                  const color =
                    v.label === 'BP' ? '#059669' : v.label === 'EP' ? '#dc2626' : '#7c3aed'
                  // 座標 マーカー と 同位置 に 塗り丸 を 置くと 隠れる ので、
                  // 塗り無し (ring) + 太めのストローク で 座標ドット を 囲む形 に する。
                  return (
                    <CircleMarker
                      key={v.key}
                      center={[v.lat, v.lng]}
                      radius={9}
                      pathOptions={{
                        color,
                        weight: 2.5,
                        fillOpacity: 0,
                      }}
                    >
                      <Tooltip direction="top" offset={[0, -9]} opacity={0.9}>
                        <span className="text-[11px] font-mono font-semibold" style={{ color }}>
                          {v.channelName} — {v.label}
                        </span>
                      </Tooltip>
                    </CircleMarker>
                  )
                })}
            {showChannelsLayer &&
              channelOverlay.stations
                .filter((s) => subOn(`ch:${s.channelId}`) && subOn(`ch:${s.channelId}:stations`))
                .map((s) => (
                  <CircleMarker
                    key={s.key}
                    center={[s.lat, s.lng]}
                    radius={3}
                    pathOptions={{
                      color: '#4f46e5',
                      weight: 1,
                      fillColor: '#818cf8',
                      fillOpacity: 0.9,
                    }}
                  >
                    {/* 常時表示 の SP ラベル (座標マーカー の 点名 表示 と 同じ スタイル)。
                        point-label-tooltip クラス で 背景透過 + テキスト影 */}
                    <Tooltip
                      permanent
                      direction="top"
                      offset={[0, -4]}
                      className="point-label-tooltip"
                    >
                      <span
                        style={{
                          color: '#4f46e5',
                          textShadow:
                            '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 -1px 0 #fff, 0 1px 0 #fff, -1px 0 0 #fff, 1px 0 0 #fff',
                          fontSize: 10,
                          fontFamily:
                            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                        }}
                      >
                        {s.label}
                      </span>
                    </Tooltip>
                  </CircleMarker>
                ))}
          </Pane>
        </CoordinateMap>

        {parcelToast && (
          <div className="absolute bottom-24 right-2 z-[1000] max-w-[70%] px-3 py-1.5 rounded shadow border bg-white/95 text-[11px] text-slate-700 text-right">
            {parcelToast}
          </div>
        )}

        {/* 法務省地図トグル + 一括取込ボタン。
            地図まわりの操作を右下に 1 か所へまとめるため、背景地図の
            セレクタ (CoordinateMap 内、right-2 bottom-6) の真上に置く */}
        {hasActiveParcelDataset && (
          <div className="absolute bottom-14 right-2 z-[1000] flex flex-col items-end gap-2">
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

      </div>
      </div>{/* /左パネル + 地図 */}

      {/* 写真帳の出力 (順番を決める) */}
      {photoBookOpen && currentFarm && (
        <PhotoBookOrderModal
          photos={farmPhotosAll}
          getSignedUrl={getSignedUrl}
          farmName={currentFarm.name}
          onClose={() => setPhotoBookOpen(false)}
        />
      )}

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

    </div>
  )
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
/**
 * TIN (LandXML) 描画 用 Pane。 色分けメッシュ / 等高線 / ワイヤーフレーム を
 * サブ トグル で 個別 に 表示切替。 tin が null または visible=false で 全体 非表示。
 * contourColor / wireframeColor は 現況 (茶) / 設計 (紺) で 使い分ける ため 引数化。
 */
function TinPane({
  paneName,
  zIndex,
  tin,
  visible,
  meshOn,
  contourOn,
  wireframeOn,
  contourColor,
  wireframeColor,
  keyPrefix,
}: {
  paneName: string
  zIndex: number
  tin: RenderedTin | null
  visible: boolean
  meshOn: boolean
  contourOn: boolean
  wireframeOn: boolean
  contourColor: string
  wireframeColor: string
  keyPrefix: string
}) {
  return (
    <Pane name={paneName} style={{ zIndex }}>
      {tin && visible && meshOn &&
        tin.triangles.map((t, i) => (
          <LeafletPolygon
            key={`${keyPrefix}-tri-${i}`}
            positions={t.positions}
            pathOptions={{
              color: hypsometricColor(t.zAvg, tin.zMin, tin.zMax),
              weight: 0,
              fillColor: hypsometricColor(t.zAvg, tin.zMin, tin.zMax),
              fillOpacity: 0.55,
            }}
            interactive={false}
          />
        ))}
      {tin && visible && wireframeOn &&
        tin.edges.map((e, i) => (
          <LeafletPolyline
            key={`${keyPrefix}-edge-${i}`}
            positions={e.positions}
            pathOptions={{
              color: wireframeColor,
              weight: 0.6,
              opacity: 0.55,
            }}
            interactive={false}
          />
        ))}
      {tin && visible && contourOn &&
        tin.contours.flatMap((c) =>
          c.segments.map((seg, j) => (
            <LeafletPolyline
              key={`${keyPrefix}-c-${c.z.toFixed(3)}-${j}`}
              positions={seg}
              pathOptions={{
                color: contourColor,
                weight: Math.abs(c.z % (tin.contourInterval * 5)) < 1e-6 ? 1.2 : 0.7,
                opacity: 0.85,
              }}
              interactive={false}
            />
          )),
        )}
    </Pane>
  )
}

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
