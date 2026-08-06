import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Upload, Download, Trash2, FileText, Eye, EyeOff, Clipboard, Route, ArrowUp, ArrowDown, ChevronDown, Camera, Image as ImageIcon, Loader2, Calculator, Layers, Check, Pencil, X, Save, Waves, Target } from 'lucide-react'
import { Polyline as LeafletPolyline, CircleMarker, Tooltip } from 'react-leaflet'
import { CoordinateConverter } from '@/lib/coordinates'
import { useUnderdrainStore, type PipeRow } from '@/stores/underdrainStore'
import { useExportRouteStore, type Route as ExportRoute } from '@/stores/exportRouteStore'
// stable 空配列。selector 内で毎回 [] を返すと無限再レンダー (#185)
const EMPTY_EXPORT_ROUTES: ExportRoute[] = []
import { PointTypeFilterButton } from './PointTypeFilterButton'
import { StakeStatusFilterButton } from './StakeStatusFilterButton'
import {
  PhotoCountFilterButton,
  type PhotoCountFilter,
} from './PhotoCountFilterButton'
import { StakeTypeFilterButton } from './StakeTypeFilterButton'
import { CoordinatePhotoModal } from './CoordinatePhotoModal'
import { CoordinatePhotoPanel } from './CoordinatePhotoPanel'
import { BulkCalcModal } from './BulkCalcModal'
import { CoordinateCalcModal } from './CoordinateCalcModal'
import { JGD2011_ZONES, COORDINATE_TYPE_NAMES } from '@/lib/coordinates'
import { useCoordinateStore, type CoordinateRow } from '@/stores/coordinateStore'
import { useFarmStore } from '@/stores/farmStore'
import { useFarmMemoStore, EMPTY_FARM_MEMOS } from '@/stores/farmMemoStore'
import { useNavigate } from 'react-router-dom'
import { useMapViewStore } from '@/stores/mapViewStore'
import { useStakingStore } from '@/stores/stakingStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useAttachmentStore } from '@/stores/attachmentStore'
import { useWorkAreaStore, type WorkAreaPoint } from '@/stores/workAreaStore'
import { useParcelStore } from '@/stores/parcelStore'
import { WORK_TYPE_NAMES, type WorkType } from '@/types/database'
import { generatePhotoBookExcel, PHOTO_BOOK_TEMPLATES, type PhotoBookTemplate } from '@/lib/photoBook'
import { useGlobalSaveRegistry } from '@/stores/globalSaveRegistry'
import {
  useCoordinatePointTypeStore,
  getCoordinateTypeOptions,
} from '@/stores/coordinatePointTypeStore'
import { CoordinateMap, type ExternalPolygon } from '@/components/map/CoordinateMap'
import { ParcelMapLayer } from '@/components/map/ParcelMapLayer'
import { useParcelMapDatasetStore } from '@/stores/parcelMapDatasetStore'
import { Map as MapIcon } from 'lucide-react'
import { ResizableSplit } from '@/components/layout/ResizableSplit'
import { loadSimaFile, downloadSimaFile } from '@/lib/sima-parser'
import { PageHeader } from '@/components/layout/PageHeader'
import type { CoordinateType, StakeStatus } from '@/types/database'
import {
  STAKE_STATUS_OPTIONS,
  STAKE_STATUS_LABEL,
  STAKE_STATUS_BADGE,
} from '@/types/database'
import { STAKE_TYPE_OPTIONS } from '@/lib/stakeTypes'

// 数値入力用コンポーネント（入力中はフォーマットしない）
function NumberInput({
  value,
  onChange,
  onClick,
  className,
  placeholder,
  decimals = 3,
}: {
  value: number | null
  onChange: (value: number | null) => void
  onClick?: (e: React.MouseEvent) => void
  className?: string
  placeholder?: string
  decimals?: number
}) {
  const [localValue, setLocalValue] = useState<string>('')
  const [isFocused, setIsFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 外部の値が変更されたとき（フォーカスしていないときのみ更新）
  useEffect(() => {
    if (!isFocused) {
      if (value === null) {
        setLocalValue('')
      } else {
        setLocalValue(value.toFixed(decimals))
      }
    }
  }, [value, isFocused, decimals])

  const handleFocus = () => {
    setIsFocused(true)
    // フォーカス時は現在の数値をそのまま表示（末尾の0を削除）
    if (value !== null) {
      setLocalValue(String(value))
    }
  }

  const handleBlur = () => {
    setIsFocused(false)
    // フォーカスが外れたら数値に変換して親に通知
    if (localValue === '' || localValue === '-') {
      onChange(null)
      setLocalValue('')
    } else {
      const num = parseFloat(localValue)
      if (!isNaN(num)) {
        onChange(num)
        setLocalValue(num.toFixed(decimals))
      } else {
        // 不正な値は元に戻す
        setLocalValue(value !== null ? value.toFixed(decimals) : '')
      }
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setLocalValue(e.target.value)
  }

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      value={localValue}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onClick={onClick}
      className={className}
      placeholder={placeholder}
    />
  )
}

// 写真列のカウントセル: 枚数（0 でも）を表示し、クリックで写真モーダルを開く
function PhotoCountCell({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="写真を表示・追加"
      className={`relative inline-flex items-center justify-center gap-1 px-2 py-0.5 rounded border text-xs ${
        count > 0
          ? 'bg-blue-50 border-blue-300 text-blue-700 hover:bg-blue-100'
          : 'border-slate-200 text-slate-400 hover:bg-slate-50'
      }`}
    >
      <Camera className="h-3 w-3" />
      <span className="font-medium">{count > 99 ? '99+' : count}</span>
    </button>
  )
}

// 設置状態のセレクトセル。色付きバッジで現在状態を示し、クリックで切替。
function StakeStatusCell({
  value,
  onChange,
  measured,
}: {
  value: StakeStatus
  onChange: (next: StakeStatus) => void
  /** スマホで実測済 (staking_records にレコード有) 。バッジ右に小印で示す */
  measured: boolean
}) {
  return (
    <div className="flex items-center justify-center gap-1">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as StakeStatus)}
        onClick={(e) => e.stopPropagation()}
        title={
          measured
            ? `${STAKE_STATUS_LABEL[value]}（スマホで実測済）`
            : STAKE_STATUS_LABEL[value]
        }
        className={`px-1.5 py-0.5 text-[11px] font-medium border rounded cursor-pointer focus:ring-1 focus:ring-blue-400 focus:outline-none ${STAKE_STATUS_BADGE[value]}`}
      >
        {STAKE_STATUS_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {STAKE_STATUS_LABEL[s]}
          </option>
        ))}
      </select>
      {measured && (
        <Check
          className="h-3 w-3 text-emerald-500"
          aria-label="スマホで実測済み"
        />
      )}
    </div>
  )
}

// 貼り付けモーダルで指定する列の役割。
// 'ignore' は読み飛ばす列（地番など、座標一覧に取り込まない列）。
type ColumnRole = 'name' | 'x' | 'y' | 'z' | 'ignore'

const COLUMN_ROLE_OPTIONS: { value: ColumnRole; label: string }[] = [
  { value: 'name', label: '点名' },
  { value: 'x', label: 'X' },
  { value: 'y', label: 'Y' },
  { value: 'z', label: 'Z' },
  { value: 'ignore', label: '無視' },
]

// 区切り文字を判定（タブが多ければTSV、そうでなければCSV）
function detectDelimiter(line: string): '\t' | ',' {
  const tabCount = (line.match(/\t/g) || []).length
  const commaCount = (line.match(/,/g) || []).length
  return tabCount >= commaCount ? '\t' : ','
}

// 列数と先頭行の内容から、典型的なマッピングを決める。
//   2列 → X, Y
//   3列 → 先頭が数値なら X, Y, Z / そうでなければ 点名, X, Y
//   4列以上 → 点名, X, Y, Z, (以降は無視)
function buildDefaultMapping(firstRow: string[]): ColumnRole[] {
  const n = firstRow.length
  if (n <= 0) return []
  if (n === 1) return ['x']
  if (n === 2) return ['x', 'y']
  if (n === 3) {
    const first = firstRow[0]
    const firstIsNumber = /^-?\d+(\.\d+)?$/.test(first)
    return firstIsNumber ? ['x', 'y', 'z'] : ['name', 'x', 'y']
  }
  const result: ColumnRole[] = ['name', 'x', 'y', 'z']
  for (let i = 4; i < n; i++) result.push('ignore')
  return result
}

// プリセット定義。クリックで指定の役割並びを適用する。
// 列数が足りない場合は前から埋め、不足分は 'ignore' を補う。
const MAPPING_PRESETS: { label: string; mapping: ColumnRole[] }[] = [
  { label: '点名,X,Y,Z', mapping: ['name', 'x', 'y', 'z'] },
  { label: '点名,Y,X,Z', mapping: ['name', 'y', 'x', 'z'] },
  { label: '点名,X,Y',   mapping: ['name', 'x', 'y'] },
  { label: 'X,Y,Z',      mapping: ['x', 'y', 'z'] },
  { label: '地番,点名,X,Y', mapping: ['ignore', 'name', 'x', 'y'] },
]

