import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Upload, Download, Trash2, FileText, Eye, EyeOff, Clipboard, Route, ArrowUp, ArrowDown, ChevronDown, Settings, Camera, Image as ImageIcon, Loader2, Calculator, Layers } from 'lucide-react'
import { CoordinatePhotoModal } from './CoordinatePhotoModal'
import { CoordinateCalcModal } from './CoordinateCalcModal'
import { JGD2011_ZONES, COORDINATE_TYPE_NAMES } from '@/lib/coordinates'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useFarmStore } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useAttachmentStore } from '@/stores/attachmentStore'
import { useWorkAreaStore, type WorkAreaPoint } from '@/stores/workAreaStore'
import { WORK_TYPE_NAMES, type WorkType } from '@/types/database'
import { generatePhotoBookExcel, PHOTO_BOOK_TEMPLATES, type PhotoBookTemplate } from '@/lib/photoBook'
import { useGlobalSaveRegistry } from '@/stores/globalSaveRegistry'
import {
  useCoordinatePointTypeStore,
  getCoordinateTypeOptions,
} from '@/stores/coordinatePointTypeStore'
import { CoordinateMap, type BaseLayerType, type ExternalPolygon } from '@/components/map/CoordinateMap'
import { ResizableSplit } from '@/components/layout/ResizableSplit'
import { loadSimaFile, downloadSimaFile } from '@/lib/sima-parser'
import { PageHeader } from '@/components/layout/PageHeader'
import type { CoordinateType } from '@/types/database'
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

