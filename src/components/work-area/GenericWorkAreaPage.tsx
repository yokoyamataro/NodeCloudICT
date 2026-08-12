import { useState, useEffect, useMemo } from 'react'
import { Plus, Trash2, GripVertical, Calculator, Download, X, Image as ImageIcon, Ruler, Pencil, Tag, Hash, FileText, KeyRound } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { isAdmin } from '@/lib/admin'
import { RegistryFetchOneModal } from '@/features/parcel-maps/RegistryFetchOneModal'
import { parseRegistryPdfViaAI } from '@/lib/registryPdf'
import { useWorkAreaStore, type WorkAreaPoint } from '@/stores/workAreaStore'
import { useCoordinateStore, type CoordinateRow } from '@/stores/coordinateStore'
import { useFarmStore } from '@/stores/farmStore'
import { useParcelStore } from '@/stores/parcelStore'
import {
  useParcelAttributeTypesStore,
  EMPTY_ATTRIBUTES,
} from '@/stores/parcelAttributeTypesStore'
import { useLandownerStore } from '@/stores/landownerStore'
import { CoordinateMap, type ExternalPolygon, type EdgeRounding } from '@/components/map/CoordinateMap'
import { ParcelMapLayer } from '@/components/map/ParcelMapLayer'
import { useParcelMapDatasetStore } from '@/stores/parcelMapDatasetStore'
import { Map as MapIcon } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import {
  CadastralRowFields,
  CADASTRAL_COLUMN_KEYS,
  CADASTRAL_COLUMN_WIDTH,
  CADASTRAL_STICKY_COLUMNS,
  cadastralStickyLeftPx,
  type CadastralColumnKey,
} from '@/features/boundary-survey/CadastralRowFields'
import { CadastralHeader } from '@/features/boundary-survey/CadastralHeader'
import {
  CadastralColumnPicker,
  useCadastralVisibleColumns,
} from '@/features/boundary-survey/CadastralColumnPicker'
import type { WorkType, AreaCalculationSheet as AreaCalculationSheetType } from '@/types/database'
import { WORK_TYPE_NAMES } from '@/types/database'
import { exportAreaCalculationToCSV } from '@/lib/area-calculation'
import { generateCoordinateAreaBookExcel } from '@/lib/coordinateAreaBookExport'
import { useProjectListStore } from '@/stores/projectListStore'
import { compareByLocationAndParcel } from '@/lib/parcelSort'
import { useMapViewStore } from '@/stores/mapViewStore'
import {
  RegistryPdfImportModal,
  REGISTRY_PDF_CATEGORY,
} from '@/features/boundary-survey/RegistryPdfImportModal'
import { useAttachmentStore, type Attachment } from '@/stores/attachmentStore'