// 貼り付けモーダルコンポーネント
function PasteModal({
  isOpen,
  onClose,
  onPaste,
  typeOptions,
}: {
  isOpen: boolean
  onClose: () => void
  onPaste: (text: string, type: CoordinateType, mapping: ColumnRole[], delimiter: '\t' | ',') => void
  typeOptions: { code: string; label: string }[]
}) {
  const [pasteText, setPasteText] = useState('')
  const [pasteType, setPasteType] = useState<CoordinateType>('boundary')
  const [columnMapping, setColumnMapping] = useState<ColumnRole[]>([])
  const [delimiter, setDelimiter] = useState<'\t' | ','>(',')
  // 自動検出済みの列数。列数が変わったときだけ既定マッピングをリセットし、
  // ユーザが選び直した内容を typing 中の再検出で潰さないようにする。
  const lastColCountRef = useRef(0)
  // 先頭行のプレビュー（区切り後の各値）
  const [firstRowCells, setFirstRowCells] = useState<string[]>([])

  useEffect(() => {
    const lines = pasteText.split('\n').filter((l) => l.trim())
    if (lines.length === 0) {
      setColumnMapping([])
      setFirstRowCells([])
      lastColCountRef.current = 0
      return
    }
    const first = lines[0]
    const d = detectDelimiter(first)
    setDelimiter(d)
    const cells = first.split(d).map((s) => s.trim())
    setFirstRowCells(cells)
    if (cells.length !== lastColCountRef.current) {
      setColumnMapping(buildDefaultMapping(cells))
      lastColCountRef.current = cells.length
    }
  }, [pasteText])

  if (!isOpen) return null

  const setRoleAt = (index: number, role: ColumnRole) => {
    setColumnMapping((prev) => {
      const next = [...prev]
      next[index] = role
      return next
    })
  }

  const applyPreset = (preset: ColumnRole[]) => {
    const n = firstRowCells.length || preset.length
    const next: ColumnRole[] = []
    for (let i = 0; i < n; i++) {
      next.push(i < preset.length ? preset[i] : 'ignore')
    }
    setColumnMapping(next)
  }

  const hasX = columnMapping.includes('x')
  const hasY = columnMapping.includes('y')
  const canSubmit = pasteText.trim().length > 0 && hasX && hasY

  const handleSubmit = () => {
    if (!canSubmit) return
    onPaste(pasteText, pasteType, columnMapping, delimiter)
    setPasteText('')
    setColumnMapping([])
    setFirstRowCells([])
    lastColCountRef.current = 0
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center" style={{ zIndex: 9999 }}>
      <div className="bg-white rounded-lg p-6 w-full max-w-2xl" style={{ zIndex: 10000 }}>
        <h3 className="text-lg font-semibold mb-4">座標データの貼り付け</h3>

        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">点種</label>
          <select
            value={pasteType}
            onChange={(e) => setPasteType(e.target.value as CoordinateType)}
            className="w-full px-3 py-2 border rounded"
          >
            {typeOptions.map((opt) => (
              <option key={opt.code} value={opt.code}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">
            座標データ（Excel/CSVからコピーして貼り付け）
          </label>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="点番号,X,Y,Z の形式でデータを貼り付けてください&#10;例:&#10;P1,-100.000,200.000,50.000&#10;P2,-150.000,250.000,51.000"
            className="w-full h-48 px-3 py-2 border rounded font-mono text-sm"
          />
        </div>

        {columnMapping.length > 0 && (
          <div className="mb-4 border rounded p-3 bg-slate-50">
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium">
                列の割り当て（{delimiter === '\t' ? 'TSV' : 'CSV'}・{columnMapping.length}列）
              </label>
              <div className="flex flex-wrap gap-1">
                {MAPPING_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => applyPreset(p.mapping)}
                    className="px-2 py-0.5 text-xs border rounded bg-white hover:bg-slate-100"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="text-xs border-collapse">
                <tbody>
                  <tr>
                    {columnMapping.map((_, i) => (
                      <td key={`h-${i}`} className="px-2 py-1 text-slate-500 text-center">
                        {i + 1}列目
                      </td>
                    ))}
                  </tr>
                  <tr>
                    {columnMapping.map((role, i) => (
                      <td key={`s-${i}`} className="px-2 py-1">
                        <select
                          value={role}
                          onChange={(e) => setRoleAt(i, e.target.value as ColumnRole)}
                          className="px-1 py-0.5 border rounded text-xs bg-white"
                        >
                          {COLUMN_ROLE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </td>
                    ))}
                  </tr>
                  <tr>
                    {firstRowCells.map((cell, i) => (
                      <td key={`p-${i}`} className="px-2 py-1 font-mono text-slate-700 border-t">
                        {cell || <span className="text-slate-300">(空)</span>}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            {!columnMapping.includes('z') && (
              <p className="mt-2 text-xs text-slate-500">
                Z 列が未割当のため、Z は 0 として取り込みます。
              </p>
            )}
            {(!hasX || !hasY) && (
              <p className="mt-2 text-xs text-red-600">
                X 列と Y 列を必ず割り当ててください。
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm border rounded hover:bg-gray-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            貼り付け
          </button>
        </div>
      </div>
    </div>
  )
}

export function CoordinatesPage() {
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null)
  const [showLabels, setShowLabels] = useState(true)
  // 地図上に地番（ポリゴン）名を表示するか。地番一覧と揃えるため既定 ON。
  const [showPolygonLabels, setShowPolygonLabels] = useState(true)
  // 点種フィルタ・オルソ表示・背景地図は地番管理と共有する mapViewStore に保持
  const visibleTypes = useMapViewStore((s) => s.visibleTypes)
  const visibleStakeStatuses = useMapViewStore((s) => s.visibleStakeStatuses)
  // 写真の撮影枚数フィルタ（ローカル state。地図側には反映しない）
  const [photoCountFilter, setPhotoCountFilter] = useState<PhotoCountFilter>('all')
  // 杭種フィルタ。'' は「未設定」を表す。option は coords + プリセット + 未設定。
  const [visibleStakeTypes, setVisibleStakeTypes] = useState<Set<string>>(new Set())
  // 座標出力の 2 段階フロー:
  //   ① 出力モード選択（全点 / 表示点 / 表示点順指定）
  //   ② フォーマット選択（CSV / SIMA / TSV / 写真帳 / Excel）
  // exportSource はモード選択後にセットされ、フォーマット選択時に消費する
  type ExportSource = 'all' | 'checked' | 'visible' | 'visible-ordered'
  type ExportFormat = 'csv' | 'tsv' | 'sima' | 'photobook' | 'photos' | 'excel'
  const [exportSource, setExportSource] = useState<ExportSource | null>(null)
  // フォーマット選択を先にする 2 段階フローに変更。
  // ① 座標出力ボタン → ② 出力フォーマット → ③ 出力対象（全/表示/順指定）
  const [pendingFormat, setPendingFormat] = useState<ExportFormat | null>(null)
  // 順指定モード中: 地図クリックで orderedIds に追加 / 表でドラッグ並べ替え
  const [orderSelectMode, setOrderSelectMode] = useState(false)
  const [orderedIds, setOrderedIds] = useState<string[]>([])
  // ドラッグ並べ替え中の行 ID
  const [draggingOrderId, setDraggingOrderId] = useState<string | null>(null)
  const setVisibleTypes = useMapViewStore((s) => s.setVisibleTypes)
  const showOrtho = useMapViewStore((s) => s.showOrtho)
  const setShowOrtho = useMapViewStore((s) => s.setShowOrtho)
  const [showPasteModal, setShowPasteModal] = useState(false)

  // チェックされた点のID（エクスポート対象）
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set())
  // 一括訂正モーダル
  const [showBulkEditModal, setShowBulkEditModal] = useState(false)
  // 一括座標計算モーダル（現状はスライド（平行移動）のみ）
  const [showBulkCalcModal, setShowBulkCalcModal] = useState(false)

  // ツールバーのドロップダウンメニュー（インポート / エクスポート / 点種フィルター）
  const [openMenu, setOpenMenu] = useState<'import' | 'export' | 'typeFilter' | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!openMenu) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenu(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [openMenu])

  // URLパラメータをチェック（ポップアウトモード）
  const urlParams = new URLSearchParams(window.location.search)
  const viewMode = urlParams.get('view') // 'map' または 'table'

  const { currentFarm } = useFarmStore()
  const navigate = useNavigate()
  const { projects, members, fetchMembers } = useProjectListStore()

  // 法務省地図 (地番マップ) の背景レイヤ。トグル状態は mapViewStore で全ページ共有。
  // isCadastralProject ゲートは廃止し、土木プロジェクトでも同じ地番背景を使えるようにする。
  const parcelDatasets = useParcelMapDatasetStore((s) => s.datasets)
  const fetchParcelDatasets = useParcelMapDatasetStore((s) => s.fetchAll)
  const hasActiveParcelDataset = parcelDatasets.some((d) => d.active)
  const showParcelLayer = useMapViewStore((s) => s.showParcelMap)
  const setShowParcelLayer = useMapViewStore((s) => s.setShowParcelMap)
  useEffect(() => {
    void fetchParcelDatasets()
  }, [fetchParcelDatasets])
  const { fetchByEntityIds: fetchAttachments, getSignedUrl } = useAttachmentStore()
  const attachmentsByEntity = useAttachmentStore((s) => s.byEntity)
  const { workAreas, fetchWorkAreas } = useWorkAreaStore()
  // 地番ラベル用に parcels を引いておく（境界測量の workArea 単位）。
  // 表示は polygon name のフォールバックチェーン: parcel_number > zoneNumber > name。
  const parcelByWorkAreaId = useParcelStore((s) => s.byWorkAreaId)
  const fetchParcels = useParcelStore((s) => s.fetchByWorkAreaIds)
  // 更新者ID → 表示名（プロジェクトメンバーから引く）
  const memberNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const mb of members) {
      const name = (mb.display_name && mb.display_name.trim()) || mb.email || mb.user_id
      m.set(mb.user_id, name)
    }
    return m
  }, [members])
  // currentFarm.project_id が決まったらメンバーを取得（更新者名表示用）
  useEffect(() => {
    const pid = currentFarm?.project_id
    if (pid) fetchMembers(pid)
  }, [currentFarm?.project_id, fetchMembers])
  // 更新日時を「YYYY-MM-DD HH:mm」のローカル時刻でコンパクト表示
  const fmtDateTime = (iso: string | null): string => {
    if (!iso) return '-'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '-'
    const pad = (n: number) => n.toString().padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  // 座標計算モーダル
  const [showCalcModal, setShowCalcModal] = useState(false)
  // 座標計算で地図から点選択中の割り当て関数（null=非選択中）
  const [calcAssign, setCalcAssign] = useState<((id: string) => void) | null>(null)
  // 座標計算で境界線（辺）選択中の割り当て関数（2点の座標IDを返す）
  const [calcLineAssign, setCalcLineAssign] = useState<((id1: string, id2: string) => void) | null>(null)
  // 区域の表示レイヤ（表示する工種コードの集合）
  const [visibleWorkTypes, setVisibleWorkTypes] = useState<Set<string>>(new Set())
  // 手入力・計算追加時に末尾行へスクロールするための ref
  const lastRowRef = useRef<HTMLTableRowElement | null>(null)
  // 末尾の空行（手入力用）
  const [newRow, setNewRow] = useState<{
    pointNumber: string; x: string; y: string; z: string; type: string; stakeType: string
  }>(
    { pointNumber: '', x: '', y: '', z: '', type: '', stakeType: '' },
  )
  // 写真帳出力の進捗（null=非実行）
  const [photoExporting, setPhotoExporting] = useState<{ done: number; total: number } | null>(null)
  // 写真帳ひな形の選択ダイアログ
  const [showPhotoBookChooser, setShowPhotoBookChooser] = useState(false)
  const [photoBookTemplateId, setPhotoBookTemplateId] = useState<string>(() => {
    const saved = localStorage.getItem('photoBook:templateId')
    return PHOTO_BOOK_TEMPLATES.some((t) => t.id === saved) ? (saved as string) : PHOTO_BOOK_TEMPLATES[0].id
  })
  const {
    zone,
    setZone,
    coordinates,
    fetchCoordinates,
    loadingProgress: coordLoadingProgress,
    updateCoordinate,
    deleteCoordinate,
    deleteCoordinates,
    importCoordinates,
    selectedType,
    setSelectedType,
    route,
    routeHasChanges,
    fetchRoute,
    appendRoutePoint,
    removeRoutePoint,
    setRouteDirection,
    moveRoutePoint,
    clearRoute,
    saveRoute,
    setStakeStatus,
  } = useCoordinateStore()

  // 経路モード（クリックで経路に追加）
  const [routeMode, setRouteMode] = useState(false)
  // 現在編集中の route の name (保存時のキー、既定は '既定')
  const [routeName, setRouteName] = useState('既定')
  // 経路パネル折りたたみ (地図が見えにくい時用)
  const [routePanelCollapsed, setRoutePanelCollapsed] = useState(false)

  // 現在の工区が属するプロジェクトの座標系
  const projectZone = currentFarm
    ? projects.find((p) => p.id === currentFarm.project_id)?.coordinate_zone ?? null
    : null

  // プロジェクト単位のカスタム点種
  const projectId = currentFarm?.project_id ?? null
  const {
    byProject: pointTypesByProject,
    fetchForProject: fetchPointTypes,
    addType: addPointType,
    removeType: removePointType,
  } = useCoordinatePointTypeStore()
  useEffect(() => {
    if (projectId) fetchPointTypes(projectId)
  }, [projectId, fetchPointTypes])
  const typeOptions = useMemo(
    () => getCoordinateTypeOptions(projectId, pointTypesByProject),
    [projectId, pointTypesByProject],
  )
  const [showPointTypeModal, setShowPointTypeModal] = useState(false)

  // 写真モーダル: 開いている座標 ID
  const [photoCoordId, setPhotoCoordId] = useState<string | null>(null)
  // 地図右下の折りたたみ写真パネルの開閉
  const [photoPanelOpen, setPhotoPanelOpen] = useState(false)
  // 座標クリック時に自動でパネルを開く。手動で閉じたら再オープンしない (userClosedRef で追跡)
  const userClosedPhotoPanelRef = useRef(false)

  // 新しく追加されたカスタム点種は既定で表示する。
  // 加えて、実データに存在する点種コードが visibleTypes に含まれていない場合も
  // 自動で追加する（旧スキーマの 'reference' / 'outer_boundary' 等が
  // フィルタで弾かれて全座標が見えなくなる事故を防ぐ）。
  // 空文字 '' (点種未指定) も既定で表示集合に含めて、空の座標が
  // フィルタで隠れないようにする。
  useEffect(() => {
    const cur = useMapViewStore.getState().visibleTypes
    const next = new Set(cur)
    let changed = false
    if (!next.has('')) {
      next.add('')
      changed = true
    }
    for (const opt of typeOptions) {
      if (!next.has(opt.code)) {
        next.add(opt.code)
        changed = true
      }
    }
    for (const c of coordinates) {
      const code = c.type ?? ''
      if (!next.has(code)) {
        next.add(code)
        changed = true
      }
    }
    if (changed) setVisibleTypes(next)
  }, [typeOptions, coordinates, setVisibleTypes])

  // 杭種フィルターの選択肢: '未設定' + プリセット + 現在使われているカスタム値
  const stakeTypeOptions = useMemo(() => {
    const set = new Set<string>([''])
    for (const c of coordinates) set.add(c.stakeType || '')
    for (const p of STAKE_TYPE_OPTIONS) set.add(p.label)
    return Array.from(set).map((code) => ({
      code,
      label: code === '' ? '未設定' : code,
    }))
  }, [coordinates])

  // 新しく出現した杭種は既定で表示（全選択）する
  useEffect(() => {
    setVisibleStakeTypes((prev) => {
      const next = new Set(prev)
      let changed = false
      for (const opt of stakeTypeOptions) {
        if (!next.has(opt.code)) {
          next.add(opt.code)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [stakeTypeOptions])

  // 表に表示する座標の最終リスト。
  // orderSelectMode 中は orderedIds の順番で先頭に並べ、残りは元順で末尾に。
  // それ以外は filteredCoordinates をそのまま。
  // （useMemo 定義は filteredCoordinates / orderedIds 定義の後）
  // 点種フィルターを適用した表示用座標。表とマップで共有する。
  const filteredCoordinates = useMemo(
    () =>
      coordinates.filter((c) => {
        if (!visibleTypes.has(c.type)) return false
        if (!visibleStakeStatuses.has(c.stakeStatus)) return false
        if (!visibleStakeTypes.has(c.stakeType || '')) return false
        if (photoCountFilter !== 'all') {
          const photoCount = attachmentsByEntity.get(`coordinate:${c.id}`)?.length ?? 0
          if (photoCountFilter === 'with' && photoCount === 0) return false
          if (photoCountFilter === 'without' && photoCount > 0) return false
        }
        return true
      }),
    [
      coordinates,
      visibleTypes,
      visibleStakeStatuses,
      visibleStakeTypes,
      photoCountFilter,
      attachmentsByEntity,
    ],
  )

  // 地図のマーカーに同じフィルタを効かせるための ID 集合（杭種・写真有無等も含む）
  const filteredCoordinateIdSet = useMemo(
    () => new Set(filteredCoordinates.map((c) => c.id)),
    [filteredCoordinates],
  )

  // 出力順指定モード中、orderedIds に入っている座標をマーカーでオレンジ強調
  const orangeCoordIds = useMemo<Set<string> | undefined>(() => {
    if (!orderSelectMode || orderedIds.length === 0) return undefined
    return new Set(orderedIds)
  }, [orderSelectMode, orderedIds])

  // 表に表示する座標の最終リスト。
  // 順指定モード中: orderedIds の順番で先頭に並べ、残りは元順で末尾にグレー表示
  const displayCoordinates = useMemo(() => {
    if (!orderSelectMode) return filteredCoordinates
    const orderedSet = new Set(orderedIds)
    const byId = new Map(filteredCoordinates.map((c) => [c.id, c]))
    const orderedCoords: CoordinateRow[] = []
    for (const id of orderedIds) {
      const c = byId.get(id)
      if (c) orderedCoords.push(c)
    }
    const rest = filteredCoordinates.filter((c) => !orderedSet.has(c.id))
    return [...orderedCoords, ...rest]
  }, [orderSelectMode, filteredCoordinates, orderedIds])

  // スマホから記録された staking_records を取得し、「設置済」フラグに使う
  const stakingRecords = useStakingStore((s) => s.records)
  const fetchStakingRecords = useStakingStore((s) => s.fetchRecords)
  // 座標 ID → 設置済 (この coord に紐づく staking_records が 1 件でもあるか)
  const stakedCoordIds = useMemo(() => {
    const set = new Set<string>()
    for (const r of stakingRecords) {
      if (r.targetType === 'coordinate' && r.targetRefId) {
        set.add(r.targetRefId)
      }
    }
    return set
  }, [stakingRecords])

  // 工区メモ
  const farmMemos = useFarmMemoStore((s) =>
    currentFarm ? s.byFarm.get(currentFarm.id) ?? EMPTY_FARM_MEMOS : EMPTY_FARM_MEMOS,
  )
  const fetchFarmMemos = useFarmMemoStore((s) => s.fetchByFarm)
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

  // 暗渠 (pipes) を読み込む。座標管理では読み取り専用でオーバーレイ表示するのみ。
  const fetchPipes = useUnderdrainStore((s) => s.fetchPipes)
  const pipes = useUnderdrainStore((s) => s.pipes)
  const [showPipes, setShowPipes] = useState(true)

  // 工区選択時にデータを読み込む
  useEffect(() => {
    if (currentFarm && projectZone !== null) {
      // プロジェクトの座標系を設定
      setZone(projectZone)
      // Supabaseからデータを読み込む
      fetchCoordinates(currentFarm.id)
      // 経路を読み込む
      fetchRoute(currentFarm.id)
      // スマホ実測の状態
      fetchStakingRecords(currentFarm.id)
      // 工区メモ
      void fetchFarmMemos(currentFarm.id)
      // 工区写真（スマホで撮影した位置・方向付き写真をマーカー表示するため）
      void fetchAttachments('farm_photo', [currentFarm.id])
      // 暗渠 (見えるだけ、編集は暗渠モジュールから)
      void fetchPipes(currentFarm.id)
    }
  }, [currentFarm, projectZone, setZone, fetchCoordinates, fetchRoute, fetchStakingRecords, fetchFarmMemos, fetchAttachments, fetchPipes])

  // 実測記録 (staking_records) を地図表示。座標記録と同様にマーカー + ラベル。
  const [showStakingRecords, setShowStakingRecords] = useState(true)
  const stakingOverlay = useMemo(() => {
    if (projectZone == null) return [] as Array<{
      key: string
      lat: number
      lng: number
      label: string
      color: string
      fillColor: string
    }>
    const conv = new CoordinateConverter(projectZone)
    const out: Array<{
      key: string
      lat: number
      lng: number
      label: string
      color: string
      fillColor: string
    }> = []
    for (const r of stakingRecords) {
      if (r.measuredX == null || r.measuredY == null) continue
      try {
        const { lat, lng } = conv.toLatLng(r.measuredX, r.measuredY)
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
        // 起工 (initial) は青系、出来形 (asbuilt) は緑系で色分け
        const isAsbuilt = r.surveyCategory === 'asbuilt'
        out.push({
          key: `sr-${r.id}`,
          lat,
          lng,
          label: r.targetName ?? '(名無し)',
          color: isAsbuilt ? '#065f46' : '#1e3a8a',
          fillColor: isAsbuilt ? '#34d399' : '#60a5fa',
        })
      } catch {
        /* skip */
      }
    }
    return out
  }, [stakingRecords, projectZone])

  // 暗渠 pipes を lat/lng に変換したオーバーレイデータ
  const pipeOverlay = useMemo(() => {
    if (projectZone == null) return { lines: [], vertices: [] as Array<{
      key: string
      lat: number
      lng: number
      label: string
    }> }
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
          /* skip malformed */
        }
      }
      if (positions.length >= 2) {
        lines.push({ id: pipe.id, positions })
      }
    }
    return { lines, vertices }
  }, [pipes, projectZone])

  // 工区写真（マーカー描画 + Popup サムネ用）
  const farmPhotosForMap = useMemo(() => {
    if (!currentFarm) return [] as Array<{
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

  // 座標が読み込まれたら、写真の枚数を一括取得（写真列のカウント表示用）
  useEffect(() => {
    if (coordinates.length === 0) return
    fetchAttachments('coordinate', coordinates.map((c) => c.id))
  }, [coordinates, fetchAttachments])

  // グローバル保存レジストリに経路保存を登録
  const routeSaveRef = useRef(saveRoute)
  routeSaveRef.current = saveRoute
  useEffect(() => {
    const { register, unregister } = useGlobalSaveRegistry.getState()
    register('coordinate-route', {
      hasChanges: routeHasChanges,
      save: () => routeSaveRef.current(),
    })
    return () => {
      unregister('coordinate-route')
    }
  }, [routeHasChanges])

  // 座標計算の結果を新規点として追加
  const handleCalcAdd = (p: { pointNumber: string; x: number; y: number; type: string }) => {
    importCoordinates([
      { pointNumber: p.pointNumber, x: p.x, y: p.y, z: null, type: p.type as CoordinateType },
    ])
    setTimeout(() => lastRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80)
  }

  // 区域（工事区域）を取得
  useEffect(() => {
    if (currentFarm) fetchWorkAreas(currentFarm.id)
  }, [currentFarm, fetchWorkAreas])

  // 境界測量の地番（parcels）を一括取得しておく。地図上のポリゴン名に使う
  const boundaryAreaIds = useMemo(() => {
    const arr = workAreas['boundary_survey'] ?? []
    return arr.map((a) => a.id)
  }, [workAreas])
  useEffect(() => {
    if (boundaryAreaIds.length > 0) void fetchParcels(boundaryAreaIds)
  }, [boundaryAreaIds.join(','), fetchParcels])

  // 区域が登録されている工種は既定で表示ON
  const availableWorkTypes = useMemo(
    () =>
      (Object.entries(workAreas) as [string, { id: string }[] | undefined][])
        .filter(([, a]) => a && a.length > 0)
        .map(([wt]) => wt),
    [workAreas],
  )
  useEffect(() => {
    setVisibleWorkTypes((prev) => {
      const next = new Set(prev)
      let changed = false
      for (const wt of availableWorkTypes) {
        if (!next.has(wt)) {
          next.add(wt)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [availableWorkTypes])

  // 表示する区域ポリゴン（CoordinateMap の externalPolygons 用）
  const workAreaPolygons = useMemo<ExternalPolygon[]>(() => {
    const out: ExternalPolygon[] = []
    for (const [wt, areas] of Object.entries(workAreas) as [
      string,
      { id: string; name: string; zoneNumber: string; points: WorkAreaPoint[] }[] | undefined,
    ][]) {
      if (!areas || !visibleWorkTypes.has(wt)) continue
      for (const area of areas) {
        const pts = area.points.filter((p) => p.lat !== null && p.lng !== null)
        const positions = pts.map((p) => [p.lat as number, p.lng as number] as [number, number])
        if (positions.length >= 3) {
          // ポリゴン名のフォールバック: 地番(parcels) > zoneNumber > name
          // 境界測量は parcels.parcel_number、それ以外は zoneNumber か name を使う
          const parcelNumber = parcelByWorkAreaId.get(area.id)?.parcel_number ?? null
          const label = parcelNumber || area.zoneNumber || area.name || ''
          out.push({
            id: area.id,
            name: label,
            positions,
            pointIds: pts.map((p) => p.id),
          })
        }
      }
    }
    return out
  }, [workAreas, visibleWorkTypes, parcelByWorkAreaId])

  const toggleWorkType = (wt: string) =>
    setVisibleWorkTypes((prev) => {
      const next = new Set(prev)
      if (next.has(wt)) next.delete(wt)
      else next.add(wt)
      return next
    })

  const handleImportCSV = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target?.result as string
      const lines = text.split('\n').filter(line => line.trim())

      const newCoords = lines.slice(1).map((line, idx) => {
        const [pointNumber, x, y, z] = line.split(',').map(s => s.trim())
        return {
          pointNumber: pointNumber || `P${idx + 1}`,
          x: parseFloat(x) || 0,
          y: parseFloat(y) || 0,
          z: z ? parseFloat(z) : null,
          type: selectedType,
        }
      })

      importCoordinates(newCoords)
    }
    reader.readAsText(file)
    event.target.value = ''
  }

  const handleImportSIMA = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const result = await loadSimaFile(file)

      const newCoords = result.coordinates.map((coord) => ({
        pointNumber: coord.pointNumber,
        x: coord.x,
        y: coord.y,
        z: coord.z,
        type: selectedType,
      }))

      importCoordinates(newCoords)

      // SIMAファイルに座標系情報があり、プロジェクトの座標系と異なる場合は警告
      if (result.system !== null && projectZone !== null && result.system !== projectZone) {
        const simaZoneName = JGD2011_ZONES[result.system]?.name ?? `第${result.system}系`
        const projectZoneName = JGD2011_ZONES[projectZone]?.name ?? `第${projectZone}系`
        alert(
          `SIMAファイルの座標系（${simaZoneName}）がプロジェクトの座標系（${projectZoneName}）と異なります。\n` +
            `座標値はプロジェクトの座標系として読み込まれました。必要であればプロジェクト設定を変更してください。`
        )
      }
    } catch (error) {
      console.error('SIMAファイルの読み込みに失敗しました:', error)
      alert('SIMAファイルの読み込みに失敗しました')
    }

    event.target.value = ''
  }

  // エクスポート対象:
  //   source='all'              → 全座標
  //   source='visible'          → フィルタ後の表示座標
  //   source='visible-ordered'  → orderedIds の順番で並べた表示座標
  //   source=null               → 念のためチェック済 or 全件（旧挙動）
  const getExportTargets = (source: ExportSource | null = exportSource): CoordinateRow[] => {
    if (source === 'all') return coordinates
    if (source === 'checked') return coordinates.filter((c) => checkedIds.has(c.id))
    if (source === 'visible-ordered') {
      const byId = new Map(coordinates.map((c) => [c.id, c]))
      return orderedIds
        .map((id) => byId.get(id))
        .filter((c): c is CoordinateRow => !!c)
    }
    if (source === 'visible') return filteredCoordinates
    if (checkedIds.size === 0) return coordinates
    return coordinates.filter((c) => checkedIds.has(c.id))
  }

  const handleExportCSV = (source?: ExportSource) => {
    const targets = getExportTargets(source)
    if (targets.length === 0) return
    const header = '点番号,X,Y,Z,緯度,経度,種類\n'
    const rows = targets.map(c => {
      // 既定 + カスタム点種のラベルを参照
      const typeName =
        typeOptions.find((o) => o.code === c.type)?.label ?? c.type ?? '不明'
      return `${c.pointNumber},${c.x},${c.y},${c.z ?? ''},${c.lat ?? ''},${c.lng ?? ''},${typeName}`
    }).join('\n')

    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'coordinates.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleExportSIMA = (source?: ExportSource) => {
    const targets = getExportTargets(source)
    if (targets.length === 0) return
    const projectName = currentFarm?.name || 'NoName'
    downloadSimaFile(
      {
        projectName,
        zone,
        points: targets.map((c) => ({
          pointNumber: c.pointNumber,
          x: c.x,
          y: c.y,
          z: c.z,
        })),
      },
      `${projectName}_coordinates.sim`,
    )
  }

  const handleExportExcel = () => {
    alert('Excel 出力は実装予定です')
  }

  // 選択座標を TSV（点名 / X / Y / Z）でクリップボードへコピー。
  // ヘッダなし。Excel に貼り付けでセルに分解される。
  const handleCopyTSV = async (source?: ExportSource) => {
    const targets = getExportTargets(source)
    if (targets.length === 0) return
    const fmt = (n: number | null | undefined) =>
      n === null || n === undefined || !Number.isFinite(n) ? '' : String(n)
    const tsv = targets
      .map((c) => [c.pointNumber, fmt(c.x), fmt(c.y), fmt(c.z)].join('\t'))
      .join('\r\n')
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(tsv)
      } else {
        // フォールバック（http コンテキスト等）
        const ta = document.createElement('textarea')
        ta.value = tsv
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      alert(`${targets.length} 点を TSV としてクリップボードにコピーしました。`)
    } catch (e) {
      alert('クリップボードへのコピーに失敗しました: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  // 登録済み写真を JPG でダウンロード。
  //   1 枚のみ → そのまま .jpg
  //   2 枚以上 → ZIP に格納
  // ファイル名は `{点名}_{写真種別}` (.jpg)。同じ (点名, 種別) で複数枚あれば連番。
  const handleExportPhotos = async (source?: ExportSource) => {
    const targets = getExportTargets(source ?? null)
    if (targets.length === 0) {
      alert('座標がありません')
      return
    }
    setPhotoExporting({ done: 0, total: 0 })
    try {
      await fetchAttachments('coordinate', targets.map((c) => c.id))
      const byEntity = useAttachmentStore.getState().byEntity
      // 出力する写真リストを構築（点名 → 写真）
      interface Item {
        pointNumber: string
        category: string
        filePath: string
      }
      const items: Item[] = []
      for (const c of targets) {
        const photos = byEntity.get(`coordinate:${c.id}`) ?? []
        for (const p of photos) {
          items.push({
            pointNumber: c.pointNumber,
            category: p.category ?? '写真',
            filePath: p.filePath,
          })
        }
      }
      if (items.length === 0) {
        alert('写真が登録された座標がありません')
        setPhotoExporting(null)
        return
      }

      // ファイル名のサニタイズ（Windows/Mac で問題になる文字を _ へ）
      const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_')

      // 同じ (点名, 種別) 内で連番を振る
      const seq = new Map<string, number>()
      const named: Array<{ name: string; filePath: string }> = items.map((it) => {
        const base = `${safe(it.pointNumber)}_${safe(it.category)}`
        const n = (seq.get(base) ?? 0) + 1
        seq.set(base, n)
        const name = n === 1 ? `${base}.jpg` : `${base}_${n}.jpg`
        return { name, filePath: it.filePath }
      })

      // 画像取得
      setPhotoExporting({ done: 0, total: named.length })
      const fetched: Array<{ name: string; blob: Blob | null }> = []
      let done = 0
      for (const it of named) {
        try {
          const url = await getSignedUrl(it.filePath)
          if (!url) {
            fetched.push({ name: it.name, blob: null })
          } else {
            const res = await fetch(url)
            const blob = res.ok ? await res.blob() : null
            fetched.push({ name: it.name, blob })
          }
        } catch {
          fetched.push({ name: it.name, blob: null })
        }
        done++
        setPhotoExporting({ done, total: named.length })
      }
      const usable = fetched.filter((x): x is { name: string; blob: Blob } => x.blob !== null)
      if (usable.length === 0) {
        alert('写真の取得に失敗しました')
        setPhotoExporting(null)
        return
      }

      const projName = projects.find((p) => p.id === currentFarm?.project_id)?.name ?? ''
      const farmName = currentFarm?.name ?? ''
      const baseDownloadName = `写真_${safe(farmName) || 'export'}`

      if (usable.length === 1) {
        // 1 枚 → そのまま JPG
        const u = URL.createObjectURL(usable[0].blob)
        const a = document.createElement('a')
        a.href = u
        a.download = usable[0].name
        a.click()
        URL.revokeObjectURL(u)
      } else {
        // 複数 → ZIP
        const { default: JSZip } = await import('jszip')
        const zip = new JSZip()
        for (const f of usable) zip.file(f.name, f.blob)
        // README として簡単なメタ情報も入れる
        zip.file(
          '_README.txt',
          [
            `工区: ${farmName}`,
            projName ? `プロジェクト: ${projName}` : '',
            `出力日: ${new Date().toLocaleString('ja-JP')}`,
            `写真数: ${usable.length}`,
            `命名規則: 点名_写真種別.jpg（同名複数は連番）`,
          ]
            .filter(Boolean)
            .join('\n'),
        )
        const blob = await zip.generateAsync({ type: 'blob' })
        const u = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = u
        a.download = `${baseDownloadName}.zip`
        a.click()
        URL.revokeObjectURL(u)
      }
    } catch (e) {
      alert('写真出力に失敗しました: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setPhotoExporting(null)
    }
  }

  // 写真帳（遠景・近景写真を貼り付けた Excel）を出力。ひな形を指定
  const handleExportPhotoBook = async (template: PhotoBookTemplate) => {
    const targets = getExportTargets()
    if (targets.length === 0) {
      alert('座標がありません')
      return
    }
    setPhotoExporting({ done: 0, total: 0 })
    try {
      // 対象座標の写真をまとめて取得
      await fetchAttachments('coordinate', targets.map((c) => c.id))
      const byEntity = useAttachmentStore.getState().byEntity
      const catOrder = ['遠景', '近景']
      const points = targets
        .map((c) => {
          const photos = (byEntity.get(`coordinate:${c.id}`) ?? [])
            .slice()
            .sort((a, b) => {
              const ai = catOrder.indexOf(a.category ?? '')
              const bi = catOrder.indexOf(b.category ?? '')
              const aa = ai === -1 ? 99 : ai
              const bb = bi === -1 ? 99 : bi
              if (aa !== bb) return aa - bb
              return a.sortOrder - b.sortOrder
            })
            .map((a) => ({
              category: a.category ?? '写真',
              caption: a.caption,
              takenAt: a.takenAt,
              filePath: a.filePath,
            }))
          const typeLabel = typeOptions.find((o) => o.code === c.type)?.label
          const statusLabel = STAKE_STATUS_LABEL[c.stakeStatus] ?? null
          return {
            name: c.pointNumber,
            subtitle: typeLabel,
            stakeType: c.stakeType ?? null,
            stakeStatus: statusLabel,
            photos,
          }
        })
        .filter((p) => p.photos.length > 0)

      if (points.length === 0) {
        alert('写真が登録された座標がありません')
        setPhotoExporting(null)
        return
      }

      const resolveImage = async (filePath: string): Promise<ArrayBuffer | null> => {
        try {
          const url = await getSignedUrl(filePath)
          if (!url) return null
          const res = await fetch(url)
          if (!res.ok) return null
          return await res.arrayBuffer()
        } catch {
          return null
        }
      }

      const projName = projects.find((p) => p.id === currentFarm?.project_id)?.name ?? ''
      const farmName = currentFarm?.name ?? ''
      const blob = await generatePhotoBookExcel({
        title: `写真帳　${projName ? projName + ' / ' : ''}${farmName}`,
        subtitle: `出力日: ${new Date().toLocaleDateString('ja-JP')}　／　点数: ${points.length}　／　ひな形: ${template.label}`,
        points,
        template,
        resolveImage,
        onProgress: (done, total) => setPhotoExporting({ done, total }),
      })

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `写真帳_${farmName || 'export'}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      alert('写真帳の出力に失敗しました: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setPhotoExporting(null)
    }
  }

  // フォーマット + 対象 を確定して実際の出力を実行する。
  // 写真帳のときはテンプレ選択モーダルを開く流れになるため、exportSource を
  // 設定したまま chooser を開き、handleExportPhotoBook が読む。
  const executeExport = (format: ExportFormat, source: ExportSource) => {
    if (format === 'photobook') {
      setExportSource(source)
      setShowPhotoBookChooser(true)
      setOpenMenu(null)
      setPendingFormat(null)
      return
    }
    if (format === 'csv') handleExportCSV(source)
    else if (format === 'tsv') void handleCopyTSV(source)
    else if (format === 'sima') handleExportSIMA(source)
    else if (format === 'photos') void handleExportPhotos(source)
    else if (format === 'excel') handleExportExcel()
    setOpenMenu(null)
    setPendingFormat(null)
    setExportSource(null)
  }

  // チェック関連
  const allChecked = coordinates.length > 0 && coordinates.every((c) => checkedIds.has(c.id))
  const toggleCheck = (id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleCheckAll = () => {
    if (allChecked) {
      setCheckedIds(new Set())
    } else {
      setCheckedIds(new Set(coordinates.map((c) => c.id)))
    }
  }

  // 単点の削除（確認付き）
  const handleDeleteOne = async (id: string, label: string) => {
    if (!confirm(`点「${label}」を削除します。よろしいですか？`)) return
    await deleteCoordinate(id)
    setCheckedIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  // 選択削除（複数）
  const handleBulkDelete = async () => {
    if (checkedIds.size === 0) return
    if (!confirm(`選択した ${checkedIds.size} 点を削除します。よろしいですか？`)) return
    // 1 件ずつではなく in() 一括削除（100 件チャンク）
    await deleteCoordinates(Array.from(checkedIds))
    setCheckedIds(new Set())
  }

  // 選択点に一括訂正を適用する。null=変更なし、undefined はキー自体を渡さない。
  const applyBulkEdit = (patch: {
    type?: string
    stakeType?: string | null
    stakeStatus?: StakeStatus
  }) => {
    if (checkedIds.size === 0) return
    for (const id of Array.from(checkedIds)) {
      if (patch.type !== undefined) updateCoordinate(id, 'type', patch.type)
      if (patch.stakeType !== undefined) updateCoordinate(id, 'stakeType', patch.stakeType)
      if (patch.stakeStatus !== undefined)
        updateCoordinate(id, 'stakeStatus', patch.stakeStatus)
    }
  }

  // 一括操作バー（チェック時のみ表示）
  const renderBulkBar = () => {
    if (checkedIds.size === 0) return null
    return (
      <div className="px-3 py-1.5 bg-blue-50 border-b border-blue-200 flex items-center gap-2 text-xs">
        <span className="font-medium text-blue-700">{checkedIds.size} 点選択中</span>
        <span className="text-slate-300">|</span>
        <button
          onClick={() => setShowBulkEditModal(true)}
          className="flex items-center gap-1 px-2 py-0.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
          title="選択中の点種 / 杭種 / 設置状態をまとめて変更"
        >
          <Pencil className="h-3 w-3" />
          一括訂正
        </button>
        <button
          onClick={() => setShowBulkCalcModal(true)}
          title="選択中の点に対する座標計算（スライド / 平行移動 等）"
          className="flex items-center gap-1 px-2 py-0.5 text-xs border border-blue-600 text-blue-700 rounded hover:bg-blue-50"
        >
          <Calculator className="h-3 w-3" />
          座標計算
        </button>
        <button
          onClick={handleBulkDelete}
          className="ml-auto flex items-center gap-1 px-2 py-0.5 text-xs bg-red-600 text-white rounded hover:bg-red-700"
        >
          <Trash2 className="h-3 w-3" />
          選択削除
        </button>
        <button
          onClick={() => setCheckedIds(new Set())}
          className="px-2 py-0.5 text-xs border border-slate-300 rounded hover:bg-white"
        >
          選択解除
        </button>
      </div>
    )
  }

  // モーダルからのペースト処理。
  // PasteModal で指定された列マッピングに従って、各列を 点名/X/Y/Z/無視 に割り当てる。
  // Z 列が未割当のときは Z=0 として取り込む（点名,X,Y のみの貼り付け対応）。
  const handleModalPaste = useCallback((
    text: string,
    pasteType: CoordinateType,
    mapping: ColumnRole[],
    delimiter: '\t' | ',',
  ) => {
    if (!text) return
    const lines = text.split('\n').filter((line) => line.trim())
    if (lines.length === 0) return

    const xIdx = mapping.indexOf('x')
    const yIdx = mapping.indexOf('y')
    const zIdx = mapping.indexOf('z')
    const nameIdx = mapping.indexOf('name')
    if (xIdx < 0 || yIdx < 0) return

    const newCoords = lines.map((line, idx) => {
      const parts = line.split(delimiter).map((s) => s.trim())
      const xRaw = parts[xIdx] ?? ''
      const yRaw = parts[yIdx] ?? ''
      const x = parseFloat(xRaw)
      const y = parseFloat(yRaw)
      if (Number.isNaN(x) || Number.isNaN(y)) return null

      let z: number | null
      if (zIdx >= 0) {
        const zRaw = parts[zIdx] ?? ''
        const zVal = parseFloat(zRaw)
        z = Number.isNaN(zVal) ? 0 : zVal
      } else {
        z = 0
      }

      const fallbackName = `P${coordinates.length + idx + 1}`
      const pointNumber = nameIdx >= 0
        ? ((parts[nameIdx] ?? '').trim() || fallbackName)
        : fallbackName

      return {
        pointNumber,
        x,
        y,
        z,
        type: pasteType,
      }
    }).filter((c): c is NonNullable<typeof c> => c !== null)

    if (newCoords.length > 0) {
      importCoordinates(newCoords)
    }
  }, [coordinates.length, importCoordinates])

  // 地図マーカーで Ctrl/⌘ + クリック されたときに 表のチェック状態をトグルする
  const handlePointToggleCheck = (id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 点がクリックされたとき
  const handlePointClick = (id: string) => {
    // 座標計算で地図から点を選択中なら、その点を割り当てて通常選択はしない
    if (calcAssign) {
      calcAssign(id)
      return
    }
    // 出力順指定モード中: 表示点のみ orderedIds にトグル
    if (orderSelectMode) {
      const inFiltered = filteredCoordinates.some((c) => c.id === id)
      setOrderedIds((prev) => {
        if (prev.includes(id)) return prev.filter((x) => x !== id)
        if (!inFiltered) return prev
        return [...prev, id]
      })
      setSelectedPointId(id)
      return
    }
    setSelectedPointId(id)
    // 経路モード中は写真パネルを開かない (連続で経路を組めるようにする)。
    // ユーザーが直近で明示的に閉じた場合も開かない。
    if (routeMode) {
      appendRoutePoint(id, 'down')
    } else if (!userClosedPhotoPanelRef.current) {
      setPhotoPanelOpen(true)
    }
  }

  // selectedPointId が変わったら、座標一覧の該当行が画面外にあれば
  // スクロールして表示する（地図のマーカークリックで選択された時など）。
  // 一覧内クリックで選んだ場合は block: 'nearest' なのでほぼ無視される。
  useEffect(() => {
    if (!selectedPointId) return
    const row = document.querySelector(
      `[data-coord-row-id="${CSS.escape(selectedPointId)}"]`,
    )
    if (row instanceof HTMLElement) {
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [selectedPointId])

  // 末尾の空行に入力された値を新規座標として確定
  const commitNewRow = () => {
    const pn = newRow.pointNumber.trim()
    const hasX = newRow.x.trim() !== ''
    const hasY = newRow.y.trim() !== ''
    if (!pn && !hasX && !hasY) return
    const xv = parseFloat(newRow.x)
    const yv = parseFloat(newRow.y)
    const zv = parseFloat(newRow.z)
    importCoordinates([
      {
        pointNumber: pn || `P${coordinates.length + 1}`,
        x: Number.isFinite(xv) ? xv : 0,
        y: Number.isFinite(yv) ? yv : 0,
        z: newRow.z.trim() !== '' && Number.isFinite(zv) ? zv : null,
        // 既定は空。ユーザが点種を選ばなかった場合は '' のまま保存して、
        // 後から座標管理画面で個別に設定できるようにする。
        type: (newRow.type ?? '') as CoordinateType,
        stakeType: newRow.stakeType.trim() !== '' ? newRow.stakeType : null,
      },
    ])
    setNewRow({ pointNumber: '', x: '', y: '', z: '', type: newRow.type, stakeType: newRow.stakeType })
    setTimeout(() => lastRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80)
  }

  // 末尾の入力用空行
  const renderNewRow = () => {
    const onKey = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        commitNewRow()
      }
    }
    const cell = 'px-0.5 py-0.5'
    const inp = 'w-full px-1 py-0.5 border border-slate-200 rounded text-sm'
    return (
      <tr
        className="bg-amber-50/40"
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) commitNewRow()
        }}
      >
        <td className="px-1 py-0.5 text-center text-slate-300">＋</td>
        <td className={cell} onClick={(e) => e.stopPropagation()}>
          <input
            value={newRow.pointNumber}
            onChange={(e) => setNewRow((r) => ({ ...r, pointNumber: e.target.value }))}
            onKeyDown={onKey}
            placeholder="点番号"
            className={inp}
          />
        </td>
        <td className="px-0 py-0.5 w-28" onClick={(e) => e.stopPropagation()}>
          <input
            value={newRow.x}
            onChange={(e) => setNewRow((r) => ({ ...r, x: e.target.value }))}
            onKeyDown={onKey}
            placeholder="X"
            inputMode="decimal"
            className="w-full px-2 py-0.5 border border-slate-200 rounded text-right text-sm font-mono"
          />
        </td>
        <td className="px-0 py-0.5 w-28" onClick={(e) => e.stopPropagation()}>
          <input
            value={newRow.y}
            onChange={(e) => setNewRow((r) => ({ ...r, y: e.target.value }))}
            onKeyDown={onKey}
            placeholder="Y"
            inputMode="decimal"
            className="w-full px-2 py-0.5 border border-slate-200 rounded text-right text-sm font-mono"
          />
        </td>
        <td className="px-0 py-0.5 w-20" onClick={(e) => e.stopPropagation()}>
          <input
            value={newRow.z}
            onChange={(e) => setNewRow((r) => ({ ...r, z: e.target.value }))}
            onKeyDown={onKey}
            placeholder="Z"
            inputMode="decimal"
            className="w-full px-2 py-0.5 border border-slate-200 rounded text-right text-sm font-mono"
          />
        </td>
        <td className={cell} onClick={(e) => e.stopPropagation()}>
          <select
            value={newRow.type}
            onChange={(e) => setNewRow((r) => ({ ...r, type: e.target.value }))}
            className={`${inp} bg-white`}
          >
            {/* 既定は空。点種を後から決める運用に対応 */}
            <option value="">(空)</option>
            {typeOptions.map((o) => (
              <option key={o.code} value={o.code}>
                {o.label}
              </option>
            ))}
          </select>
        </td>
        {/* 杭種（自由入力 + データリスト候補） */}
        <td className={cell} onClick={(e) => e.stopPropagation()}>
          <input
            list="stake-type-options"
            value={newRow.stakeType}
            onChange={(e) => setNewRow((r) => ({ ...r, stakeType: e.target.value }))}
            onKeyDown={onKey}
            placeholder="杭種"
            className={`${inp} bg-white`}
          />
        </td>
        <td className="px-0.5 py-0.5 text-center text-slate-300">-</td>
        <td className="px-0.5 py-0.5 text-right text-slate-300">-</td>
        <td className="px-0.5 py-0.5 text-right text-slate-300">-</td>
        <td className="px-0.5 py-0.5 text-slate-300">-</td>
        <td className="px-0.5 py-0.5 text-slate-300">-</td>
        <td className="px-0.5 py-0.5 text-slate-300">-</td>
        <td className="px-1 py-0.5"></td>
      </tr>
    )
  }

  // 区域（工事区域）の表示レイヤ切替チップ
  const renderWorkAreaLayers = () => {
    if (availableWorkTypes.length === 0) return null
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs text-slate-500 flex items-center gap-1">
          <Layers className="h-3 w-3" />
          区域
        </span>
        {availableWorkTypes.map((wt) => {
          const on = visibleWorkTypes.has(wt)
          return (
            <button
              key={wt}
              onClick={() => toggleWorkType(wt)}
              className={`px-2 py-0.5 text-xs rounded border ${
                on
                  ? 'bg-emerald-600 text-white border-emerald-600'
                  : 'bg-white text-slate-500 border-slate-300'
              }`}
            >
              {WORK_TYPE_NAMES[wt as WorkType] ?? wt}
            </button>
          )
        })}
      </div>
    )
  }

  // ツールバー（インポート / エクスポート / 手入力 / 座標計算）— hover の背景色だけビューで切り替え
  const renderToolbar = (hoverClass: 'hover:bg-gray-50' | 'hover:bg-white') => {
    const exportDisabled = coordinates.length === 0
    const exportCount = checkedIds.size === 0 ? coordinates.length : checkedIds.size
    return (
      <div ref={menuRef} className="flex items-center gap-2 mt-3">
        {/* 座標入力（貼り付け / SIMA / CSV） */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpenMenu(openMenu === 'import' ? null : 'import')}
            title="座標入力（貼り付け / SIMA / CSV）"
            className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded ${hoverClass}`}
          >
            <Download className="h-4 w-4" />
            座標入力
            <ChevronDown className="h-3 w-3" />
          </button>
          {openMenu === 'import' && (
            <div className="absolute left-0 top-full mt-1 w-52 bg-white border rounded shadow-lg z-40">
              {/* 取込時の点種を指定 */}
              <div className="px-3 py-2 border-b">
                <label className="block text-[11px] text-slate-500 mb-1">取り込む点種</label>
                <select
                  value={selectedType}
                  onChange={(e) => setSelectedType(e.target.value as CoordinateType)}
                  className="w-full px-2 py-1 text-sm border rounded bg-white"
                >
                  {typeOptions.map((opt) => (
                    <option key={opt.code} value={opt.code}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => { setShowPasteModal(true); setOpenMenu(null) }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-slate-100"
              >
                <Clipboard className="h-3.5 w-3.5" />
                表を貼り付け
              </button>
              <label className="block">
                <input
                  type="file"
                  accept=".sim,.SIM"
                  onChange={(e) => { handleImportSIMA(e); setOpenMenu(null) }}
                  className="hidden"
                />
                <span className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-100 cursor-pointer">
                  <FileText className="h-3.5 w-3.5" />
                  SIMA読込
                </span>
              </label>
              <label className="block">
                <input
                  type="file"
                  accept=".csv"
                  onChange={(e) => { handleImportCSV(e); setOpenMenu(null) }}
                  className="hidden"
                />
                <span className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-100 cursor-pointer">
                  <Upload className="h-3.5 w-3.5" />
                  CSV読込
                </span>
              </label>
            </div>
          )}
        </div>

        {/* 座標出力（CSV / SIMA / 写真帳） */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpenMenu(openMenu === 'export' ? null : 'export')}
            disabled={exportDisabled}
            title="座標出力（CSV / SIMA / 写真帳）"
            className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded ${hoverClass} disabled:opacity-50`}
          >
            <Upload className="h-4 w-4" />
            座標出力
            {checkedIds.size > 0 && (
              <span className="text-xs text-blue-600">({exportCount})</span>
            )}
            <ChevronDown className="h-3 w-3" />
          </button>
          {openMenu === 'export' && !exportDisabled && (
            <div className="absolute left-0 top-full mt-1 w-60 bg-white border rounded shadow-lg z-40">
              {/* 2 段階フロー: ① 出力フォーマット → ② 出力対象（全点 / 表示点 / 順指定） */}
              {!pendingFormat ? (
                <>
                  <div className="px-3 py-2 bg-slate-50 border-b text-[11px] text-slate-500">
                    出力フォーマットを選択
                  </div>
                  <button
                    type="button"
                    onClick={() => setPendingFormat('csv')}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-slate-100"
                  >
                    <Download className="h-3.5 w-3.5" />
                    CSV出力
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingFormat('tsv')}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-slate-100"
                    title="点名 / X / Y / Z を TSV でクリップボードへ"
                  >
                    <Clipboard className="h-3.5 w-3.5" />
                    TSVコピー（点名/X/Y/Z）
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingFormat('sima')}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-slate-100"
                  >
                    <Download className="h-3.5 w-3.5" />
                    SIMA出力
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingFormat('photobook')}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-slate-100"
                  >
                    <ImageIcon className="h-3.5 w-3.5" />
                    写真帳出力（Excel）
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingFormat('photos')}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-slate-100"
                    title="登録済み写真を JPG（複数は ZIP）でダウンロード"
                  >
                    <Download className="h-3.5 w-3.5" />
                    写真ダウンロード（JPG / ZIP）
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingFormat('excel')}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-slate-100 text-slate-500"
                  >
                    <Download className="h-3.5 w-3.5" />
                    EXCEL出力（実装予定）
                  </button>
                </>
              ) : (
                <>
                  <div className="px-3 py-2 bg-slate-50 border-b text-[11px] text-slate-500 flex items-center justify-between">
                    <span>
                      {pendingFormat === 'csv' && 'CSV出力'}
                      {pendingFormat === 'tsv' && 'TSVコピー'}
                      {pendingFormat === 'sima' && 'SIMA出力'}
                      {pendingFormat === 'photobook' && '写真帳出力'}
                      {pendingFormat === 'photos' && '写真ダウンロード'}
                      {pendingFormat === 'excel' && 'EXCEL出力'}
                      {' '}→ 対象を選択
                    </span>
                    <button
                      type="button"
                      onClick={() => setPendingFormat(null)}
                      className="text-blue-600 hover:underline"
                    >
                      戻る
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => executeExport(pendingFormat, 'all')}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left hover:bg-slate-100"
                  >
                    <span>全点出力</span>
                    <span className="text-xs text-slate-400">{coordinates.length} 件</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => executeExport(pendingFormat, 'checked')}
                    disabled={checkedIds.size === 0}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white"
                    title={
                      checkedIds.size === 0
                        ? '事前に一覧の チェック欄で対象を選択してください'
                        : `選択した ${checkedIds.size} 点を出力します`
                    }
                  >
                    <span>選択点出力</span>
                    <span className="text-xs text-slate-400">{checkedIds.size} 件</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => executeExport(pendingFormat, 'visible')}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left hover:bg-slate-100"
                  >
                    <span>表示点出力</span>
                    <span className="text-xs text-slate-400">{filteredCoordinates.length} 件</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null)
                      setOrderSelectMode(true)
                      setOrderedIds([])
                    }}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left hover:bg-slate-100"
                  >
                    <span>表示点出力（順指定）</span>
                    <span className="text-xs text-slate-400">マップで選択</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* 写真帳ひな形の選択ダイアログ */}
        {showPhotoBookChooser && (
          <div className="fixed inset-0 z-[3000] bg-black/40 flex items-center justify-center p-4">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
              <div className="px-4 py-3 border-b flex items-center gap-2">
                <ImageIcon className="h-4 w-4 text-blue-600" />
                <span className="font-semibold text-sm">写真帳のひな形を選択</span>
              </div>
              <div className="p-3 space-y-2 max-h-[60vh] overflow-y-auto">
                {PHOTO_BOOK_TEMPLATES.map((t) => (
                  <label
                    key={t.id}
                    className={`flex items-start gap-2 p-2 rounded border cursor-pointer ${
                      photoBookTemplateId === t.id
                        ? 'border-blue-400 bg-blue-50'
                        : 'border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="photoBookTemplate"
                      checked={photoBookTemplateId === t.id}
                      onChange={() => setPhotoBookTemplateId(t.id)}
                      className="mt-0.5"
                    />
                    <div>
                      <div className="text-sm font-medium">{t.label}</div>
                      <div className="text-xs text-slate-500">{t.description}</div>
                    </div>
                  </label>
                ))}
              </div>
              <div className="px-4 py-3 border-t flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowPhotoBookChooser(false)}
                  className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const tpl =
                      PHOTO_BOOK_TEMPLATES.find((t) => t.id === photoBookTemplateId) ??
                      PHOTO_BOOK_TEMPLATES[0]
                    try { localStorage.setItem('photoBook:templateId', tpl.id) } catch { /* ignore */ }
                    setShowPhotoBookChooser(false)
                    handleExportPhotoBook(tpl)
                  }}
                  className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  出力
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 写真帳出力の進捗オーバーレイ */}
        {photoExporting && (
          <div className="fixed inset-0 z-[3000] bg-black/40 flex items-center justify-center">
            <div className="bg-white rounded-lg shadow-xl p-5 w-72 text-center">
              <Loader2 className="h-6 w-6 animate-spin text-blue-600 mx-auto mb-2" />
              <div className="text-sm font-medium">写真帳を作成中…</div>
              <div className="text-xs text-slate-500 mt-1">
                {photoExporting.total > 0
                  ? `${photoExporting.done} / ${photoExporting.total} 枚`
                  : '写真を取得中…'}
              </div>
            </div>
          </div>
        )}

        {/* 座標計算 */}
        <button
          type="button"
          onClick={() => setShowCalcModal(true)}
          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90"
        >
          <Calculator className="h-3.5 w-3.5" />
          座標計算
        </button>

        {/* フィルターは各列のヘッダーへ移動した。
            点種・設置状態・写真の絞り込みは表の <th> 内のアイコンから操作する */}

        {/* 座標計算モーダル */}
        {showCalcModal && (
          <CoordinateCalcModal
            coordinates={coordinates
              .filter((c) => Number.isFinite(c.x) && Number.isFinite(c.y))
              .map((c) => ({ id: c.id, pointNumber: c.pointNumber, x: c.x, y: c.y }))}
            typeOptions={typeOptions}
            defaultType={selectedType}
            onAdd={handleCalcAdd}
            onClose={() => {
              setShowCalcModal(false)
              setCalcAssign(null)
              setCalcLineAssign(null)
            }}
            onPickRequest={(fn) => setCalcAssign(() => fn)}
            onLineRequest={(fn) => setCalcLineAssign(() => fn)}
          />
        )}
      </div>
    )
  }

  // ポップアウトモードの場合
  if (viewMode === 'map') {
    // 地図のみ表示
    return (
      <div className="h-screen flex flex-col">
        <div className="p-2 bg-white border-b flex items-center gap-4 flex-wrap">
          <h2 className="text-lg font-semibold">座標マップ</h2>
          <button
            onClick={() => setShowLabels(!showLabels)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${
              showLabels ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-gray-50 border-gray-300'
            }`}
          >
            {showLabels ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
            点名
          </button>
          <button
            onClick={() => setShowPolygonLabels(!showPolygonLabels)}
            title="地番名（ポリゴン名）の表示を切替"
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${
              showPolygonLabels ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-gray-50 border-gray-300'
            }`}
          >
            {showPolygonLabels ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
            地番名
          </button>
          <button
            onClick={() => setShowOrtho(!showOrtho)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${
              showOrtho ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-gray-50 border-gray-300'
            }`}
            title="オルソ画像の表示を切替"
          >
            <ImageIcon className="h-3 w-3" />
            オルソ
          </button>
          {renderWorkAreaLayers()}
        </div>
        <div className="flex-1 relative">
          <CoordinateMap
            key={currentFarm?.id ?? 'no-farm'}
            selectedPointId={selectedPointId}
            onPointSelect={handlePointClick}
            showLabels={showLabels}
            visibleTypes={visibleTypes}
            visibleStakeStatuses={visibleStakeStatuses}
            displayCoordinateIds={filteredCoordinateIdSet}
            orangeCoordIds={orangeCoordIds}
            checkedCoordIds={checkedIds}
            onPointToggleCheck={handlePointToggleCheck}
            farmMemos={memosForMap}
            onMemoClick={() => navigate('/orthophoto')}
            farmPhotos={farmPhotosForMap}
            photoGetSignedUrl={getSignedUrl}
            onMapLongPress={() => navigate('/orthophoto')}
            route={route}
            showRoute={true}
            farmId={currentFarm?.id ?? null}
            showOrtho={showOrtho}
            externalPolygons={workAreaPolygons}
            showPolygonLabels={showPolygonLabels}
            lineSelectMode={!!calcLineAssign}
            onLineSelect={(a, b) => calcLineAssign?.(a, b)}
          >
            {hasActiveParcelDataset && (
              <ParcelMapLayer
                visible={showParcelLayer}
                bbox={
                  (currentFarm?.parcel_map_bbox as
                    | { minLng: number; minLat: number; maxLng: number; maxLat: number }
                    | null
                    | undefined) ?? null
                }
              />
            )}
          </CoordinateMap>
          {hasActiveParcelDataset && (
            <div className="absolute bottom-6 left-2 z-[1000]">
              <button
                onClick={() => setShowParcelLayer(!showParcelLayer)}
                className={`flex items-center gap-1 px-3 py-1.5 text-sm rounded border shadow ${
                  showParcelLayer
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
      </div>
    )
  }

  if (viewMode === 'table') {
    // テーブルのみ表示
    return (
      <div className="h-screen flex flex-col">
        {/* 杭種ドロップダウンの共有候補リスト */}
        <datalist id="stake-type-options">
          {STAKE_TYPE_OPTIONS.map((o) => (
            <option key={o.label} value={o.label} />
          ))}
        </datalist>
        <div className="p-4 border-b bg-white">
          <h2 className="text-lg font-semibold mb-3">座標計算書</h2>
          {renderToolbar('hover:bg-gray-50')}
        </div>
        {/* 一括操作バーは表スクロールの外側に出す（下にスクロールしても表示し続ける） */}
        {renderBulkBar()}
        <div className="flex-1 overflow-auto">
          <table className="min-w-full w-max text-sm">
            <thead className="bg-slate-100 sticky top-0 z-30">
              <tr>
                <th className="px-1 py-2 w-8 text-center sticky left-0 z-30 bg-slate-100">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={toggleCheckAll}
                    className="cursor-pointer"
                    aria-label="全選択"
                  />
                </th>
                <th className="px-0.5 py-2 text-left font-medium w-20 sticky left-8 z-30 bg-slate-100">点番号</th>
                <th className="pr-2 pl-1 py-2 text-right font-medium w-28">X (m)</th>
                <th className="pr-2 pl-1 py-2 text-right font-medium w-28">Y (m)</th>
                <th className="pr-2 pl-1 py-2 text-right font-medium w-20">Z (m)</th>
                <th className="px-0.5 py-2 text-left font-medium">
                  <div className="flex items-center gap-1">
                    <span>種類</span>
                    <PointTypeFilterButton
                      compact
                      typeOptions={typeOptions}
                      onOpenManageModal={() => setShowPointTypeModal(true)}
                    />
                  </div>
                </th>
                <th className="px-0.5 py-2 text-left font-medium">
                  <div className="flex items-center gap-1">
                    <span>杭種</span>
                    <StakeTypeFilterButton
                      compact
                      options={stakeTypeOptions}
                      visible={visibleStakeTypes}
                      onChange={setVisibleStakeTypes}
                    />
                  </div>
                </th>
                <th className="px-0.5 py-2 text-center font-medium w-28" title="杭設置のワークフロー状態">
                  <div className="flex items-center justify-center gap-1">
                    <span>設置</span>
                    <StakeStatusFilterButton compact />
                  </div>
                </th>
                <th className="px-0.5 py-2 text-center font-medium w-16">
                  <div className="flex items-center justify-center gap-1">
                    <span>写真</span>
                    <PhotoCountFilterButton
                      compact
                      value={photoCountFilter}
                      onChange={setPhotoCountFilter}
                    />
                  </div>
                </th>
                <th className="px-0.5 py-2 text-right font-medium">緯度</th>
                <th className="px-0.5 py-2 text-right font-medium">経度</th>
                <th className="px-0.5 py-2 text-left font-medium whitespace-nowrap">更新者</th>
                <th className="px-0.5 py-2 text-left font-medium whitespace-nowrap">更新日時</th>
                <th className="px-0.5 py-2 text-left font-medium">備考</th>
                <th className="px-1 py-2 w-16"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {displayCoordinates.map((coord, idx) => {
                const orderIdx = orderSelectMode ? orderedIds.indexOf(coord.id) : -1
                const isOrdered = orderIdx >= 0
                const isInactiveInOrder = orderSelectMode && !isOrdered
                const rowBg = selectedPointId === coord.id
                  ? 'bg-blue-200'
                  : isOrdered
                  ? 'bg-amber-50'
                  : isInactiveInOrder
                  ? 'bg-slate-50'
                  : 'bg-white'
                return (
                <tr
                  key={coord.id}
                  ref={idx === displayCoordinates.length - 1 ? lastRowRef : null}
                  data-coord-row-id={coord.id}
                  draggable={isOrdered}
                  onDragStart={(e) => {
                    setDraggingOrderId(coord.id)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragOver={(e) => {
                    if (isOrdered && draggingOrderId) e.preventDefault()
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (!draggingOrderId || draggingOrderId === coord.id) return
                    setOrderedIds((prev) => {
                      const fromIdx = prev.indexOf(draggingOrderId)
                      const toIdx = prev.indexOf(coord.id)
                      if (fromIdx < 0 || toIdx < 0) return prev
                      const next = [...prev]
                      const [moved] = next.splice(fromIdx, 1)
                      next.splice(toIdx, 0, moved)
                      return next
                    })
                    setDraggingOrderId(null)
                  }}
                  onDragEnd={() => setDraggingOrderId(null)}
                  className={`cursor-pointer ${rowBg} ${
                    selectedPointId === coord.id ? 'hover:bg-blue-200' : 'hover:bg-slate-100'
                  } ${isInactiveInOrder ? 'opacity-60' : ''} ${
                    isOrdered ? 'cursor-move' : ''
                  }`}
                  onClick={() => handlePointClick(coord.id)}
                >
                  <td
                    className={`px-1 py-0.5 text-center sticky left-0 z-10 ${rowBg}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {orderSelectMode ? (
                      isOrdered ? (
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-500 text-white text-[10px] font-bold">
                          {orderIdx + 1}
                        </span>
                      ) : (
                        <span className="text-slate-300 text-xs">–</span>
                      )
                    ) : (
                      <input
                        type="checkbox"
                        checked={checkedIds.has(coord.id)}
                        onChange={() => toggleCheck(coord.id)}
                        className="cursor-pointer"
                        aria-label={`${coord.pointNumber} を選択`}
                      />
                    )}
                  </td>
                  <td className={`px-0.5 py-0.5 sticky left-8 z-10 ${rowBg}`}>
                    <input
                      type="text"
                      value={coord.pointNumber}
                      onChange={(e) => updateCoordinate(coord.id, 'pointNumber', e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-full px-1 py-0.5 border rounded text-sm"
                    />
                  </td>
                  <td className="px-0 py-0.5 w-28">
                    <NumberInput
                      value={coord.x}
                      onChange={(v) => updateCoordinate(coord.id, 'x', v ?? 0)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-full px-2 py-0.5 border rounded text-right text-sm font-mono"
                    />
                  </td>
                  <td className="px-0 py-0.5 w-28">
                    <NumberInput
                      value={coord.y}
                      onChange={(v) => updateCoordinate(coord.id, 'y', v ?? 0)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-full px-2 py-0.5 border rounded text-right text-sm font-mono"
                    />
                  </td>
                  <td className="px-0 py-0.5 w-20">
                    <NumberInput
                      value={coord.z}
                      onChange={(v) => updateCoordinate(coord.id, 'z', v)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-full px-2 py-0.5 border rounded text-right text-sm font-mono"
                      placeholder="-"
                    />
                  </td>
                  <td className="px-0.5 py-0.5">
                    <select
                      value={coord.type ?? ''}
                      onChange={(e) => updateCoordinate(coord.id, 'type', e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="px-1 py-0.5 border rounded text-xs"
                    >
                      <option value="">(空)</option>
                      {typeOptions.map((opt) => (
                        <option key={opt.code} value={opt.code}>{opt.label}</option>
                      ))}
                    </select>
                  </td>
                  {/* 杭種（自由入力 + 候補 datalist） */}
                  <td className="px-0.5 py-0.5">
                    <input
                      list="stake-type-options"
                      type="text"
                      value={coord.stakeType ?? ''}
                      onChange={(e) =>
                        updateCoordinate(coord.id, 'stakeType', e.target.value || null)
                      }
                      onClick={(e) => e.stopPropagation()}
                      placeholder="-"
                      className="w-20 px-1 py-0.5 border rounded text-xs bg-white"
                    />
                  </td>
                  <td className="px-0.5 py-0.5" onClick={(e) => e.stopPropagation()}>
                    <StakeStatusCell
                      value={coord.stakeStatus}
                      onChange={(next) => void setStakeStatus(coord.id, next)}
                      measured={stakedCoordIds.has(coord.id)}
                    />
                  </td>
                  <td className="px-0.5 py-0.5 text-center" onClick={(e) => e.stopPropagation()}>
                    <PhotoCountCell
                      count={attachmentsByEntity.get(`coordinate:${coord.id}`)?.length ?? 0}
                      onClick={() => setPhotoCoordId(coord.id)}
                    />
                  </td>
                  <td className="px-0.5 py-0.5 text-right text-xs text-muted-foreground font-mono">
                    {coord.lat?.toFixed(6) ?? '-'}
                  </td>
                  <td className="px-0.5 py-0.5 text-right text-xs text-muted-foreground font-mono">
                    {coord.lng?.toFixed(6) ?? '-'}
                  </td>
                  <td
                    className="px-0.5 py-0.5 text-xs text-muted-foreground whitespace-nowrap max-w-[8rem] truncate"
                    title={coord.updatedBy ? (memberNameById.get(coord.updatedBy) ?? coord.updatedBy) : ''}
                  >
                    {coord.updatedBy ? (memberNameById.get(coord.updatedBy) ?? '-') : '-'}
                  </td>
                  <td className="px-0.5 py-0.5 text-xs text-muted-foreground font-mono whitespace-nowrap">
                    {fmtDateTime(coord.updatedAt)}
                  </td>
                  <td className="px-0.5 py-0.5">
                    <input
                      type="text"
                      value={coord.notes ?? ''}
                      onChange={(e) =>
                        updateCoordinate(coord.id, 'notes', e.target.value || null)
                      }
                      onClick={(e) => e.stopPropagation()}
                      placeholder="-"
                      className="w-40 px-1 py-0.5 border rounded text-xs bg-white"
                    />
                  </td>
                  <td className="px-1 py-0.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteOne(coord.id, coord.pointNumber)
                      }}
                      className="p-1 text-red-500 hover:bg-red-50 rounded"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
                )
              })}
              {renderNewRow()}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2 bg-slate-50 border-t text-xs text-muted-foreground">
          {coordinates.length} 点登録済み{checkedIds.size > 0 && `（${checkedIds.size} 点選択中）`}
        </div>
      </div>
    )
  }

  // 通常表示（左右分割）
  return (
    <div className="h-full flex flex-col">
      {/* 杭種ドロップダウンの共有候補リスト */}
      <datalist id="stake-type-options">
        {STAKE_TYPE_OPTIONS.map((o) => (
          <option key={o.label} value={o.label} />
        ))}
      </datalist>
      <PageHeader
        title="座標管理"
        subtitle="平面直角座標の登録"
        actions={
          coordLoadingProgress && coordLoadingProgress.total > 0 ? (
            <div className="flex items-center gap-2 text-xs text-slate-700">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
              <span>
                座標を読込中
                <span className="font-mono ml-1">
                  {coordLoadingProgress.done.toLocaleString()} / {coordLoadingProgress.total.toLocaleString()}
                </span>
                <span className="ml-1 text-slate-500">
                  ({Math.round((coordLoadingProgress.done / coordLoadingProgress.total) * 100)}%)
                </span>
              </span>
              <div className="w-32 h-2 bg-slate-200 rounded overflow-hidden">
                <div
                  className="h-full bg-blue-600 transition-[width] duration-150"
                  style={{
                    width: `${Math.min(100, (coordLoadingProgress.done / coordLoadingProgress.total) * 100)}%`,
                  }}
                />
              </div>
            </div>
          ) : undefined
        }
      />

      {/* 順指定モード: 上部バナーで操作案内と件数・完了/キャンセル */}
      {orderSelectMode && (
        <div className="bg-amber-50 border-b border-amber-300 px-4 py-2 flex items-center gap-3 text-sm">
          <span className="font-semibold text-amber-800">順指定モード</span>
          <span className="text-slate-700">
            {orderedIds.length} 件選択
          </span>
          <span className="text-xs text-slate-500">
            地図のマーカーをクリックで追加 / 表の行をドラッグで順序入替
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setOrderSelectMode(false)
                setOrderedIds([])
                setExportSource(null)
                setPendingFormat(null)
              }}
              className="px-2 py-1 text-xs border rounded hover:bg-slate-100"
            >
              キャンセル
            </button>
            <button
              type="button"
              disabled={orderedIds.length === 0 || !pendingFormat}
              onClick={() => {
                if (!pendingFormat) return
                setOrderSelectMode(false)
                executeExport(pendingFormat, 'visible-ordered')
              }}
              className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              完了 → 出力 ({orderedIds.length})
            </button>
          </div>
        </div>
      )}

      {/* メインコンテンツ */}
      <ResizableSplit
        storageKey="coordinates"
        defaultLeft={620}
        minLeft={320}
        maxLeft={1400}
        className="flex-1"
        left={
        <div className="flex-1 flex flex-col overflow-hidden border-r">
          <div className="flex-1 flex flex-col overflow-hidden">
              {/* 設定パネル */}
              <div className="p-4 border-b bg-slate-50">
                {renderToolbar('hover:bg-white')}
              </div>

              {/* 一括操作バーは表スクロールの外側に出す（下にスクロールしても表示し続ける） */}
              {renderBulkBar()}

              {/* 座標テーブル */}
              <div className="flex-1 overflow-auto">
                <table className="min-w-full w-max text-sm">
                  <thead className="bg-slate-100 sticky top-0 z-30">
                    <tr>
                      <th className="px-1 py-2 w-8 text-center sticky left-0 z-30 bg-slate-100">
                        <input
                          type="checkbox"
                          checked={allChecked}
                          onChange={toggleCheckAll}
                          className="cursor-pointer"
                          aria-label="全選択"
                        />
                      </th>
                      <th className="px-0.5 py-2 text-left font-medium w-20 sticky left-8 z-30 bg-slate-100">点番号</th>
                      <th className="pr-2 pl-1 py-2 text-right font-medium w-28">X (m)</th>
                      <th className="pr-2 pl-1 py-2 text-right font-medium w-28">Y (m)</th>
                      <th className="pr-2 pl-1 py-2 text-right font-medium w-20">Z (m)</th>
                      <th className="px-0.5 py-2 text-left font-medium">
                        <div className="flex items-center gap-1">
                          <span>種類</span>
                          <PointTypeFilterButton
                            compact
                            typeOptions={typeOptions}
                            onOpenManageModal={() => setShowPointTypeModal(true)}
                          />
                        </div>
                      </th>
                      <th className="px-0.5 py-2 text-left font-medium">
                  <div className="flex items-center gap-1">
                    <span>杭種</span>
                    <StakeTypeFilterButton
                      compact
                      options={stakeTypeOptions}
                      visible={visibleStakeTypes}
                      onChange={setVisibleStakeTypes}
                    />
                  </div>
                </th>
                      <th className="px-0.5 py-2 text-center font-medium w-28" title="杭設置のワークフロー状態">
                        <div className="flex items-center justify-center gap-1">
                          <span>設置</span>
                          <StakeStatusFilterButton compact />
                        </div>
                      </th>
                      <th className="px-0.5 py-2 text-center font-medium w-16">
                        <div className="flex items-center justify-center gap-1">
                          <span>写真</span>
                          <PhotoCountFilterButton
                            compact
                            value={photoCountFilter}
                            onChange={setPhotoCountFilter}
                          />
                        </div>
                      </th>
                      <th className="px-0.5 py-2 text-right font-medium">緯度</th>
                      <th className="px-0.5 py-2 text-right font-medium">経度</th>
                      <th className="px-0.5 py-2 text-left font-medium whitespace-nowrap">更新者</th>
                      <th className="px-0.5 py-2 text-left font-medium whitespace-nowrap">更新日時</th>
                      <th className="px-0.5 py-2 text-left font-medium">備考</th>
                      <th className="px-1 py-2 w-16"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {displayCoordinates.map((coord, idx) => {
                      const orderIdx = orderSelectMode ? orderedIds.indexOf(coord.id) : -1
                      const isOrdered = orderIdx >= 0
                      const isInactiveInOrder = orderSelectMode && !isOrdered
                      const rowBg = selectedPointId === coord.id
                        ? 'bg-blue-200'
                        : isOrdered
                        ? 'bg-amber-50'
                        : isInactiveInOrder
                        ? 'bg-slate-50'
                        : 'bg-white'
                      return (
                      <tr
                        key={coord.id}
                        ref={idx === displayCoordinates.length - 1 ? lastRowRef : null}
                        data-coord-row-id={coord.id}
                        draggable={isOrdered}
                        onDragStart={(e) => {
                          setDraggingOrderId(coord.id)
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragOver={(e) => {
                          if (isOrdered && draggingOrderId) e.preventDefault()
                        }}
                        onDrop={(e) => {
                          e.preventDefault()
                          if (!draggingOrderId || draggingOrderId === coord.id) return
                          setOrderedIds((prev) => {
                            const fromIdx = prev.indexOf(draggingOrderId)
                            const toIdx = prev.indexOf(coord.id)
                            if (fromIdx < 0 || toIdx < 0) return prev
                            const next = [...prev]
                            const [moved] = next.splice(fromIdx, 1)
                            next.splice(toIdx, 0, moved)
                            return next
                          })
                          setDraggingOrderId(null)
                        }}
                        onDragEnd={() => setDraggingOrderId(null)}
                        className={`cursor-pointer ${rowBg} ${
                          selectedPointId === coord.id ? 'hover:bg-blue-200' : 'hover:bg-slate-100'
                        } ${isInactiveInOrder ? 'opacity-60' : ''} ${
                          isOrdered ? 'cursor-move' : ''
                        }`}
                        onClick={() => handlePointClick(coord.id)}
                      >
                        <td
                          className={`px-1 py-0.5 text-center sticky left-0 z-10 ${rowBg}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {orderSelectMode ? (
                            isOrdered ? (
                              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-500 text-white text-[10px] font-bold">
                                {orderIdx + 1}
                              </span>
                            ) : (
                              <span className="text-slate-300 text-xs">–</span>
                            )
                          ) : (
                            <input
                              type="checkbox"
                              checked={checkedIds.has(coord.id)}
                              onChange={() => toggleCheck(coord.id)}
                              className="cursor-pointer"
                              aria-label={`${coord.pointNumber} を選択`}
                            />
                          )}
                        </td>
                        <td className={`px-0.5 py-0.5 sticky left-8 z-10 ${rowBg}`}>
                          <input
                            type="text"
                            value={coord.pointNumber}
                            onChange={(e) => updateCoordinate(coord.id, 'pointNumber', e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full px-1 py-0.5 border rounded text-sm"
                          />
                        </td>
                        <td className="px-0 py-0.5 w-28">
                          <NumberInput
                            value={coord.x}
                            onChange={(v) => updateCoordinate(coord.id, 'x', v ?? 0)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full px-2 py-0.5 border rounded text-right text-sm font-mono"
                          />
                        </td>
                        <td className="px-0 py-0.5 w-28">
                          <NumberInput
                            value={coord.y}
                            onChange={(v) => updateCoordinate(coord.id, 'y', v ?? 0)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full px-2 py-0.5 border rounded text-right text-sm font-mono"
                          />
                        </td>
                        <td className="px-0 py-0.5 w-20">
                          <NumberInput
                            value={coord.z}
                            onChange={(v) => updateCoordinate(coord.id, 'z', v)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full px-2 py-0.5 border rounded text-right text-sm font-mono"
                            placeholder="-"
                          />
                        </td>
                        <td className="px-0.5 py-0.5">
                          <select
                            value={coord.type ?? ''}
                            onChange={(e) => updateCoordinate(coord.id, 'type', e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            className="px-1 py-0.5 border rounded text-xs"
                          >
                            <option value="">(空)</option>
                            {typeOptions.map((opt) => (
                              <option key={opt.code} value={opt.code}>{opt.label}</option>
                            ))}
                          </select>
                        </td>
                        {/* 杭種 */}
                        <td className="px-0.5 py-0.5">
                          <input
                            list="stake-type-options"
                            type="text"
                            value={coord.stakeType ?? ''}
                            onChange={(e) =>
                              updateCoordinate(coord.id, 'stakeType', e.target.value || null)
                            }
                            onClick={(e) => e.stopPropagation()}
                            placeholder="-"
                            className="w-20 px-1 py-0.5 border rounded text-xs bg-white"
                          />
                        </td>
                        <td className="px-0.5 py-0.5" onClick={(e) => e.stopPropagation()}>
                          <StakeStatusCell
                            value={coord.stakeStatus}
                            onChange={(next) => void setStakeStatus(coord.id, next)}
                            measured={stakedCoordIds.has(coord.id)}
                          />
                        </td>
                        <td className="px-0.5 py-0.5 text-center" onClick={(e) => e.stopPropagation()}>
                          <PhotoCountCell
                            count={attachmentsByEntity.get(`coordinate:${coord.id}`)?.length ?? 0}
                            onClick={() => setPhotoCoordId(coord.id)}
                          />
                        </td>
                        <td className="px-0.5 py-0.5 text-right text-xs text-muted-foreground font-mono">
                          {coord.lat?.toFixed(6) ?? '-'}
                        </td>
                        <td className="px-0.5 py-0.5 text-right text-xs text-muted-foreground font-mono">
                          {coord.lng?.toFixed(6) ?? '-'}
                        </td>
                        <td
                          className="px-0.5 py-0.5 text-xs text-muted-foreground whitespace-nowrap max-w-[7rem] truncate"
                          title={coord.updatedBy ? (memberNameById.get(coord.updatedBy) ?? coord.updatedBy) : ''}
                        >
                          {coord.updatedBy ? (memberNameById.get(coord.updatedBy) ?? '-') : '-'}
                        </td>
                        <td className="px-0.5 py-0.5 text-xs text-muted-foreground font-mono whitespace-nowrap">
                          {fmtDateTime(coord.updatedAt)}
                        </td>
                        <td className="px-0.5 py-0.5">
                          <input
                            type="text"
                            value={coord.notes ?? ''}
                            onChange={(e) =>
                              updateCoordinate(coord.id, 'notes', e.target.value || null)
                            }
                            onClick={(e) => e.stopPropagation()}
                            placeholder="-"
                            className="w-40 px-1 py-0.5 border rounded text-xs bg-white"
                          />
                        </td>
                        <td className="px-1 py-0.5">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handleDeleteOne(coord.id, coord.pointNumber)
                            }}
                            className="p-1 text-red-500 hover:bg-red-50 rounded"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                      )
                    })}
                    {renderNewRow()}
                  </tbody>
                </table>
              </div>

              {/* ステータスバー */}
              <div className="px-4 py-2 bg-slate-50 border-t text-xs text-muted-foreground">
                {coordinates.length} 点登録済み{checkedIds.size > 0 && `（${checkedIds.size} 点選択中）`}
              </div>
            </div>
        </div>

        }
        right={
        <div className="flex-1 bg-slate-100 flex flex-col relative">
          {/* 表示設定パネル */}
          <div className="p-2 bg-white border-b flex items-center gap-4 flex-wrap">
            <button
              onClick={() => setRouteMode(!routeMode)}
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${
                routeMode
                  ? 'bg-blue-100 border-blue-400 text-blue-800 font-medium'
                  : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
              }`}
              title="ONにすると地図クリックで点を経路に追加"
            >
              <Route className="h-3 w-3" />
              経路モード{routeMode ? 'ON' : 'OFF'}
            </button>
            <button
              onClick={() => setShowLabels(!showLabels)}
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${
                showLabels ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-gray-50 border-gray-300'
              }`}
            >
              {showLabels ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              点名
            </button>
            <button
              onClick={() => setShowPolygonLabels(!showPolygonLabels)}
              title="地番名（ポリゴン名）の表示を切替"
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${
                showPolygonLabels ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-gray-50 border-gray-300'
              }`}
            >
              {showPolygonLabels ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              地番名
            </button>
            <button
              onClick={() => setShowOrtho(!showOrtho)}
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${
                showOrtho ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-gray-50 border-gray-300'
              }`}
              title="オルソ画像の表示を切替"
            >
              <ImageIcon className="h-3 w-3" />
              オルソ
            </button>
            {renderWorkAreaLayers()}
          </div>
          <div className="flex-1 relative">
            <CoordinateMap
              key={currentFarm?.id ?? 'no-farm'}
              selectedPointId={selectedPointId}
              onPointSelect={handlePointClick}
              showLabels={showLabels}
              visibleTypes={visibleTypes}
              visibleStakeStatuses={visibleStakeStatuses}
            displayCoordinateIds={filteredCoordinateIdSet}
            orangeCoordIds={orangeCoordIds}
            checkedCoordIds={checkedIds}
            onPointToggleCheck={handlePointToggleCheck}
            farmMemos={memosForMap}
            onMemoClick={() => navigate('/orthophoto')}
            farmPhotos={farmPhotosForMap}
            photoGetSignedUrl={getSignedUrl}
            onMapLongPress={() => navigate('/orthophoto')}
              route={route}
              showRoute={true}
              farmId={currentFarm?.id ?? null}
              showOrtho={showOrtho}
              externalPolygons={workAreaPolygons}
              showPolygonLabels={showPolygonLabels}
              lineSelectMode={!!calcLineAssign}
              onLineSelect={(a, b) => calcLineAssign?.(a, b)}
            >
              {hasActiveParcelDataset && (
                <ParcelMapLayer
                  visible={showParcelLayer}
                  bbox={
                    (currentFarm?.parcel_map_bbox as
                      | { minLng: number; minLat: number; maxLng: number; maxLat: number }
                      | null
                      | undefined) ?? null
                  }
                />
              )}
              {/* 実測記録 (staking_records) を地図に表示 */}
              {showStakingRecords &&
                stakingOverlay.map((s) => (
                  <CircleMarker
                    key={s.key}
                    center={[s.lat, s.lng]}
                    radius={4}
                    pathOptions={{
                      color: s.color,
                      fillColor: s.fillColor,
                      fillOpacity: 0.9,
                      weight: 1.5,
                    }}
                  >
                    <Tooltip direction="top" offset={[0, -6]} opacity={0.9}>
                      <span className="text-[10px] font-mono">{s.label}</span>
                    </Tooltip>
                  </CircleMarker>
                ))}
              {/* 暗渠 (読み取り専用オーバーレイ)。編集は暗渠モジュールで。 */}
              {showPipes &&
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
              {showPipes &&
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
            <div className="absolute bottom-6 left-2 z-[1000] flex gap-2">
              {hasActiveParcelDataset && (
                <button
                  onClick={() => setShowParcelLayer(!showParcelLayer)}
                  className={`flex items-center gap-1 px-3 py-1.5 text-sm rounded border shadow ${
                    showParcelLayer
                      ? 'bg-orange-500 text-white border-orange-500 hover:bg-orange-600'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}
                  title="法務省地図データを背景に表示する"
                >
                  <MapIcon className="h-4 w-4" />
                  法務省地図
                </button>
              )}
              {pipes.length > 0 && (
                <button
                  onClick={() => setShowPipes(!showPipes)}
                  className={`flex items-center gap-1 px-3 py-1.5 text-sm rounded border shadow ${
                    showPipes
                      ? 'bg-cyan-600 text-white border-cyan-600 hover:bg-cyan-700'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}
                  title={`暗渠 ${pipes.length} 本を地図上に表示 (読み取り専用)`}
                >
                  <Waves className="h-4 w-4" />
                  暗渠
                </button>
              )}
              {stakingRecords.length > 0 && (
                <button
                  onClick={() => setShowStakingRecords(!showStakingRecords)}
                  className={`flex items-center gap-1 px-3 py-1.5 text-sm rounded border shadow ${
                    showStakingRecords
                      ? 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}
                  title={`実測記録 ${stakingRecords.length} 件を地図上に表示`}
                >
                  <Target className="h-4 w-4" />
                  実測
                </button>
              )}
            </div>

            {/* 経路パネル（地図右上にオーバーレイ） */}
            {(routeMode || route.length > 0) && (
              <div
                className={`absolute top-2 right-2 z-[1000] flex flex-col bg-white border border-slate-300 rounded shadow-lg ${
                  routePanelCollapsed ? 'w-auto' : 'w-64 max-h-[60vh]'
                }`}
              >
                <div className="px-2 py-1.5 border-b flex items-center justify-between bg-slate-50 rounded-t gap-2">
                  <button
                    type="button"
                    onClick={() => setRoutePanelCollapsed((v) => !v)}
                    className="text-xs font-medium text-slate-700 flex items-center gap-1 hover:text-slate-900"
                    title={routePanelCollapsed ? '展開' : '折りたたむ'}
                  >
                    <ChevronDown
                      className={`h-3 w-3 transition-transform ${
                        routePanelCollapsed ? '-rotate-90' : ''
                      }`}
                    />
                    <Route className="h-3 w-3" />
                    経路 ({route.length})
                  </button>
                  {!routePanelCollapsed && (
                    <div className="flex items-center gap-2">
                      {route.length > 0 && (
                        <button
                          onClick={async () => {
                            const name = (routeName || '').trim() || '既定'
                            try {
                              await saveRoute(name)
                              alert(
                                `ルート「${name}」を保存しました\nスマホ杭打ちで選択できます`,
                              )
                            } catch (err) {
                              const msg =
                                err instanceof Error ? err.message : String(err)
                              alert(`保存に失敗しました: ${msg}`)
                            }
                          }}
                          className="text-[10px] px-1.5 py-0.5 bg-emerald-600 text-white rounded hover:bg-emerald-700 flex items-center gap-0.5"
                          title="この名前でスマホ杭打ち用ルートを保存"
                        >
                          <Save className="h-2.5 w-2.5" />
                          スマホに保存
                        </button>
                      )}
                      {route.length > 0 && (
                        <button
                          onClick={() => {
                            if (confirm('編集中の経路を全てクリアしますか？')) clearRoute()
                          }}
                          className="text-[10px] text-red-600 hover:text-red-800"
                          title="編集中の経路を全てクリア"
                        >
                          クリア
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {!routePanelCollapsed && (
                <>
                {/* ルート名入力 + 保存済みルート一覧 */}
                <div className="px-2 py-1.5 border-b bg-slate-50/60 space-y-1.5">
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-slate-500 shrink-0">名前</span>
                    <input
                      type="text"
                      value={routeName}
                      onChange={(e) => setRouteName(e.target.value)}
                      placeholder="既定"
                      className="flex-1 min-w-0 px-1.5 py-0.5 text-[11px] border rounded"
                    />
                  </div>
                  {currentFarm && (
                    <SavedRoutesList
                      farmId={currentFarm.id}
                      currentName={routeName}
                      onSelect={(name) => setRouteName(name)}
                    />
                  )}
                </div>
                <div className="flex-1 overflow-auto text-xs">
                  {route.length === 0 ? (
                    <div className="p-3 text-slate-500 text-center">
                      {routeMode ? '地図の点をクリックして追加' : '経路なし'}
                    </div>
                  ) : (
                    <table className="w-full">
                      <tbody>
                        {route.map((p, idx) => {
                          const coord = coordinates.find((c) => c.id === p.coordinateId)
                          return (
                            <tr key={`${p.coordinateId}-${idx}`} className="border-b last:border-0 hover:bg-slate-50">
                              <td className="px-1 py-1 text-slate-500 w-6 text-right">{idx + 1}</td>
                              <td className="px-1 py-1 font-mono">{coord?.pointNumber ?? '(不明)'}</td>
                              <td className="px-1 py-1">
                                <button
                                  onClick={() =>
                                    setRouteDirection(idx, p.direction === 'down' ? 'up' : 'down')
                                  }
                                  className={`inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] border ${
                                    p.direction === 'down'
                                      ? 'bg-blue-100 border-blue-300 text-blue-800'
                                      : 'bg-slate-100 border-slate-300 text-slate-500'
                                  }`}
                                  title="up/down 切替"
                                >
                                  {p.direction === 'down' ? (
                                    <ArrowDown className="h-3 w-3" />
                                  ) : (
                                    <ArrowUp className="h-3 w-3" />
                                  )}
                                  {p.direction}
                                </button>
                              </td>
                              <td className="px-1 py-1 text-right whitespace-nowrap">
                                <button
                                  onClick={() => moveRoutePoint(idx, -1)}
                                  disabled={idx === 0}
                                  className="px-0.5 text-slate-500 hover:text-slate-800 disabled:opacity-30"
                                  title="上へ"
                                >
                                  ↑
                                </button>
                                <button
                                  onClick={() => moveRoutePoint(idx, 1)}
                                  disabled={idx === route.length - 1}
                                  className="px-0.5 text-slate-500 hover:text-slate-800 disabled:opacity-30"
                                  title="下へ"
                                >
                                  ↓
                                </button>
                                <button
                                  onClick={() => removeRoutePoint(idx)}
                                  className="px-0.5 text-red-500 hover:text-red-700"
                                  title="削除"
                                >
                                  ×
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
                </>
                )}
              </div>
            )}

            {/* 地図右下: 折りたたみ式の写真パネル。開くと地図の下半分を覆う。
                スマホ側の「点情報モーダル」に相当する情報 (X/Y/Z / 点種 / 設置 / 備考)
                をパネル上部のストリップに表示する。 */}
            <CoordinatePhotoPanel
              open={photoPanelOpen}
              onToggle={() => {
                setPhotoPanelOpen((v) => {
                  const next = !v
                  // 「閉じる」操作は明示的な意図として記録
                  if (!next) userClosedPhotoPanelRef.current = true
                  else userClosedPhotoPanelRef.current = false
                  return next
                })
              }}
              projectId={projectId}
              coordinateId={selectedPointId}
              pointNumber={
                selectedPointId
                  ? coordinates.find((c) => c.id === selectedPointId)?.pointNumber ?? null
                  : null
              }
              coordinate={
                selectedPointId
                  ? coordinates.find((c) => c.id === selectedPointId) ?? null
                  : null
              }
              typeOptions={typeOptions}
            />
          </div>
        </div>
        }
      />

      {/* 一括訂正モーダル */}
      {showBulkEditModal && (
        <BulkEditModal
          selectedCount={checkedIds.size}
          typeOptions={typeOptions}
          stakeTypeOptions={stakeTypeOptions}
          onClose={() => setShowBulkEditModal(false)}
          onApply={(patch) => {
            applyBulkEdit(patch)
            setShowBulkEditModal(false)
          }}
        />
      )}

      {/* 一括座標計算モーダル（スライド/平行移動） */}
      {showBulkCalcModal && (
        <BulkCalcModal
          selectedCoords={coordinates.filter((c) => checkedIds.has(c.id))}
          onClose={() => setShowBulkCalcModal(false)}
          onOverwrite={(updates) => {
            for (const { id, x, y, z } of updates) {
              updateCoordinate(id, 'x', x)
              updateCoordinate(id, 'y', y)
              if (z !== undefined) updateCoordinate(id, 'z', z)
            }
            setShowBulkCalcModal(false)
          }}
          onCreateNew={async (newCoords) => {
            await importCoordinates(newCoords)
            setShowBulkCalcModal(false)
            setCheckedIds(new Set())
          }}
        />
      )}

      {/* 貼り付けモーダル */}
      <PasteModal
        isOpen={showPasteModal}
        onClose={() => setShowPasteModal(false)}
        onPaste={handleModalPaste}
        typeOptions={typeOptions}
      />

      {/* 点種管理モーダル */}
      <PointTypeManagerModal
        isOpen={showPointTypeModal}
        onClose={() => setShowPointTypeModal(false)}
        projectId={projectId}
        customTypes={projectId ? pointTypesByProject.get(projectId) ?? [] : []}
        onAdd={async (code, label) => {
          if (!projectId) return
          await addPointType(projectId, code, label)
        }}
        onRemove={async (id) => removePointType(id)}
      />

      {/* 写真モーダル */}
      {photoCoordId && projectId && (() => {
        const target = coordinates.find((c) => c.id === photoCoordId)
        return (
          <CoordinatePhotoModal
            open={!!photoCoordId}
            onClose={() => setPhotoCoordId(null)}
            projectId={projectId}
            coordinateId={photoCoordId}
            pointNumber={target?.pointNumber ?? '-'}
          />
        )
      })()}
    </div>
  )
}

// 一括訂正モーダル: 点種 / 杭種 / 設置 のそれぞれをプルダウンで選択し、
// 「変更なし」のままなら更新しない。"適用" で選択された値を一括反映する。
function BulkEditModal({
  selectedCount,
  typeOptions,
  stakeTypeOptions,
  onClose,
  onApply,
}: {
  selectedCount: number
  typeOptions: Array<{ code: string; label: string }>
  stakeTypeOptions: Array<{ code: string; label: string }>
  onClose: () => void
  onApply: (patch: {
    type?: string
    stakeType?: string | null
    stakeStatus?: StakeStatus
  }) => void
}) {
  // '__nochange__' 番兵で「変更なし」を表現する。空文字列だと 杭種 の 未設定 (null) と
  // 区別がつかないため。
  const NOCHANGE = '__nochange__'
  const NULLABLE = '__null__'
  const [type, setType] = useState<string>(NOCHANGE)
  const [stakeType, setStakeType] = useState<string>(NOCHANGE)
  const [stakeStatus, setStakeStatus] = useState<string>(NOCHANGE)

  const nothingSelected =
    type === NOCHANGE && stakeType === NOCHANGE && stakeStatus === NOCHANGE

  const apply = () => {
    const patch: {
      type?: string
      stakeType?: string | null
      stakeStatus?: StakeStatus
    } = {}
    if (type !== NOCHANGE) patch.type = type
    if (stakeType !== NOCHANGE) {
      patch.stakeType = stakeType === NULLABLE ? null : stakeType
    }
    if (stakeStatus !== NOCHANGE) patch.stakeStatus = stakeStatus as StakeStatus
    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }
    onApply(patch)
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-md flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center gap-2">
          <Pencil className="h-4 w-4 text-blue-600" />
          <h3 className="flex-1 text-base font-semibold">一括訂正</h3>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700 rounded">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-4 py-2 bg-blue-50 text-xs text-blue-700 border-b">
          {selectedCount} 点を変更します。「変更なし」の項目は元の値が保持されます。
        </div>

        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <label className="w-16 text-sm text-slate-600">点種</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="flex-1 px-2 py-1 text-sm border rounded bg-white"
            >
              <option value={NOCHANGE}>変更なし</option>
              <option value="">(空)</option>
              {typeOptions.map((opt) => (
                <option key={opt.code} value={opt.code}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="w-16 text-sm text-slate-600">杭種</label>
            <select
              value={stakeType}
              onChange={(e) => setStakeType(e.target.value)}
              className="flex-1 px-2 py-1 text-sm border rounded bg-white"
            >
              <option value={NOCHANGE}>変更なし</option>
              <option value={NULLABLE}>未設定</option>
              {stakeTypeOptions
                .filter((opt) => opt.code !== '')
                .map((opt) => (
                  <option key={opt.code} value={opt.code}>
                    {opt.label}
                  </option>
                ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="w-16 text-sm text-slate-600">設置</label>
            <select
              value={stakeStatus}
              onChange={(e) => setStakeStatus(e.target.value)}
              className="flex-1 px-2 py-1 text-sm border rounded bg-white"
            >
              <option value={NOCHANGE}>変更なし</option>
              {STAKE_STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {STAKE_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="px-4 py-3 border-t flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
          >
            キャンセル
          </button>
          <button
            onClick={apply}
            disabled={nothingSelected}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" />
            適用
          </button>
        </div>
      </div>
    </div>
  )
}

// 一括座標計算モーダルは ./BulkCalcModal.tsx に移動済み。

// 点種管理モーダル
function PointTypeManagerModal({
  isOpen,
  onClose,
  projectId,
  customTypes,
  onAdd,
  onRemove,
}: {
  isOpen: boolean
  onClose: () => void
  projectId: string | null
  customTypes: { id: string; code: string; label: string }[]
  onAdd: (code: string, label: string) => Promise<void>
  onRemove: (id: string) => Promise<void>
}) {
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isOpen) return null

  const handleAdd = async () => {
    if (!projectId) {
      setError('プロジェクトが選択されていません')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await onAdd(code, label)
      setCode('')
      setLabel('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '追加に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center" style={{ zIndex: 9999 }}>
      <div className="bg-white rounded-lg p-6 w-full max-w-lg" style={{ zIndex: 10000 }}>
        <h3 className="text-lg font-semibold mb-1">点種の管理</h3>
        <p className="text-xs text-slate-500 mb-4">
          プロジェクト内の全工区に共通して使われます。
        </p>

        {/* 既定 + カスタムの一覧 */}
        <div className="mb-4 border rounded divide-y text-sm">
          {Object.entries(COORDINATE_TYPE_NAMES).map(([c, n]) => (
            <div key={c} className="px-3 py-1.5 flex items-center gap-2">
              <span className="font-medium flex-1">{n}</span>
              <span className="text-xs text-slate-400 font-mono">{c}</span>
              <span className="text-xs text-slate-400 ml-2">既定</span>
            </div>
          ))}
          {customTypes.length === 0 && (
            <div className="px-3 py-2 text-xs text-slate-400">
              （カスタム点種なし）
            </div>
          )}
          {customTypes.map((t) => (
            <div key={t.id} className="px-3 py-1.5 flex items-center gap-2">
              <span className="font-medium flex-1">{t.label}</span>
              <span className="text-xs text-slate-400 font-mono">{t.code}</span>
              <button
                onClick={() => {
                  if (confirm(`点種「${t.label}」を削除しますか？\n（既存座標の点種コードはそのまま残ります）`)) {
                    onRemove(t.id).catch((e) => setError(e instanceof Error ? e.message : '削除失敗'))
                  }
                }}
                className="ml-2 p-1 text-red-600 hover:bg-red-50 rounded"
                title="削除"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>

        {/* 追加フォーム */}
        <div className="border rounded p-3 mb-3 bg-slate-50">
          <h4 className="text-sm font-medium mb-2">点種を追加</h4>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-slate-600 mb-1">表示名</label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="例: 杭"
                className="w-full px-2 py-1 text-sm border rounded"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">コード（英数）</label>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="例: stake"
                className="w-full px-2 py-1 text-sm border rounded font-mono"
              />
            </div>
          </div>
          {error && <div className="text-xs text-red-600 mt-2">{error}</div>}
          <div className="flex justify-end mt-2">
            <button
              onClick={handleAdd}
              disabled={submitting || !code.trim() || !label.trim() || !projectId}
              className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              追加
            </button>
          </div>
        </div>

        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm border rounded hover:bg-gray-50"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}

// 保存済みルート一覧: 名前タップで routeName に反映、× で削除
function SavedRoutesList({
  farmId,
  currentName,
  onSelect,
}: {
  farmId: string
  currentName: string
  onSelect: (name: string) => void
}) {
  const fetchRoutes = useExportRouteStore((s) => s.fetchRoutes)
  const deleteRoute = useExportRouteStore((s) => s.deleteRoute)
  const routes = useExportRouteStore(
    (s) => s.routesByFarmId.get(farmId) ?? EMPTY_EXPORT_ROUTES,
  )
  useEffect(() => {
    void fetchRoutes(farmId)
  }, [farmId, fetchRoutes])
  if (routes.length === 0) return null
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <span className="text-[10px] text-slate-500">保存済</span>
      {routes.map((r) => (
        <span
          key={r.id}
          className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] border ${
            r.name === currentName.trim()
              ? 'bg-emerald-100 border-emerald-400 text-emerald-800'
              : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
          }`}
        >
          <button
            type="button"
            onClick={() => onSelect(r.name)}
            title={`「${r.name}」の名前を編集フィールドに読み込む`}
          >
            {r.name}
          </button>
          <button
            type="button"
            onClick={async () => {
              if (
                !confirm(`保存済みルート「${r.name}」を削除しますか?`)
              )
                return
              await deleteRoute(farmId, r.id)
            }}
            className="text-red-500 hover:text-red-700"
            title="削除"
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )
}