// 貼り付けモーダルコンポーネント
function PasteModal({
  isOpen,
  onClose,
  onPaste,
  typeOptions,
}: {
  isOpen: boolean
  onClose: () => void
  onPaste: (text: string, type: CoordinateType) => void
  typeOptions: { code: string; label: string }[]
}) {
  const [pasteText, setPasteText] = useState('')
  const [pasteType, setPasteType] = useState<CoordinateType>('boundary')

  if (!isOpen) return null

  const handleSubmit = () => {
    if (pasteText.trim()) {
      onPaste(pasteText, pasteType)
      setPasteText('')
      onClose()
    }
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
            className="w-full h-64 px-3 py-2 border rounded font-mono text-sm"
          />
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm border rounded hover:bg-gray-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleSubmit}
            disabled={!pasteText.trim()}
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
  // 表示する点種（既定 + カスタム）。カスタム点種が増えたら自動で表示集合にも追加
  const [visibleTypes, setVisibleTypes] = useState<Set<string>>(
    new Set(Object.keys(COORDINATE_TYPE_NAMES))
  )
  const [baseLayer, setBaseLayer] = useState<BaseLayerType>('osm')
  const [showOrtho, setShowOrtho] = useState(true)
  const [showPasteModal, setShowPasteModal] = useState(false)

  // チェックされた点のID（エクスポート対象）
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set())

  // ツールバーのドロップダウンメニュー（インポート / エクスポート）
  const [openMenu, setOpenMenu] = useState<'import' | 'export' | null>(null)
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
  const { projects, members, fetchMembers } = useProjectListStore()
  const { fetchByEntityIds: fetchAttachments, getSignedUrl } = useAttachmentStore()
  const { workAreas, fetchWorkAreas } = useWorkAreaStore()
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
  } = useCoordinateStore()

  // 経路モード（クリックで経路に追加）
  const [routeMode, setRouteMode] = useState(false)

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

  // 新しく追加されたカスタム点種は既定で表示する
  useEffect(() => {
    setVisibleTypes((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const opt of typeOptions) {
        if (!next.has(opt.code)) {
          next.add(opt.code)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [typeOptions])

  // 工区選択時にデータを読み込む
  useEffect(() => {
    if (currentFarm && projectZone !== null) {
      // プロジェクトの座標系を設定
      setZone(projectZone)
      // Supabaseからデータを読み込む
      fetchCoordinates(currentFarm.id)
      // 経路を読み込む
      fetchRoute(currentFarm.id)
    }
  }, [currentFarm, projectZone, setZone, fetchCoordinates, fetchRoute])

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
      { id: string; name: string; points: WorkAreaPoint[] }[] | undefined,
    ][]) {
      if (!areas || !visibleWorkTypes.has(wt)) continue
      for (const area of areas) {
        const pts = area.points.filter((p) => p.lat !== null && p.lng !== null)
        const positions = pts.map((p) => [p.lat as number, p.lng as number] as [number, number])
        if (positions.length >= 3) {
          out.push({
            id: area.id,
            name: area.name,
            positions,
            pointIds: pts.map((p) => p.id),
          })
        }
      }
    }
    return out
  }, [workAreas, visibleWorkTypes])

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

  // エクスポート対象：チェックがあれば選択分のみ、無ければ全件
  const getExportTargets = () => {
    if (checkedIds.size === 0) return coordinates
    return coordinates.filter((c) => checkedIds.has(c.id))
  }

  const handleExportCSV = () => {
    const targets = getExportTargets()
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

  const handleExportSIMA = () => {
    const targets = getExportTargets()
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
  const handleCopyTSV = async () => {
    const targets = getExportTargets()
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
          return { name: c.pointNumber, subtitle: typeLabel, photos }
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

  // 選択点の点種を一括変更
  const handleBulkSetType = (newType: string) => {
    if (checkedIds.size === 0 || !newType) return
    for (const id of Array.from(checkedIds)) {
      updateCoordinate(id, 'type', newType)
    }
  }

  // 一括操作バー（チェック時のみ表示）
  const renderBulkBar = () => {
    if (checkedIds.size === 0) return null
    return (
      <div className="px-3 py-1.5 bg-blue-50 border-b border-blue-200 flex items-center gap-2 text-xs">
        <span className="font-medium text-blue-700">{checkedIds.size} 点選択中</span>
        <span className="text-slate-300">|</span>
        <span className="text-slate-600">点種を一括変更:</span>
        <select
          value=""
          onChange={(e) => {
            handleBulkSetType(e.target.value)
            e.currentTarget.value = ''
          }}
          className="px-1.5 py-0.5 text-xs border rounded bg-white"
        >
          <option value="" disabled>選択...</option>
          {typeOptions.map((opt) => (
            <option key={opt.code} value={opt.code}>{opt.label}</option>
          ))}
        </select>
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

  // モーダルからのペースト処理
  const handleModalPaste = useCallback((text: string, pasteType: CoordinateType) => {
    if (!text) return

    // TSV（タブ区切り）またはCSV（カンマ区切り）を検出
    const lines = text.split('\n').filter(line => line.trim())
    if (lines.length === 0) return

    // 区切り文字を判定（タブが多ければTSV、そうでなければCSV）
    const firstLine = lines[0]
    const tabCount = (firstLine.match(/\t/g) || []).length
    const commaCount = (firstLine.match(/,/g) || []).length
    const delimiter = tabCount >= commaCount ? '\t' : ','

    const newCoords = lines.map((line, idx) => {
      const parts = line.split(delimiter).map(s => s.trim())
      // 最低2列（X, Y）が必要
      if (parts.length < 2) return null

      // 列数で判定: 2列=X,Y、3列=X,Y,Z または 点番号,X,Y、4列=点番号,X,Y,Z
      let pointNumber: string
      let x: number
      let y: number
      let z: number | null = null

      if (parts.length === 2) {
        // X, Y のみ
        pointNumber = `P${coordinates.length + idx + 1}`
        x = parseFloat(parts[0]) || 0
        y = parseFloat(parts[1]) || 0
      } else if (parts.length === 3) {
        // 最初の列が数値かどうかで判定
        const firstIsNumber = !isNaN(parseFloat(parts[0])) && parts[0].match(/^-?\d+\.?\d*$/)
        if (firstIsNumber) {
          // X, Y, Z
          pointNumber = `P${coordinates.length + idx + 1}`
          x = parseFloat(parts[0]) || 0
          y = parseFloat(parts[1]) || 0
          z = parseFloat(parts[2]) || null
        } else {
          // 点番号, X, Y
          pointNumber = parts[0] || `P${coordinates.length + idx + 1}`
          x = parseFloat(parts[1]) || 0
          y = parseFloat(parts[2]) || 0
        }
      } else {
        // 4列以上: 点番号, X, Y, Z
        pointNumber = parts[0] || `P${coordinates.length + idx + 1}`
        x = parseFloat(parts[1]) || 0
        y = parseFloat(parts[2]) || 0
        z = parts[3] ? parseFloat(parts[3]) : null
      }

      return {
        pointNumber,
        x,
        y,
        z,
        type: pasteType, // 選択された点種を使用
      }
    }).filter((c): c is NonNullable<typeof c> => c !== null)

    if (newCoords.length > 0) {
      importCoordinates(newCoords)
    }
  }, [coordinates.length, importCoordinates])

  // 点がクリックされたとき
  const handlePointClick = (id: string) => {
    // 座標計算で地図から点を選択中なら、その点を割り当てて通常選択はしない
    if (calcAssign) {
      calcAssign(id)
      return
    }
    setSelectedPointId(id)
    if (routeMode) {
      appendRoutePoint(id, 'down')
    }
  }

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
        type: (newRow.type || selectedType) as CoordinateType,
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
            value={newRow.type || selectedType}
            onChange={(e) => setNewRow((r) => ({ ...r, type: e.target.value }))}
            className={`${inp} bg-white`}
          >
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
        <td className="px-0.5 py-0.5 text-right text-slate-300">-</td>
        <td className="px-0.5 py-0.5 text-right text-slate-300">-</td>
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
            <div className="absolute left-0 top-full mt-1 w-52 bg-white border rounded shadow-lg z-20">
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
            <div className="absolute left-0 top-full mt-1 w-44 bg-white border rounded shadow-lg z-20">
              <button
                type="button"
                onClick={() => { handleExportCSV(); setOpenMenu(null) }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-slate-100"
              >
                <Download className="h-3.5 w-3.5" />
                CSV出力
              </button>
              <button
                type="button"
                onClick={() => { handleCopyTSV(); setOpenMenu(null) }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-slate-100"
                title="点名 / X / Y / Z を TSV でクリップボードへ"
              >
                <Clipboard className="h-3.5 w-3.5" />
                TSVコピー（点名/X/Y/Z）
              </button>
              <button
                type="button"
                onClick={() => { handleExportSIMA(); setOpenMenu(null) }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-slate-100"
              >
                <Download className="h-3.5 w-3.5" />
                SIMA出力
              </button>
              <button
                type="button"
                onClick={() => { setShowPhotoBookChooser(true); setOpenMenu(null) }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-slate-100"
              >
                <ImageIcon className="h-3.5 w-3.5" />
                写真帳出力（Excel）
              </button>
              <button
                type="button"
                onClick={() => { handleExportExcel(); setOpenMenu(null) }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-slate-100 text-slate-500"
              >
                <Download className="h-3.5 w-3.5" />
                EXCEL出力（実装予定）
              </button>
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
            onClick={() => setShowOrtho((v) => !v)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${
              showOrtho ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-gray-50 border-gray-300'
            }`}
            title="オルソ画像の表示を切替"
          >
            <ImageIcon className="h-3 w-3" />
            オルソ
          </button>
          <div className="flex items-center gap-2 flex-wrap">
            {typeOptions.map((opt) => (
              <label key={opt.code} className="flex items-center gap-1 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={visibleTypes.has(opt.code)}
                  onChange={(e) => {
                    const newTypes = new Set(visibleTypes)
                    if (e.target.checked) {
                      newTypes.add(opt.code)
                    } else {
                      newTypes.delete(opt.code)
                    }
                    setVisibleTypes(newTypes)
                  }}
                  className="h-3 w-3"
                />
                {opt.label}
              </label>
            ))}
            <button
              onClick={() => setShowPointTypeModal(true)}
              className="ml-1 p-0.5 text-slate-500 hover:text-slate-800 rounded"
              title="点種を管理"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          </div>
          {renderWorkAreaLayers()}
          <select
            value={baseLayer}
            onChange={(e) => setBaseLayer(e.target.value as BaseLayerType)}
            className="px-2 py-1 text-xs border rounded bg-white"
          >
            <option value="osm">地図</option>
            <option value="gsi-photo">航空写真</option>
            <option value="gsi-std">地理院地図</option>
          </select>
        </div>
        <div className="flex-1">
          <CoordinateMap
            key={currentFarm?.id ?? 'no-farm'}
            selectedPointId={selectedPointId}
            onPointSelect={handlePointClick}
            showLabels={showLabels}
            visibleTypes={visibleTypes}
            baseLayer={baseLayer}
            route={route}
            showRoute={true}
            farmId={currentFarm?.id ?? null}
            showOrtho={showOrtho}
            externalPolygons={workAreaPolygons}
            lineSelectMode={!!calcLineAssign}
            onLineSelect={(a, b) => calcLineAssign?.(a, b)}
          />
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
        <div className="flex-1 overflow-auto">
          {renderBulkBar()}
          <table className="min-w-full w-max text-sm">
            <thead className="bg-slate-100 sticky top-0">
              <tr>
                <th className="px-1 py-2 w-8 text-center">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={toggleCheckAll}
                    className="cursor-pointer"
                    aria-label="全選択"
                  />
                </th>
                <th className="px-0.5 py-2 text-left font-medium">点番号</th>
                <th className="pr-2 pl-1 py-2 text-right font-medium w-28">X (m)</th>
                <th className="pr-2 pl-1 py-2 text-right font-medium w-28">Y (m)</th>
                <th className="pr-2 pl-1 py-2 text-right font-medium w-20">Z (m)</th>
                <th className="px-0.5 py-2 text-left font-medium">種類</th>
                <th className="px-0.5 py-2 text-left font-medium">杭種</th>
                <th className="px-0.5 py-2 text-right font-medium">緯度</th>
                <th className="px-0.5 py-2 text-right font-medium">経度</th>
                <th className="px-0.5 py-2 text-left font-medium whitespace-nowrap">更新者</th>
                <th className="px-0.5 py-2 text-left font-medium whitespace-nowrap">更新日時</th>
                <th className="px-1 py-2 w-16"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {coordinates.map((coord, idx) => (
                <tr
                  key={coord.id}
                  ref={idx === coordinates.length - 1 ? lastRowRef : null}
                  className={`hover:bg-slate-50 cursor-pointer ${
                    selectedPointId === coord.id ? 'bg-blue-50' : ''
                  }`}
                  onClick={() => handlePointClick(coord.id)}
                >
                  <td className="px-1 py-0.5 text-center" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={checkedIds.has(coord.id)}
                      onChange={() => toggleCheck(coord.id)}
                      className="cursor-pointer"
                      aria-label={`${coord.pointNumber} を選択`}
                    />
                  </td>
                  <td className="px-0.5 py-0.5">
                    <input
                      type="text"
                      value={coord.pointNumber}
                      onChange={(e) => updateCoordinate(coord.id, 'pointNumber', e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-full min-w-[6rem] px-1 py-0.5 border rounded text-sm"
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
                      value={coord.type}
                      onChange={(e) => updateCoordinate(coord.id, 'type', e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="px-1 py-0.5 border rounded text-xs"
                    >
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
                  <td className="px-1 py-0.5 flex items-center gap-0.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setPhotoCoordId(coord.id)
                      }}
                      className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                      title="写真"
                    >
                      <Camera className="h-3.5 w-3.5" />
                    </button>
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
              ))}
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
      <PageHeader title="座標管理" subtitle="平面直角座標の登録" />

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

              {/* 座標テーブル */}
              <div className="flex-1 overflow-auto">
                {renderBulkBar()}
                <table className="min-w-full w-max text-sm">
                  <thead className="bg-slate-100 sticky top-0">
                    <tr>
                      <th className="px-1 py-2 w-8 text-center">
                        <input
                          type="checkbox"
                          checked={allChecked}
                          onChange={toggleCheckAll}
                          className="cursor-pointer"
                          aria-label="全選択"
                        />
                      </th>
                      <th className="px-0.5 py-2 text-left font-medium">点番号</th>
                      <th className="pr-2 pl-1 py-2 text-right font-medium w-28">X (m)</th>
                      <th className="pr-2 pl-1 py-2 text-right font-medium w-28">Y (m)</th>
                      <th className="pr-2 pl-1 py-2 text-right font-medium w-20">Z (m)</th>
                      <th className="px-0.5 py-2 text-left font-medium">種類</th>
                      <th className="px-0.5 py-2 text-left font-medium">杭種</th>
                      <th className="px-0.5 py-2 text-right font-medium">緯度</th>
                      <th className="px-0.5 py-2 text-right font-medium">経度</th>
                      <th className="px-0.5 py-2 text-left font-medium whitespace-nowrap">更新者</th>
                      <th className="px-0.5 py-2 text-left font-medium whitespace-nowrap">更新日時</th>
                      <th className="px-1 py-2 w-16"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {coordinates.map((coord, idx) => (
                      <tr
                        key={coord.id}
                        ref={idx === coordinates.length - 1 ? lastRowRef : null}
                        className={`hover:bg-slate-50 cursor-pointer ${
                          selectedPointId === coord.id ? 'bg-blue-50' : ''
                        }`}
                        onClick={() => handlePointClick(coord.id)}
                      >
                        <td className="px-1 py-0.5 text-center" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={checkedIds.has(coord.id)}
                            onChange={() => toggleCheck(coord.id)}
                            className="cursor-pointer"
                            aria-label={`${coord.pointNumber} を選択`}
                          />
                        </td>
                        <td className="px-0.5 py-0.5">
                          <input
                            type="text"
                            value={coord.pointNumber}
                            onChange={(e) => updateCoordinate(coord.id, 'pointNumber', e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full min-w-[6rem] px-1 py-0.5 border rounded text-sm"
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
                            value={coord.type}
                            onChange={(e) => updateCoordinate(coord.id, 'type', e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            className="px-1 py-0.5 border rounded text-xs"
                          >
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
                    ))}
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
              onClick={() => setShowOrtho((v) => !v)}
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${
                showOrtho ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-gray-50 border-gray-300'
              }`}
              title="オルソ画像の表示を切替"
            >
              <ImageIcon className="h-3 w-3" />
              オルソ
            </button>
            <div className="flex items-center gap-2 flex-wrap">
              {typeOptions.map((opt) => (
                <label key={opt.code} className="flex items-center gap-1 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={visibleTypes.has(opt.code)}
                    onChange={(e) => {
                      const newTypes = new Set(visibleTypes)
                      if (e.target.checked) {
                        newTypes.add(opt.code)
                      } else {
                        newTypes.delete(opt.code)
                      }
                      setVisibleTypes(newTypes)
                    }}
                    className="h-3 w-3"
                  />
                  {opt.label}
                </label>
              ))}
              <button
                onClick={() => setShowPointTypeModal(true)}
                className="ml-1 p-0.5 text-slate-500 hover:text-slate-800 rounded"
                title="点種を管理"
              >
                <Settings className="h-3.5 w-3.5" />
              </button>
            </div>
            {renderWorkAreaLayers()}
            <select
              value={baseLayer}
              onChange={(e) => setBaseLayer(e.target.value as BaseLayerType)}
              className="px-2 py-1 text-xs border rounded bg-white"
            >
              <option value="osm">地図</option>
              <option value="gsi-photo">航空写真</option>
              <option value="gsi-std">地理院地図</option>
            </select>
          </div>
          <div className="flex-1 relative">
            <CoordinateMap
              key={currentFarm?.id ?? 'no-farm'}
              selectedPointId={selectedPointId}
              onPointSelect={handlePointClick}
              showLabels={showLabels}
              visibleTypes={visibleTypes}
              baseLayer={baseLayer}
              route={route}
              showRoute={true}
              farmId={currentFarm?.id ?? null}
              showOrtho={showOrtho}
              externalPolygons={workAreaPolygons}
              lineSelectMode={!!calcLineAssign}
              onLineSelect={(a, b) => calcLineAssign?.(a, b)}
            />

            {/* 経路パネル（地図右上にオーバーレイ） */}
            {(routeMode || route.length > 0) && (
              <div className="absolute top-2 right-2 z-[1000] w-64 max-h-[60vh] flex flex-col bg-white border border-slate-300 rounded shadow-lg">
                <div className="px-2 py-1.5 border-b flex items-center justify-between bg-slate-50 rounded-t">
                  <span className="text-xs font-medium text-slate-700 flex items-center gap-1">
                    <Route className="h-3 w-3" />
                    経路 ({route.length})
                  </span>
                  {route.length > 0 && (
                    <button
                      onClick={() => {
                        if (confirm('経路を全てクリアしますか？')) clearRoute()
                      }}
                      className="text-[10px] text-red-600 hover:text-red-800"
                      title="経路を全てクリア"
                    >
                      クリア
                    </button>
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
              </div>
            )}
          </div>
        </div>
        }
      />

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