// 面積計算簿コンポーネント
function AreaCalculationSheet({
  sheet,
  onClose,
}: {
  sheet: AreaCalculationSheetType
  onClose: () => void
}) {
  const currentProject = useProjectListStore((s) => s.currentProject)

  const handleExportCSV = () => {
    const csv = exportAreaCalculationToCSV(sheet)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `面積計算簿_${sheet.zone_number}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleExportExcel = async () => {
    try {
      const blob = await generateCoordinateAreaBookExcel(sheet, {
        zoneNumber: currentProject?.coordinate_zone ?? null,
        areaLabel: sheet.zone_name || sheet.zone_number,
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `座標面積計算書_${sheet.zone_number}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      console.error('Excel 出力に失敗しました:', e)
      alert('Excel 出力に失敗しました')
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center" style={{ zIndex: 9999 }}>
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-lg font-bold">面積計算簿</h2>
            <p className="text-sm text-muted-foreground">直角座標法による面積計算</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleExportExcel}
              className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded-lg hover:bg-slate-50"
              title="A4 横 の 座標面積計算書 を Excel で出力"
            >
              <Download className="h-4 w-4" />
              Excel出力 (座標面積計算書)
            </button>
            <button
              onClick={handleExportCSV}
              className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded-lg hover:bg-slate-50"
            >
              <Download className="h-4 w-4" />
              CSV出力
            </button>
            <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="p-4 bg-slate-50 border-b">
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">区域番号:</span>{' '}
              <span className="font-medium">{sheet.zone_number}</span>
            </div>
            <div>
              <span className="text-muted-foreground">区域名:</span>{' '}
              <span className="font-medium">{sheet.zone_name}</span>
            </div>
            <div>
              <span className="text-muted-foreground">計算日時:</span>{' '}
              <span className="font-medium">{new Date(sheet.calculated_at).toLocaleString('ja-JP')}</span>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left font-medium border">No.</th>
                <th className="px-3 py-2 text-left font-medium border">点番号</th>
                <th className="px-3 py-2 text-right font-medium border">X座標 (m)</th>
                <th className="px-3 py-2 text-right font-medium border">Y座標 (m)</th>
                <th className="px-3 py-2 text-right font-medium border">Xi × Yi+1</th>
                <th className="px-3 py-2 text-right font-medium border">Xi+1 × Yi</th>
                <th className="px-3 py-2 text-right font-medium border">倍面積</th>
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, index) => (
                <tr key={index} className="hover:bg-slate-50">
                  <td className="px-3 py-2 border text-muted-foreground">{index + 1}</td>
                  <td className="px-3 py-2 border font-medium">{row.point_number}</td>
                  <td className="px-3 py-2 border text-right font-mono">{row.x.toFixed(3)}</td>
                  <td className="px-3 py-2 border text-right font-mono">{row.y.toFixed(3)}</td>
                  <td className="px-3 py-2 border text-right font-mono">{row.xi_yi1.toFixed(3)}</td>
                  <td className="px-3 py-2 border text-right font-mono">{row.xi1_yi.toFixed(3)}</td>
                  <td className="px-3 py-2 border text-right font-mono">{row.double_area.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-100 font-medium">
              <tr>
                <td colSpan={6} className="px-3 py-2 border text-right">倍面積合計</td>
                <td className="px-3 py-2 border text-right font-mono">{sheet.total_double_area.toFixed(3)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="p-4 bg-green-50 border-t">
          <h3 className="text-sm font-medium mb-3">計算結果</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white p-3 rounded-lg border">
              <div className="text-xs text-muted-foreground mb-1">面積 (m²)</div>
              <div className="text-lg font-bold font-mono">{sheet.area_sqm.toFixed(3)}</div>
            </div>
            <div className="bg-white p-3 rounded-lg border">
              <div className="text-xs text-muted-foreground mb-1">面積 (ha)</div>
              <div className="text-lg font-bold font-mono">{sheet.area_ha.toFixed(6)}</div>
            </div>
            <div className="bg-white p-3 rounded-lg border">
              <div className="text-xs text-muted-foreground mb-1">面積 (a)</div>
              <div className="text-lg font-bold font-mono">{(sheet.area_sqm / 100).toFixed(4)}</div>
            </div>
            <div className="bg-white p-3 rounded-lg border">
              <div className="text-xs text-muted-foreground mb-1">周長 (m)</div>
              <div className="text-lg font-bold font-mono">{sheet.perimeter_m.toFixed(3)}</div>
            </div>
          </div>

          <div className="mt-4 p-3 bg-white rounded-lg border text-sm">
            <h4 className="font-medium mb-2">直角座標法（座標法）</h4>
            <div className="text-muted-foreground space-y-1">
              <p>
                <span className="font-mono">2S = Σ(Xi × Yi+1 - Xi+1 × Yi)</span>
              </p>
              <p>
                <span className="font-mono">S = |2S| / 2 = |{sheet.total_double_area.toFixed(3)}| / 2 = {sheet.area_sqm.toFixed(3)} m²</span>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// メイン工事区域ページコンポーネント
interface GenericWorkAreaPageProps {
  workType: WorkType
  /** ページ上の「工事区域」ラベルを差し替える（例: 境界測量では「地番データ」） */
  areaLabel?: string
  /** PageHeader 右側に表示する追加アクション（例: SIM 入出力ボタン） */
  headerActions?: React.ReactNode
  /** CoordinateMap の MapContainer の中に差し込む追加レイヤ (例: 地番マップの背景) */
  mapChildren?: React.ReactNode
  /** 地図左下に固定表示するオーバーレイ (例: 地番データ取込ボタン)。法務省地図トグルは
   *  GenericWorkAreaPage が自前で bottom-left に描くのでその上に積まれる。 */
  mapBottomLeftOverlay?: React.ReactNode
  /** true の場合、GenericWorkAreaPage 側のデフォルト ParcelMapLayer を描画せず
   *  mapChildren で consumer が渡す拡張版 (選択モード付き等) を使う。
   *  法務省地図トグルボタンは常に GenericWorkAreaPage が描く。 */
  suppressDefaultParcelMapLayer?: boolean
  /** 地番 (work_area polygon) 複数選択モード用: 選択済 ID 集合。指定されると
   *  該当 polygon をハイライト + polygon click で onPolygonToggleCheck を呼ぶ
   *  (通常の onPolygonSelect / setSelectedAreaId は呼ばない)。 */
  checkedPolygonIds?: Set<string>
  onPolygonToggleCheck?: (id: string) => void
  /** 「区域登録」ヘッダの CadastralColumnPicker / 登記PDF取込 の右側に差し込む
   *  追加アクション (例: 地番入力 / 地番出力 ドロップダウン) */
  areaListActions?: React.ReactNode
  /** 閲覧のみモード: 全ての編集/追加/削除操作を無効化する */
  readOnly?: boolean
}

export function GenericWorkAreaPage({ workType, areaLabel = '工事区域', headerActions, mapChildren, mapBottomLeftOverlay, suppressDefaultParcelMapLayer, checkedPolygonIds, onPolygonToggleCheck, areaListActions, readOnly = false }: GenericWorkAreaPageProps) {
  const { user } = useAuth()
  const isSiteOwner = isAdmin(user?.email)
  // 「登記取得」モーダルを開く対象 work_area id。1 度に 1 件だけ。
  const [registryFetchTargetId, setRegistryFetchTargetId] = useState<string | null>(null)
  const [calculationSheet, setCalculationSheet] = useState<AreaCalculationSheetType | null>(null)
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null)
  // 編集中ポリゴン: 選択中の構成点 ID（DEL/BACKSPACE で削除する対象）
  const [selectedConstituentPointId, setSelectedConstituentPointId] = useState<string | null>(null)
  // 中点 + を click したあと、座標 click で確定するまでの「挿入待機」状態。
  // 値がある間は地図のマウス位置に追従してポリゴンがプレビューされる。
  const [pendingInsertIdx, setPendingInsertIdx] = useState<number | null>(null)
  const [editingAreaId, setEditingAreaId] = useState<string | null>(null)
  // 地図のポリゴンクリックで一覧をスクロール/ハイライトするための状態
  // （editingAreaId とは別概念。編集モードに入らずに「選択」だけする）
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null)
  const [pointNameInput, setPointNameInput] = useState<string>('')
  // オルソ表示・背景地図・点種フィルタは座標管理と mapViewStore で共有
  const showOrtho = useMapViewStore((s) => s.showOrtho)
  const setShowOrtho = useMapViewStore((s) => s.setShowOrtho)
  const visibleTypes = useMapViewStore((s) => s.visibleTypes)
  const visibleStakeStatuses = useMapViewStore((s) => s.visibleStakeStatuses)
  // 法務省地図 (地番) の背景表示。全ページ共通 (座標管理 / 地番管理 / 全体図)
  const showParcelMap = useMapViewStore((s) => s.showParcelMap)
  const setShowParcelMap = useMapViewStore((s) => s.setShowParcelMap)
  const parcelDatasets = useParcelMapDatasetStore((s) => s.datasets)
  const fetchParcelDatasets = useParcelMapDatasetStore((s) => s.fetchAll)
  const hasActiveParcelDataset = parcelDatasets.some((d) => d.active)
  useEffect(() => {
    void fetchParcelDatasets()
  }, [fetchParcelDatasets])
  const [showEdgeLengths, setShowEdgeLengths] = useState(false)
  // 辺長の桁数・端数設定は境界測量のみ。それ以外は 2桁・四捨五入 固定
  const isBoundarySurvey = workType === 'boundary_survey'
  // 点名 / 地番名の地図ラベル表示切替（localStorage に保存して維持）
  const [showPointLabels, setShowPointLabels] = useState<boolean>(
    () => localStorage.getItem('boundarySurvey:showPointLabels') !== '0',
  )
  const [showPolygonLabels, setShowPolygonLabels] = useState<boolean>(
    () => localStorage.getItem('boundarySurvey:showPolygonLabels') !== '0',
  )
  useEffect(() => {
    localStorage.setItem('boundarySurvey:showPointLabels', showPointLabels ? '1' : '0')
  }, [showPointLabels])
  useEffect(() => {
    localStorage.setItem('boundarySurvey:showPolygonLabels', showPolygonLabels ? '1' : '0')
  }, [showPolygonLabels])
  // 辺長の桁数・端数処理（localStorage に保存して維持）
  const [edgeDigits, setEdgeDigits] = useState<number>(() => {
    const v = Number(localStorage.getItem('edgeLength:digits'))
    return v === 3 ? 3 : 2
  })
  const [edgeRounding, setEdgeRounding] = useState<EdgeRounding>(() =>
    localStorage.getItem('edgeLength:rounding') === 'floor' ? 'floor' : 'round',
  )
  useEffect(() => {
    localStorage.setItem('edgeLength:digits', String(edgeDigits))
  }, [edgeDigits])
  useEffect(() => {
    localStorage.setItem('edgeLength:rounding', edgeRounding)
  }, [edgeRounding])

  const { currentFarm } = useFarmStore()
  const { coordinates, fetchCoordinates } = useCoordinateStore()
  const {
    loading,
    fetchWorkAreas,
    addWorkArea: _addWorkArea,
    updateWorkArea: _updateWorkArea,
    deleteWorkArea: _deleteWorkArea,
    addPoint: _addPoint,
    removePoint: _removePoint,
    reorderPoints: _reorderPoints,
    calculateArea,
    getWorkAreasByType,
  } = useWorkAreaStore()

  // readOnly なら書込みを no-op に置換 (呼出側は変更不要)
  const [readOnlyToastShown, setReadOnlyToastShown] = useState(false)
  const warnReadOnly = () => {
    if (readOnly && !readOnlyToastShown) {
      alert('この現場での編集権限がありません (閲覧のみ)')
      setReadOnlyToastShown(true)
    }
  }
  const addWorkArea = readOnly
    ? ((async (..._args: Parameters<typeof _addWorkArea>) => {
        warnReadOnly()
        return null
      }) as typeof _addWorkArea)
    : _addWorkArea
  const updateWorkArea = readOnly
    ? ((async (..._args: Parameters<typeof _updateWorkArea>) => {
        warnReadOnly()
      }) as typeof _updateWorkArea)
    : _updateWorkArea
  const deleteWorkArea = readOnly
    ? ((async (..._args: Parameters<typeof _deleteWorkArea>) => {
        warnReadOnly()
      }) as typeof _deleteWorkArea)
    : _deleteWorkArea
  const addPoint = readOnly
    ? ((async (..._args: Parameters<typeof _addPoint>) => {
        warnReadOnly()
      }) as typeof _addPoint)
    : _addPoint
  const removePoint = readOnly
    ? ((async (..._args: Parameters<typeof _removePoint>) => {
        warnReadOnly()
      }) as typeof _removePoint)
    : _removePoint
  const reorderPoints = readOnly
    ? ((async (..._args: Parameters<typeof _reorderPoints>) => {
        warnReadOnly()
      }) as typeof _reorderPoints)
    : _reorderPoints

  // 工区が変更されたらデータを取得
  const farmId = currentFarm?.id
  useEffect(() => {
    if (farmId) {
      fetchWorkAreas(farmId)
      fetchCoordinates(farmId)
    }
  }, [farmId, workType, fetchWorkAreas, fetchCoordinates])

  const areas = getWorkAreasByType(workType)
  const workTypeName = WORK_TYPE_NAMES[workType]

  // 地籍モードでは、表示中の地番（design_work_areas）に対応する parcels を一括取得
  const fetchParcels = useParcelStore((s) => s.fetchByWorkAreaIds)
  const clearParcels = useParcelStore((s) => s.clear)
  const parcelByWorkAreaId = useParcelStore((s) => s.byWorkAreaId)
  const upsertParcel = useParcelStore((s) => s.upsertParcel)

  // 地番属性: polygon の塗り色を attribute_code から解決するために code→color の
  // lookup を用意する。projectId は currentFarm 経由で取得。
  const projectId = useFarmStore((s) => s.currentFarm?.project_id ?? null)
  const attributeTypes = useParcelAttributeTypesStore((s) =>
    projectId ? s.byProject.get(projectId) ?? EMPTY_ATTRIBUTES : EMPTY_ATTRIBUTES,
  )
  const attributeColorByCode = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of attributeTypes) m.set(t.code, t.color)
    return m
  }, [attributeTypes])

  // 点種フィルター UI は座標管理側に集約したため、ここでの一覧取得は不要。

  // 地籍モード: 所在 → 地番(親番-小番) の自然順で並べ替えた区域一覧。
  // それ以外（土木工種）は元順を維持する。
  const sortedAreas = useMemo(() => {
    if (!isBoundarySurvey) return areas
    return [...areas].sort((a, b) => {
      const pa = parcelByWorkAreaId.get(a.id)
      const pb = parcelByWorkAreaId.get(b.id)
      return compareByLocationAndParcel(
        {
          location: pa?.location ?? null,
          // parcels 行がまだ無い場合は SIMA 由来の zoneNumber/name を地番代わりに
          parcel_number: pa?.parcel_number ?? a.zoneNumber ?? a.name ?? null,
        },
        {
          location: pb?.location ?? null,
          parcel_number: pb?.parcel_number ?? b.zoneNumber ?? b.name ?? null,
        },
      )
    })
  }, [isBoundarySurvey, areas, parcelByWorkAreaId])
  // 地籍モード: 工区に紐づく地権者と、地番への割り当てを取得
  const fetchLandownersByFarm = useLandownerStore((s) => s.fetchByFarm)
  const refetchLandownerAssignments = useLandownerStore((s) => s.fetchAssignmentsByFarm)
  // 地番一覧の表示列（地籍時のみ使用）。localStorage に保存される
  const [visibleColumns, setVisibleColumns] = useCadastralVisibleColumns()
  // 登記情報 PDF 取込モーダル
  const [showRegistryImport, setShowRegistryImport] = useState(false)

  // 地図のポリゴンクリックで selectedAreaId が変わったら、一覧の該当行を
  // 画面内へスクロールする。一覧内クリックでも block: 'nearest' なので
  // 既に見えている場合はほぼノーオプ。
  useEffect(() => {
    if (!selectedAreaId) return
    const row = document.querySelector(
      `[data-area-row-id="${CSS.escape(selectedAreaId)}"]`,
    )
    if (row instanceof HTMLElement) {
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [selectedAreaId])

  useEffect(() => {
    if (!isBoundarySurvey) {
      clearParcels()
      return
    }
    fetchParcels(areas.map((a) => a.id))
    // areas の id 集合が変わったときだけ再 fetch（中身編集での無駄打ち防止）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBoundarySurvey, areas.map((a) => a.id).join(','), fetchParcels])

  // 地籍モード: 各 work_area に紐づく添付ファイル（登記 PDF など）を一括取得。
  // 行頭の「登記PDFを開く」ボタンの表示判定に使う。
  const attachmentsByEntity = useAttachmentStore((s) => s.byEntity)
  const fetchAttachmentsByEntityIds = useAttachmentStore((s) => s.fetchByEntityIds)
  const getAttachmentSignedUrl = useAttachmentStore((s) => s.getSignedUrl)
  useEffect(() => {
    if (!isBoundarySurvey) return
    if (areas.length === 0) return
    void fetchAttachmentsByEntityIds('work_area', areas.map((a) => a.id))
    // 行 ID 集合が変わったときだけ再 fetch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBoundarySurvey, areas.map((a) => a.id).join(','), fetchAttachmentsByEntityIds])

  // areaId → 最新の登記 PDF attachment（同じ work_area に複数あれば作成日が最新のもの）
  const registryPdfByAreaId = useMemo(() => {
    const m = new Map<string, Attachment>()
    if (!isBoundarySurvey) return m
    for (const a of areas) {
      const list = attachmentsByEntity.get(`work_area:${a.id}`) ?? []
      // 手動アップロード (registry_pdf) + 自動取得 (registry_ownership / registry_full)
      // をまとめて対象にする。ボタンは最新 1 件を開くので種別は問わない。
      const pdfs = list.filter(
        (x) =>
          x.category === REGISTRY_PDF_CATEGORY ||
          x.category === 'registry_ownership' ||
          x.category === 'registry_full',
      )
      if (pdfs.length === 0) continue
      pdfs.sort((p, q) => (q.createdAt ?? '').localeCompare(p.createdAt ?? ''))
      m.set(a.id, pdfs[0])
    }
    return m
  }, [isBoundarySurvey, areas, attachmentsByEntity])

  const downloadRegistryPdf = async (att: Attachment) => {
    const url = await getAttachmentSignedUrl(att.filePath)
    if (!url) {
      alert('PDF の取得に失敗しました（権限 / 保管状態を確認してください）')
      return
    }
    // storage 上のファイル名から basename を抽出、なければ category から生成
    const basename = att.filePath.split('/').pop() ?? ''
    const fallback =
      att.category === 'registry_ownership'
        ? '所有者事項.pdf'
        : att.category === 'registry_full'
        ? '全部事項.pdf'
        : '登記情報.pdf'
    const filename = basename && basename.endsWith('.pdf') ? basename : fallback
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`)
      const blob = await res.blob()
      const objUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objUrl
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(objUrl)
    } catch (err) {
      alert('PDF ダウンロードに失敗しました: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  // 地籍モード: 工区が変わったら地権者一覧を取り直す
  useEffect(() => {
    if (!isBoundarySurvey || !farmId) return
    void fetchLandownersByFarm(farmId)
  }, [isBoundarySurvey, farmId, fetchLandownersByFarm])

  // 地番（parcels）の id 集合が変わったら、地権者の割り当てだけ取り直す
  useEffect(() => {
    if (!isBoundarySurvey || !farmId) return
    void refetchLandownerAssignments(farmId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBoundarySurvey, farmId, Array.from(parcelByWorkAreaId.values()).map((p) => p.id).join(',')])

  // 区域の構成点情報を座標一覧から取得
  const getAreaPoints = (areaId: string): (WorkAreaPoint & { coord?: CoordinateRow })[] => {
    const area = areas.find(a => a.id === areaId)
    if (!area) return []
    return area.points.map(p => ({
      ...p,
      coord: coordinates.find(c => c.id === p.id),
    }))
  }

  const handleAddArea = async () => {
    const newArea = await addWorkArea(workType)
    if (newArea) {
      setEditingAreaId(newArea.id)
    }
  }

  const handleCalculateArea = (areaId: string) => {
    const sheet = calculateArea(areaId)
    if (sheet) {
      setCalculationSheet(sheet)
    }
  }

  const handleDragStart = (e: React.DragEvent, pointId: string) => {
    e.dataTransfer.setData('pointId', pointId)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const handleDrop = (e: React.DragEvent, areaId: string, dropIndex: number) => {
    e.preventDefault()
    const pointId = e.dataTransfer.getData('pointId')
    if (!pointId) return

    const area = areas.find(a => a.id === areaId)
    if (!area) return

    const pointIds = area.points.map(p => p.id)
    const currentIndex = pointIds.indexOf(pointId)
    if (currentIndex === -1) return

    const newPointIds = [...pointIds]
    newPointIds.splice(currentIndex, 1)
    newPointIds.splice(dropIndex, 0, pointId)

    reorderPoints(areaId, newPointIds)
  }

  // 点がクリックされたとき
  const handlePointClick = (id: string) => {
    setSelectedPointId(id)

    if (editingAreaId) {
      const editingArea = areas.find((a) => a.id === editingAreaId)
      if (!editingArea) return
      const constituentIds = editingArea.pointIds
      const coord = coordinates.find((c) => c.id === id)
      if (!coord) return

      const isConstituent = constituentIds.includes(coord.id)

      // ケース⓪: 中点 + クリックで挿入待機中 → ここで確定
      if (pendingInsertIdx != null && !isConstituent) {
        addPoint(editingAreaId, {
          id: coord.id,
          pointNumber: coord.pointNumber,
          x: coord.x,
          y: coord.y,
          z: coord.z,
        })
        const insertAt = Math.min(Math.max(pendingInsertIdx, 0), constituentIds.length)
        const newOrder = [
          ...constituentIds.slice(0, insertAt),
          coord.id,
          ...constituentIds.slice(insertAt),
        ]
        reorderPoints(editingAreaId, newOrder)
        setPendingInsertIdx(null)
        setHoverPos(null)
        return
      }

      // ケース①: クリックされた点が既に構成点 → 選択（次のクリックで置換可）
      if (isConstituent) {
        // 挿入待機中なら一旦解除（構成点には挿入できないので）
        setPendingInsertIdx(null)
        setSelectedConstituentPointId(coord.id)
        return
      }

      // ケース②: 構成点が選択されている状態で別座標 → 置換確定
      if (selectedConstituentPointId) {
        const idx = constituentIds.indexOf(selectedConstituentPointId)
        if (idx === -1) {
          // セレクト中の点が既に構成点から外れていたら、ただ追加
          setSelectedConstituentPointId(null)
          addPoint(editingAreaId, {
            id: coord.id,
            pointNumber: coord.pointNumber,
            x: coord.x,
            y: coord.y,
            z: coord.z,
          })
          return
        }
        // points 配列に新座標を入れてから順序を入れ替え
        addPoint(editingAreaId, {
          id: coord.id,
          pointNumber: coord.pointNumber,
          x: coord.x,
          y: coord.y,
          z: coord.z,
        })
        const newOrder = constituentIds.map((pid, i) =>
          i === idx ? coord.id : pid,
        )
        reorderPoints(editingAreaId, newOrder)
        // 置換確定後は選択解除 → ポリゴンが新位置にロックされ
        // マウス移動で追従し続けることがなくなる。
        // もう一度動かしたければ、新しい構成点を再クリックしてもらう
        setSelectedConstituentPointId(null)
        setHoverPos(null)
        return
      }

      // ケース③: 何も選択していない + 構成点でない → 末尾に追加（従来）
      addPoint(editingAreaId, {
        id: coord.id,
        pointNumber: coord.pointNumber,
        x: coord.x,
        y: coord.y,
        z: coord.z,
      })
    }
  }

  // 編集を抜けたら選択もクリア
  useEffect(() => {
    if (!editingAreaId) setSelectedConstituentPointId(null)
  }, [editingAreaId])

  // DEL / BACKSPACE で選択中の構成点を削除
  useEffect(() => {
    if (!editingAreaId || !selectedConstituentPointId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      // 入力フィールドにフォーカスがあるときはスルー
      const t = e.target as HTMLElement | null
      const tag = t?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return
      e.preventDefault()
      removePoint(editingAreaId, selectedConstituentPointId)
      setSelectedConstituentPointId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editingAreaId, selectedConstituentPointId, removePoint])

  // ESC で「挿入待機 → 構成点選択 → 編集モード」を段階的に解除
  useEffect(() => {
    if (!editingAreaId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return
      e.preventDefault()
      if (pendingInsertIdx != null) {
        setPendingInsertIdx(null)
        setHoverPos(null)
        return
      }
      if (selectedConstituentPointId) {
        setSelectedConstituentPointId(null)
        setHoverPos(null)
        return
      }
      setEditingAreaId(null)
      setSelectedConstituentPointId(null)
      setHoverPos(null)
      setPendingInsertIdx(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editingAreaId, pendingInsertIdx, selectedConstituentPointId])

  // 構成点を選択してから次のクリックで置換確定するまでの間、
  // 地図上のマウス位置でポリゴンを追従させるためのホバープレビュー
  const [hoverPos, setHoverPos] = useState<{ lat: number; lng: number } | null>(null)
  const handleMapMouseMove = (lat: number, lng: number) => {
    if (!selectedConstituentPointId && pendingInsertIdx == null) return
    setHoverPos({ lat, lng })
  }
  const handleMapMouseLeave = () => setHoverPos(null)
  // 選択 or 挿入待機が解除されたら hoverPos もクリア
  useEffect(() => {
    if (!editingAreaId) {
      setHoverPos(null)
      setPendingInsertIdx(null)
      return
    }
    if (!selectedConstituentPointId && pendingInsertIdx == null) {
      setHoverPos(null)
    }
  }, [editingAreaId, selectedConstituentPointId, pendingInsertIdx])

  // 中点 + クリック: 挿入待機モードへ。構成点選択中だった場合は解除して切替
  const handleMidpointClick = (insertAfterIdx: number) => {
    setSelectedConstituentPointId(null)
    setPendingInsertIdx(insertAfterIdx)
  }

  // 点名入力から座標を追加
  const handleAddPointByName = (areaId: string) => {
    const trimmed = pointNameInput.trim()
    if (!trimmed) return

    const coord = coordinates.find(c => c.pointNumber === trimmed)
    if (coord) {
      addPoint(areaId, { id: coord.id, pointNumber: coord.pointNumber, x: coord.x, y: coord.y, z: coord.z })
      setPointNameInput('')
    }
  }

  // 区域ポリゴンを生成
  const externalPolygons: ExternalPolygon[] = areas
    .filter(area => area.points.length >= 3)
    .map(area => {
      const pts = area.points.filter(p => p.lat !== null && p.lng !== null)
      let positions = pts.map(p => [p.lat!, p.lng!] as [number, number])
      // 編集中ポリゴンのプレビュー追従:
      //   ① 構成点を選択中 + マウスが地図上にある
      //      → 選択構成点の位置を hoverPos に置き換えてポリゴンを追従
      //   ② 中点 + クリックで挿入待機中 + マウスが地図上にある
      //      → hoverPos を挿入位置として描画
      if (editingAreaId === area.id && positions.length >= 1) {
        const constituentIds = area.pointIds
        if (selectedConstituentPointId && hoverPos) {
          const idx = constituentIds.indexOf(selectedConstituentPointId)
          if (idx >= 0 && idx < positions.length) {
            positions = positions.map((p, i) =>
              i === idx ? [hoverPos.lat, hoverPos.lng] : p,
            )
          }
        } else if (pendingInsertIdx != null && hoverPos) {
          const insertAt = Math.min(Math.max(pendingInsertIdx, 0), positions.length)
          positions = [
            ...positions.slice(0, insertAt),
            [hoverPos.lat, hoverPos.lng],
            ...positions.slice(insertAt),
          ]
        }
      }
      // 各辺の中点(緯度経度)・辺長(測量座標 X,Y からの平面距離 m)・画面上の傾き(deg)。
      // 閉合辺(最終点→始点)も含む。X=北(上)/Y=東(右) を画面座標(東→右, 北→上)に対応させ、
      // CSS rotate 用の角度を atan2(-dX, dY) で求め、文字が逆さにならないよう ±90° に正規化。
      const edges: ExternalPolygon['edges'] = []
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]
        const b = pts[(i + 1) % pts.length]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const length = Math.sqrt(dx * dx + dy * dy)
        const mid: [number, number] = [(a.lat! + b.lat!) / 2, (a.lng! + b.lng!) / 2]
        let angle = (Math.atan2(-dx, dy) * 180) / Math.PI
        if (angle > 90) angle -= 180
        else if (angle < -90) angle += 180
        edges.push({ mid, length, angle })
      }
      // 地番ラベルは parcels.parcel_number を優先。SIMA 由来の area.zoneNumber/name を
      // 編集前のフォールバックに使う。
      const parcelRow = isBoundarySurvey ? parcelByWorkAreaId.get(area.id) : null
      const labelName = isBoundarySurvey
        ? parcelRow?.parcel_number || area.zoneNumber || area.name
        : area.name
      // 属性色: 地籍モードで attribute_code があれば code → 色に解決
      const attributeColor =
        isBoundarySurvey && parcelRow?.attribute_code
          ? attributeColorByCode.get(parcelRow.attribute_code)
          : undefined
      return { id: area.id, name: labelName, positions, edges, attributeColor }
    })
    .filter(p => p.positions.length >= 3)

  if (!currentFarm) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p>工区を選択してください</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title={isBoundarySurvey ? areaLabel : `${workTypeName} - ${areaLabel}`}
        subtitle={
          isBoundarySurvey
            ? `座標管理に登録した座標を使って${areaLabel}を設定・面積計算`
            : `座標管理に登録した座標を使って${workTypeName}の${areaLabel}を設定・面積計算`
        }
        actions={headerActions}
      />

      {/* 区域編集中の案内 */}
      {editingAreaId && (
        <div className="px-4 py-2 bg-blue-50 border-b text-sm text-blue-700 flex items-center justify-between">
          <span>区域編集中: 地図上の点をクリックして追加</span>
          <button
            onClick={() => setEditingAreaId(null)}
            className="px-2 py-1 text-xs bg-blue-100 hover:bg-blue-200 rounded"
          >
            編集終了
          </button>
        </div>
      )}

      {/* 座標未登録の案内 */}
      {coordinates.length === 0 && (
        <div className="px-4 py-3 bg-amber-50 border-b text-sm text-amber-700">
          座標が登録されていません。先に「座標管理」で座標を登録してください。
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* 左側: 区域一覧 */}
        <div className="w-1/2 flex flex-col overflow-hidden border-r p-4">
          <div className="flex items-center justify-between mb-4 gap-2">
            <h3 className="text-lg font-semibold">区域登録</h3>
            <div className="flex items-center gap-2">
              {isBoundarySurvey && (
                <>
                  {/* 点種フィルター・設置状態フィルターは座標管理ページに集約。
                      地番管理側では同じ設定が共有されるので、ここには出さない。 */}
                  <CadastralColumnPicker
                    visible={visibleColumns}
                    onChange={setVisibleColumns}
                  />
                  <button
                    type="button"
                    onClick={() => setShowRegistryImport(true)}
                    title="登記情報 PDF から登記地目 / 地積 / 所有者を取り込む"
                    className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    登記PDF取込
                  </button>
                  {areaListActions}
                </>
              )}
              {/* 地籍は最下行の空入力で追加するためボタン不要。他の工種では従来通り */}
              {!isBoundarySurvey && (
                <button
                  onClick={handleAddArea}
                  disabled={loading || coordinates.length === 0}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus className="h-4 w-4" />
                  区域追加
                </button>
              )}
            </div>
          </div>

          {areas.length === 0 && !isBoundarySurvey ? (
            <div className="text-center py-8 text-muted-foreground border rounded-lg">
              区域がありません。「区域追加」ボタンで追加してください。
            </div>
          ) : (
            <div
              className={
                isBoundarySurvey
                  ? 'flex-1 overflow-auto border rounded-lg bg-white'
                  : 'flex-1 overflow-auto space-y-2'
              }
            >
              {/* 地籍: ヘッダー + 行を同じ横スクロール領域に入れる。
                  sticky 列（編集 / 地番）が両側で同期するため、見出しと行で
                  別々の overflow-x-auto を持たせない。 */}
              <div className={isBoundarySurvey ? 'min-w-max' : ''}>
                {isBoundarySurvey && (
                  <CadastralHeader visibleColumns={visibleColumns} leadingWidth={isSiteOwner ? 'w-28' : 'w-20'} />
                )}
                <div>
              {sortedAreas.map((area) => {
                const isEditing = editingAreaId === area.id
                const isSelected = !isEditing && selectedAreaId === area.id
                const areaPoints = getAreaPoints(area.id)

                return (
                  <div
                    key={area.id}
                    data-area-row-id={area.id}
                    className={
                      isBoundarySurvey
                        ? ''
                        : `border rounded-lg bg-white ${isEditing ? 'ring-2 ring-primary' : ''}`
                    }
                  >
                    {/* 区域ヘッダー（地籍は表の行スタイル、土木はカードヘッダー） */}
                    <div
                      className={
                        isBoundarySurvey
                          ? `flex items-center gap-1 px-3 py-2 border-b hover:bg-slate-50 ${isEditing ? 'bg-blue-50' : isSelected ? 'bg-orange-50' : ''}`
                          : `p-3 flex items-center gap-3 cursor-pointer hover:bg-slate-50 ${isEditing ? 'bg-blue-50' : ''}`
                      }
                      onClick={
                        isBoundarySurvey
                          ? () => setSelectedAreaId(area.id)
                          : () => setEditingAreaId(isEditing ? null : area.id)
                      }
                    >
                      {isBoundarySurvey && (
                        // 行頭の「構成点編集」+「登記PDFを開く」(+ site owner のみ「登記取得」)。
                        // 横スクロール時も見えるよう sticky。ボタン数に応じて幅を可変。
                        <div
                          className={`${isSiteOwner ? 'w-28' : 'w-20'} shrink-0 flex items-center justify-center gap-1 sticky left-3 z-10`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              setEditingAreaId(area.id)
                            }}
                            className={`w-9 h-7 flex items-center justify-center rounded border ${
                              isEditing
                                ? 'bg-blue-600 border-blue-600 text-white'
                                : isSelected
                                ? 'bg-orange-50 border-slate-300 text-slate-600 hover:bg-orange-100'
                                : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-100'
                            }`}
                            title="構成点を編集"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          {(() => {
                            const pdf = registryPdfByAreaId.get(area.id)
                            return (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (pdf) void downloadRegistryPdf(pdf)
                                }}
                                disabled={!pdf}
                                className={`w-9 h-7 flex items-center justify-center rounded border ${
                                  pdf
                                    ? 'bg-white border-slate-300 text-slate-600 hover:bg-slate-100'
                                    : 'bg-slate-50 border-slate-200 text-slate-300 cursor-not-allowed'
                                }`}
                                title={pdf ? '登記PDFをダウンロード' : '登記PDF未登録'}
                              >
                                <Download className="h-3.5 w-3.5" />
                              </button>
                            )
                          })()}
                          {isSiteOwner && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                setRegistryFetchTargetId(area.id)
                              }}
                              className="w-9 h-7 flex items-center justify-center rounded border bg-white border-slate-300 text-slate-600 hover:bg-blue-50"
                              title="登記情報 (所有者事項 / 全部事項) を touki.or.jp から自動取得 (site owner のみ)"
                            >
                              <KeyRound className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      )}
                      {isBoundarySurvey ? (
                        // 地籍: 地番属性も含めて 1 行に横並びで inline 編集（表示列はピッカーで絞れる）
                        <CadastralRowFields
                          area={area}
                          visibleColumns={visibleColumns}
                          readOnly={readOnly}
                        />
                      ) : (
                        <div className="flex-1 grid grid-cols-3 gap-2 text-sm">
                          <input
                            type="text"
                            value={area.zoneNumber}
                            onChange={(e) => {
                              e.stopPropagation()
                              updateWorkArea(area.id, { zoneNumber: e.target.value })
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="px-2 py-1 border rounded"
                            placeholder="区域番号"
                          />
                          <div className="px-2 py-1 text-muted-foreground">
                            {area.points.length} 点
                          </div>
                          <div className="px-2 py-1">
                            {area.areaHa !== null ? `${area.areaHa.toFixed(4)} ha` : '-'}
                          </div>
                        </div>
                      )}

                      <div
                        className={
                          isBoundarySurvey
                            ? 'w-16 flex items-center justify-center gap-0.5'
                            : 'flex items-center gap-1'
                        }
                      >
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleCalculateArea(area.id)
                          }}
                          disabled={area.points.length < 3}
                          className="flex items-center gap-1 px-1.5 py-1 text-xs border rounded hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed"
                          title="面積計算"
                        >
                          <Calculator className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            deleteWorkArea(area.id)
                            if (isEditing) setEditingAreaId(null)
                          }}
                          className="p-1 text-red-500 hover:bg-red-50 rounded"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* 編集中の区域: 構成点リスト（インライン展開）。
                        地籍も同じ場所に出すことで、モーダルが地図クリックを
                        塞いで点が選べない問題を避ける */}
                    {isEditing && (
                      <div className="border-t px-3 py-2 bg-slate-50">
                        <div className="text-xs text-muted-foreground mb-2 flex items-center gap-2">
                          <span>構成点（地図上の点をクリックして追加、ドラッグで順序変更）</span>
                          {isBoundarySurvey && (
                            <span className="ml-auto text-[10px] text-slate-400">
                              <kbd className="px-1 bg-slate-100 border rounded">Esc</kbd> で編集終了
                            </span>
                          )}
                        </div>
                        {isBoundarySurvey && (
                          <div className="mb-2 px-2 py-1.5 text-[11px] rounded border bg-white">
                            {pendingInsertIdx != null ? (
                              <span className="text-emerald-700">
                                <span className="font-semibold">挿入待機:</span>{' '}
                                第 {pendingInsertIdx} 点目と {pendingInsertIdx + 1} 点目の間に挿入
                                {' — '}
                                <span className="text-slate-600">
                                  挿入する座標をクリック、または <kbd className="px-1 bg-slate-100 border rounded">Esc</kbd> でキャンセル
                                </span>
                              </span>
                            ) : selectedConstituentPointId ? (
                              <span className="text-orange-700">
                                <span className="font-semibold">選択中:</span>{' '}
                                {coordinates.find((c) => c.id === selectedConstituentPointId)?.pointNumber ?? ''}
                                {' — '}
                                <span className="text-slate-600">
                                  別の座標をクリックで <b>置換</b>、または <kbd className="px-1 bg-slate-100 border rounded">Del</kbd> /
                                  <kbd className="px-1 bg-slate-100 border rounded">Backspace</kbd> で削除
                                </span>
                              </span>
                            ) : (
                              <span className="text-slate-500">
                                構成点クリックで選択 → 別座標クリックで置換、または <kbd className="px-1 bg-slate-100 border rounded">Del</kbd> 削除。
                                辺の中点 <span className="text-emerald-700 font-semibold">+</span> をクリック → 座標クリックで挿入。
                              </span>
                            )}
                          </div>
                        )}
                        {areaPoints.length === 0 ? (
                          <div className="py-4 text-center text-sm text-muted-foreground border border-dashed rounded">
                            点を選択してください
                          </div>
                        ) : (
                          <ul className="space-y-1">
                            {areaPoints.map((point, index) => (
                              <li
                                key={point.id}
                                draggable
                                onDragStart={(e) => handleDragStart(e, point.id)}
                                onDragOver={handleDragOver}
                                onDrop={(e) => handleDrop(e, area.id, index)}
                                className="flex items-center gap-2 px-2 py-1.5 text-sm bg-white border rounded cursor-move hover:bg-slate-50"
                              >
                                <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="w-5 text-xs text-muted-foreground">
                                  {index + 1}.
                                </span>
                                <span className="font-medium">{point.pointNumber}</span>
                                <span className="text-xs text-muted-foreground">
                                  ({point.x.toFixed(1)}, {point.y.toFixed(1)})
                                </span>
                                <button
                                  onClick={() => removePoint(area.id, point.id)}
                                  className="ml-auto p-0.5 text-red-500 hover:bg-red-50 rounded"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}

                        {/* 点名入力フィールド */}
                        <div className="mt-2 flex gap-2">
                          <input
                            type="text"
                            value={pointNameInput}
                            onChange={(e) => setPointNameInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                handleAddPointByName(area.id)
                              }
                            }}
                            placeholder="点名を入力 (例: K1)"
                            className="flex-1 px-2 py-1 text-sm border rounded"
                          />
                          <button
                            onClick={() => handleAddPointByName(area.id)}
                            disabled={!pointNameInput.trim()}
                            className="px-3 py-1 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            追加
                          </button>
                        </div>

                        {/* 面積情報 */}
                        {area.areaSqm !== null && (
                          <div className="mt-3 p-2 bg-green-50 border border-green-200 rounded text-xs">
                            <div className="grid grid-cols-3 gap-2">
                              <div>
                                <span className="text-muted-foreground">面積:</span>{' '}
                                <span className="font-medium">{area.areaSqm.toFixed(2)} m²</span>
                              </div>
                              <div>
                                <span className="text-muted-foreground">面積:</span>{' '}
                                <span className="font-medium">{area.areaHa?.toFixed(4)} ha</span>
                              </div>
                              <div>
                                <span className="text-muted-foreground">周長:</span>{' '}
                                <span className="font-medium">{area.perimeterM?.toFixed(2)} m</span>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                  </div>
                )
              })}
              {/* 地籍: 最下行は常に空の入力行。地番を入力 → Enter / Blur で確定し
                  新規 work_area + parcels を作る。 */}
              {isBoundarySurvey && (
                <NewCadastralAreaRow
                  visibleColumns={visibleColumns}
                  onCreate={async (parcelNumber) => {
                    const newArea = await addWorkArea('boundary_survey')
                    if (newArea) {
                      await upsertParcel(newArea.id, { parcel_number: parcelNumber })
                    }
                  }}
                />
              )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 右側: 地図 */}
        <div className="w-1/2 bg-slate-100 relative">
          <div className="absolute top-2 right-2 z-[1000] flex items-center gap-2">
            {/* 地籍時のみ: 点名 / 地番名のラベル表示切替 */}
            {isBoundarySurvey && (
              <>
                <button
                  onClick={() => setShowPointLabels((v) => !v)}
                  className={`flex items-center gap-1 px-2 py-1 text-xs rounded border shadow ${
                    showPointLabels
                      ? 'bg-emerald-100 border-emerald-400 text-emerald-800 font-medium'
                      : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
                  }`}
                  title="点名の表示を切替"
                >
                  <Hash className="h-3 w-3" />
                  点名
                </button>
                <button
                  onClick={() => setShowPolygonLabels((v) => !v)}
                  className={`flex items-center gap-1 px-2 py-1 text-xs rounded border shadow ${
                    showPolygonLabels
                      ? 'bg-emerald-100 border-emerald-400 text-emerald-800 font-medium'
                      : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
                  }`}
                  title="地番名の表示を切替"
                >
                  <Tag className="h-3 w-3" />
                  地番名
                </button>
              </>
            )}
            <button
              onClick={() => setShowEdgeLengths((v) => !v)}
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded border shadow ${
                showEdgeLengths
                  ? 'bg-emerald-100 border-emerald-400 text-emerald-800 font-medium'
                  : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
              }`}
              title="各辺の辺長（点間距離）の表示を切替"
            >
              <Ruler className="h-3 w-3" />
              辺長
            </button>
            {showEdgeLengths && isBoundarySurvey && (
              <div className="flex items-center gap-1 px-1.5 py-1 text-xs rounded border border-slate-300 bg-white shadow">
                <select
                  value={edgeDigits}
                  onChange={(e) => setEdgeDigits(Number(e.target.value))}
                  className="bg-transparent outline-none"
                  title="小数点以下の桁数"
                >
                  <option value={2}>2桁</option>
                  <option value={3}>3桁</option>
                </select>
                <select
                  value={edgeRounding}
                  onChange={(e) => setEdgeRounding(e.target.value as EdgeRounding)}
                  className="bg-transparent outline-none"
                  title="端数処理"
                >
                  <option value="round">四捨五入</option>
                  <option value="floor">切捨</option>
                </select>
              </div>
            )}
            <button
              onClick={() => setShowOrtho(!showOrtho)}
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded border shadow ${
                showOrtho
                  ? 'bg-emerald-100 border-emerald-400 text-emerald-800 font-medium'
                  : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
              }`}
              title="オルソ画像の表示を切替"
            >
              <ImageIcon className="h-3 w-3" />
              オルソ
            </button>
          </div>
          <CoordinateMap
            selectedPointId={selectedPointId}
            onPointSelect={handlePointClick}
            externalPolygons={externalPolygons}
            editingExternalPolygonId={editingAreaId}
            selectedExternalPolygonId={
              onPolygonToggleCheck ? null : isBoundarySurvey ? selectedAreaId : null
            }
            checkedExternalPolygonIds={checkedPolygonIds}
            onPolygonSelect={
              onPolygonToggleCheck
                ? onPolygonToggleCheck
                : isBoundarySurvey
                ? setSelectedAreaId
                : undefined
            }
            farmId={farmId ?? null}
            showOrtho={showOrtho}
            showEdgeLengths={showEdgeLengths}
            edgeDigits={isBoundarySurvey ? edgeDigits : 2}
            edgeRounding={isBoundarySurvey ? edgeRounding : 'round'}
            showLabels={isBoundarySurvey ? showPointLabels : undefined}
            showPolygonLabels={isBoundarySurvey ? showPolygonLabels : false}
            visibleTypes={isBoundarySurvey ? visibleTypes : undefined}
            visibleStakeStatuses={isBoundarySurvey ? visibleStakeStatuses : undefined}
            editingConstituentPointIds={
              editingAreaId
                ? areas.find((a) => a.id === editingAreaId)?.pointIds
                : undefined
            }
            selectedConstituentPointId={selectedConstituentPointId}
            onMidpointClick={editingAreaId ? handleMidpointClick : undefined}
            activeMidpointIdx={pendingInsertIdx}
            onMapMouseMove={
              editingAreaId && (selectedConstituentPointId || pendingInsertIdx != null)
                ? handleMapMouseMove
                : undefined
            }
            onMapMouseLeave={
              editingAreaId && (selectedConstituentPointId || pendingInsertIdx != null)
                ? handleMapMouseLeave
                : undefined
            }
          >
            {mapChildren}
            {/* デフォルト法務省地図レイヤ (consumer が拡張版を渡す場合は suppress) */}
            {hasActiveParcelDataset && showParcelMap && !suppressDefaultParcelMapLayer && (
              <ParcelMapLayer visible={true} bbox={null} />
            )}
          </CoordinateMap>
          {/* 地図左下: 法務省地図トグル (常時) + consumer の追加ボタン (地番データ取込 等)。
              右下は CoordinateMap 内 HUD の領域なので棲み分け。 */}
          {(mapBottomLeftOverlay || hasActiveParcelDataset) && (
            <div className="absolute bottom-6 left-2 z-[1000] flex flex-col items-start gap-2">
              {mapBottomLeftOverlay}
              {hasActiveParcelDataset && (
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
              )}
            </div>
          )}
        </div>
      </div>

      {/* 面積計算簿モーダル */}
      {calculationSheet && (
        <AreaCalculationSheet
          sheet={calculationSheet}
          onClose={() => setCalculationSheet(null)}
        />
      )}

      {/* 登記情報 PDF 取込モーダル */}
      {showRegistryImport && isBoundarySurvey && (
        <RegistryPdfImportModal
          areas={sortedAreas}
          onClose={() => setShowRegistryImport(false)}
        />
      )}

      {/* 登記情報 自動取得モーダル (touki.or.jp、site owner のみ) */}
      {registryFetchTargetId && isSiteOwner && farmId && (() => {
        const targetArea = sortedAreas.find((a) => a.id === registryFetchTargetId)
        const targetParcel = targetArea
          ? parcelByWorkAreaId.get(targetArea.id) ?? null
          : null
        const parcelNumber =
          targetParcel?.parcel_number || targetArea?.zoneNumber || targetArea?.name || ''
        const location = targetParcel?.location ?? ''
        return (
          <RegistryFetchOneModal
            workAreaId={registryFetchTargetId}
            parcelNumber={parcelNumber}
            location={location}
            initialPrefecture={targetParcel?.prefecture ?? null}
            initialCity={targetParcel?.municipality ?? null}
            farmId={farmId}
            onClose={() => setRegistryFetchTargetId(null)}
            onDone={(r) => {
              const targetId = registryFetchTargetId
              // 取得完了 → attachments を再取得 + parcels に prefecture/municipality を保存
              void fetchAttachmentsByEntityIds(
                'work_area',
                sortedAreas.map((a) => a.id),
              )
              // 前回入力値を parcels に反映 (次回モーダルで自動入力される)
              if (
                (targetParcel?.prefecture ?? null) !== r.prefecture ||
                (targetParcel?.municipality ?? null) !== r.municipality
              ) {
                void upsertParcel(targetId, {
                  prefecture: r.prefecture,
                  municipality: r.municipality,
                })
              }
              // 取得した PDF を自動パースして parcels の登記情報カラムに反映
              if (r.signedUrl) {
                void (async () => {
                  try {
                    const resp = await fetch(r.signedUrl!)
                    if (!resp.ok) {
                      console.warn('[registry] PDF fetch failed', resp.status)
                      return
                    }
                    const blob = await resp.blob()
                    const file = new File([blob], `${r.kind}_${targetId}.pdf`, {
                      type: 'application/pdf',
                    })
                    // Claude Haiku で PDF を直接パース (regex ではなく AI 一本化)
                    const parsed = await parseRegistryPdfViaAI(
                      file,
                      r.kind,
                      {
                        location: targetParcel?.location ?? null,
                        parcel_number: targetParcel?.parcel_number ?? null,
                      },
                    )
                    const patch: Partial<import('@/stores/parcelStore').ParcelEditableFields> = {}
                    if (parsed.location && !targetParcel?.location) {
                      patch.location = parsed.location
                    }
                    if (parsed.landCategory) {
                      patch.registered_land_category = parsed.landCategory
                    }
                    if (parsed.areaSqm != null) {
                      patch.registered_area_sqm = parsed.areaSqm
                    }
                    if (parsed.owners.length > 0) {
                      patch.registered_owner_name = parsed.owners[0].fullName
                      patch.registered_owner_address = parsed.owners[0].address
                    }
                    if (Object.keys(patch).length > 0) {
                      await upsertParcel(targetId, patch)
                    }
                  } catch (err) {
                    console.error('[registry] auto parse failed', err)
                  }
                })()
              }
            }}
          />
        )
      })()}
    </div>
  )
}

// 地番管理の最下行に常に出す「新規地番」入力行。
// 地番欄に文字を入れて Enter / フォーカスアウトで確定 → addWorkArea +
// upsertParcel で新規 work_area + parcels を作る。確定後は空に戻る。
function NewCadastralAreaRow({
  visibleColumns,
  onCreate,
}: {
  visibleColumns: ReadonlySet<CadastralColumnKey>
  onCreate: (parcelNumber: string) => Promise<void>
}) {
  const [parcelNum, setParcelNum] = useState('')
  const [saving, setSaving] = useState(false)
  const commit = async () => {
    const t = parcelNum.trim()
    if (!t || saving) return
    setSaving(true)
    try {
      await onCreate(t)
      setParcelNum('')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="flex items-center gap-1 px-3 py-2 border-b bg-amber-50/40">
      <div
        className="w-10 shrink-0 flex items-center justify-center py-1 rounded border border-dashed border-slate-300 sticky left-3 z-10 bg-amber-50/80"
        title="地番を入力して Enter で追加"
      >
        <Plus className="h-3.5 w-3.5 text-slate-400" />
      </div>
      <div className="flex items-center gap-1 text-xs whitespace-nowrap">
        {CADASTRAL_COLUMN_KEYS.filter((k) => visibleColumns.has(k)).map((key) => {
          const isParcel = key === 'parcel_number'
          const isSticky = CADASTRAL_STICKY_COLUMNS.has(key)
          return (
            <div
              key={key}
              className={`${CADASTRAL_COLUMN_WIDTH[key]} shrink-0 ${
                isSticky ? 'sticky z-10 bg-amber-50/80' : ''
              }`}
              style={
                isSticky
                  ? { left: cadastralStickyLeftPx(key, visibleColumns) + 'px' }
                  : undefined
              }
            >
              {isParcel ? (
                <input
                  type="text"
                  value={parcelNum}
                  onChange={(e) => setParcelNum(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void commit()
                    }
                  }}
                  onBlur={() => void commit()}
                  disabled={saving}
                  placeholder="地番を入力"
                  className={`w-full px-1.5 py-1 border rounded text-sm ${
                    saving ? 'opacity-50' : ''
                  }`}
                />
              ) : (
                <span className="text-[10px] text-slate-300">—</span>
              )}
            </div>
          )
        })}
      </div>
      <div className="w-16 shrink-0" />
    </div>
  )
}
