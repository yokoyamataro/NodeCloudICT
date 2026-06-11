import { useState, useEffect, useMemo } from 'react'
import { Plus, Trash2, GripVertical, Calculator, Download, X, Image as ImageIcon, Ruler, Pencil, Tag, Hash, FileText } from 'lucide-react'
import { useWorkAreaStore, type WorkAreaPoint } from '@/stores/workAreaStore'
import { useCoordinateStore, type CoordinateRow } from '@/stores/coordinateStore'
import { useFarmStore } from '@/stores/farmStore'
import { useParcelStore } from '@/stores/parcelStore'
import { useLandownerStore } from '@/stores/landownerStore'
import { CoordinateMap, type ExternalPolygon, type EdgeRounding, type BaseLayerType } from '@/components/map/CoordinateMap'
import { PageHeader } from '@/components/layout/PageHeader'
import { CadastralRowFields } from '@/features/boundary-survey/CadastralRowFields'
import { CadastralHeader } from '@/features/boundary-survey/CadastralHeader'
import {
  CadastralColumnPicker,
  useCadastralVisibleColumns,
} from '@/features/boundary-survey/CadastralColumnPicker'
import type { WorkType, AreaCalculationSheet as AreaCalculationSheetType } from '@/types/database'
import { WORK_TYPE_NAMES } from '@/types/database'
import { exportAreaCalculationToCSV } from '@/lib/area-calculation'
import { compareByLocationAndParcel } from '@/lib/parcelSort'
import { useMapViewStore } from '@/stores/mapViewStore'
import {
  useCoordinatePointTypeStore,
  getCoordinateTypeOptions,
} from '@/stores/coordinatePointTypeStore'
import { PointTypeFilterButton } from '@/features/coordinates/PointTypeFilterButton'
import { StakeStatusFilterButton } from '@/features/coordinates/StakeStatusFilterButton'
import { RegistryPdfImportModal } from '@/features/boundary-survey/RegistryPdfImportModal'

// 面積計算簿コンポーネント
function AreaCalculationSheet({
  sheet,
  onClose,
}: {
  sheet: AreaCalculationSheetType
  onClose: () => void
}) {
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
}

export function GenericWorkAreaPage({ workType, areaLabel = '工事区域', headerActions }: GenericWorkAreaPageProps) {
  const [calculationSheet, setCalculationSheet] = useState<AreaCalculationSheetType | null>(null)
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null)
  const [editingAreaId, setEditingAreaId] = useState<string | null>(null)
  // 地図のポリゴンクリックで一覧をスクロール/ハイライトするための状態
  // （editingAreaId とは別概念。編集モードに入らずに「選択」だけする）
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null)
  const [pointNameInput, setPointNameInput] = useState<string>('')
  // オルソ表示・背景地図・点種フィルタは座標管理と mapViewStore で共有
  const showOrtho = useMapViewStore((s) => s.showOrtho)
  const setShowOrtho = useMapViewStore((s) => s.setShowOrtho)
  const baseLayer = useMapViewStore((s) => s.baseLayer)
  const setBaseLayer = useMapViewStore((s) => s.setBaseLayer)
  const visibleTypes = useMapViewStore((s) => s.visibleTypes)
  const visibleStakeStatuses = useMapViewStore((s) => s.visibleStakeStatuses)
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
    addWorkArea,
    updateWorkArea,
    deleteWorkArea,
    addPoint,
    removePoint,
    reorderPoints,
    calculateArea,
    getWorkAreasByType,
  } = useWorkAreaStore()

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

  // 地籍モード: 点種フィルター用の選択肢（既定 + プロジェクトのカスタム）
  const projectId = currentFarm?.project_id ?? null
  const pointTypesByProject = useCoordinatePointTypeStore((s) => s.byProject)
  const fetchPointTypes = useCoordinatePointTypeStore((s) => s.fetchForProject)
  useEffect(() => {
    if (isBoundarySurvey && projectId) void fetchPointTypes(projectId)
  }, [isBoundarySurvey, projectId, fetchPointTypes])
  const typeOptions = useMemo(
    () => getCoordinateTypeOptions(projectId, pointTypesByProject),
    [projectId, pointTypesByProject],
  )

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

    // 区域編集中なら、その区域に点を追加
    if (editingAreaId) {
      const coord = coordinates.find(c => c.id === id)
      if (coord) {
        addPoint(editingAreaId, { id: coord.id, pointNumber: coord.pointNumber, x: coord.x, y: coord.y, z: coord.z })
      }
    }
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
      const positions = pts.map(p => [p.lat!, p.lng!] as [number, number])
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
      const labelName = isBoundarySurvey
        ? parcelByWorkAreaId.get(area.id)?.parcel_number || area.zoneNumber || area.name
        : area.name
      return { id: area.id, name: labelName, positions, edges }
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
                  <PointTypeFilterButton typeOptions={typeOptions} />
                  <StakeStatusFilterButton />
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
                </>
              )}
              <button
                onClick={handleAddArea}
                disabled={loading || coordinates.length === 0}
                className="flex items-center gap-2 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Plus className="h-4 w-4" />
                区域追加
              </button>
            </div>
          </div>

          {areas.length === 0 ? (
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
              {/* 地籍: 1 つの表に統合するため、列見出しを先頭に出して横スクロール領域でラップ */}
              {isBoundarySurvey && (
                <div className="overflow-x-auto">
                  <div className="min-w-max">
                    <CadastralHeader visibleColumns={visibleColumns} leadingWidth="w-10" />
                  </div>
                </div>
              )}
              <div className={isBoundarySurvey ? 'overflow-x-auto' : ''}>
                <div className={isBoundarySurvey ? 'min-w-max' : ''}>
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
                        // 行頭の「構成点編集」ボタン
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingAreaId(area.id)
                          }}
                          className={`w-10 flex items-center justify-center py-1 rounded border ${
                            isEditing
                              ? 'bg-blue-600 border-blue-600 text-white'
                              : 'border-slate-300 text-slate-600 hover:bg-slate-100'
                          }`}
                          title="構成点を編集"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {isBoundarySurvey ? (
                        // 地籍: 地番属性も含めて 1 行に横並びで inline 編集（表示列はピッカーで絞れる）
                        <CadastralRowFields area={area} visibleColumns={visibleColumns} />
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

                    {/* 編集中の区域: 構成点リスト（土木のみインライン展開。地籍はモーダル表示） */}
                    {isEditing && !isBoundarySurvey && (
                      <div className="border-t px-3 py-2 bg-slate-50">
                        <div className="text-xs text-muted-foreground mb-2">
                          構成点（地図上の点をクリックして追加、ドラッグで順序変更）
                        </div>
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
            <select
              value={baseLayer}
              onChange={(e) => setBaseLayer(e.target.value as BaseLayerType)}
              className="px-2 py-1 text-xs border border-slate-300 rounded bg-white shadow"
              title="背景地図"
            >
              <option value="osm">地図</option>
              <option value="gsi-photo">航空写真</option>
              <option value="gsi-std">地理院地図</option>
            </select>
          </div>
          <CoordinateMap
            selectedPointId={selectedPointId}
            onPointSelect={handlePointClick}
            externalPolygons={externalPolygons}
            editingExternalPolygonId={editingAreaId}
            selectedExternalPolygonId={isBoundarySurvey ? selectedAreaId : null}
            onPolygonSelect={isBoundarySurvey ? setSelectedAreaId : undefined}
            baseLayer={baseLayer}
            farmId={farmId ?? null}
            showOrtho={showOrtho}
            showEdgeLengths={showEdgeLengths}
            edgeDigits={isBoundarySurvey ? edgeDigits : 2}
            edgeRounding={isBoundarySurvey ? edgeRounding : 'round'}
            showLabels={isBoundarySurvey ? showPointLabels : undefined}
            showPolygonLabels={isBoundarySurvey ? showPolygonLabels : false}
            visibleTypes={isBoundarySurvey ? visibleTypes : undefined}
            visibleStakeStatuses={isBoundarySurvey ? visibleStakeStatuses : undefined}
          />
        </div>
      </div>

      {/* 面積計算簿モーダル */}
      {calculationSheet && (
        <AreaCalculationSheet
          sheet={calculationSheet}
          onClose={() => setCalculationSheet(null)}
        />
      )}

      {/* 地籍: 構成点編集モーダル（編集ボタン押下で開く） */}
      {isBoundarySurvey && editingAreaId && (() => {
        const area = areas.find((a) => a.id === editingAreaId)
        if (!area) return null
        const areaPoints = getAreaPoints(area.id)
        const close = () => setEditingAreaId(null)
        return (
          <div
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4"
            onClick={close}
          >
            <div
              className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-4 py-3 border-b flex items-center gap-2">
                <Pencil className="h-4 w-4 text-blue-600" />
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-semibold truncate">
                    構成点編集: {area.zoneNumber || area.name || '(無題)'}
                  </h3>
                  <div className="text-xs text-slate-500">
                    地図上の点をクリックして追加、ドラッグで順序変更
                  </div>
                </div>
                <button
                  onClick={close}
                  className="p-1 text-slate-400 hover:text-slate-700 rounded"
                  title="閉じる"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="flex-1 overflow-auto p-4 space-y-3">
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
                        <span className="w-5 text-xs text-muted-foreground">{index + 1}.</span>
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

                <div className="flex gap-2">
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

                {area.areaSqm !== null && (
                  <div className="p-2 bg-green-50 border border-green-200 rounded text-xs">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <span className="text-muted-foreground">直角座標法面積:</span>{' '}
                        <span className="font-medium font-mono">
                          {(Math.floor(area.areaSqm * 100) / 100).toFixed(2)} m²
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">周長:</span>{' '}
                        <span className="font-medium font-mono">{area.perimeterM?.toFixed(2)} m</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <div className="px-4 py-2 border-t flex justify-end">
                <button
                  onClick={close}
                  className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
                >
                  閉じる
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* 登記情報 PDF 取込モーダル */}
      {showRegistryImport && isBoundarySurvey && (
        <RegistryPdfImportModal
          areas={sortedAreas}
          onClose={() => setShowRegistryImport(false)}
        />
      )}
    </div>
  )
}
