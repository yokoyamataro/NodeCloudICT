import { useState, useMemo, useEffect } from 'react'
import { MapPin, Settings, Hash, Navigation, Target, Square, Map, MousePointer, Route, Table } from 'lucide-react'
import ExcelJS from 'exceljs'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import type { CoordinateType } from '@/types/database'
import { CoordinateConverter } from '@/lib/coordinates'
import { useFarmStore } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
// useExportRouteStore は 「順路 の サーバ保存」 で 使って いた が、 その 機能 は
// 「座標管理 → 測設」 ページ に 移設 したため ここ では 不要。
import { PipeMap, type SurveyPointData, type BaseLayerType } from '@/components/map/PipeMap'
import { ResizableSplit } from '@/components/layout/ResizableSplit'

// 測点命名設定
interface NamingSettings {
  upstream: string    // 最上流の記号 (デフォルト: C)
  downstream: string  // 最下流の記号 (デフォルト: A)
  middle: string      // 中間の記号 (デフォルト: B)
}

// 計算された測点
interface SurveyPoint {
  id: string
  pipeId: string
  pipeNumber: string
  position: 'upstream' | 'downstream' | 'middle'
  middleIndex?: number  // 中間点の場合のインデックス（下流から）
  name: string          // 生成された名前（例: 1C, 1A, 1B1）
  mergedName?: string   // 集約後の名前（例: 1A.2C）
  x: number
  y: number
  z: number | null
}

// 座標管理からの点
interface CoordinatePoint {
  id: string
  pointNumber: string
  x: number
  y: number
  z: number | null
  type: string
}

// 選択された出力点
interface ExportPoint {
  id: string
  name: string
  x: number
  y: number
  z: number | null
  source: 'pipe' | 'coordinate'  // 管路からか座標管理からか
  type?: string  // 座標管理の場合の点種（control, boundary, underdrain等）
}

// 同一点集約結果
interface MergedPoint {
  id: string
  originalPoints: SurveyPoint[]
  mergedName: string
  x: number
  y: number
  z: number | null
}

// 同一点判定の閾値（メートル）
const MERGE_THRESHOLD = 0.1 // 10cm

export function PipeCoordinateCalcPage() {
  const { pipes, fetchPipes } = useUnderdrainStore()
  const { coordinates, fetchCoordinates, zone, importCoordinates } = useCoordinateStore()
  const { currentFarm } = useFarmStore()
  const { projects } = useProjectListStore()

  // プロジェクト選択時にデータを読み込む
  useEffect(() => {
    if (currentFarm) {
      const project = projects.find((p) => p.id === currentFarm.project_id)
      if (project) {
        const { setZone } = useCoordinateStore.getState()
        setZone(project.coordinate_zone)
      }
      fetchPipes(currentFarm.id)
      fetchCoordinates(currentFarm.id)
    }
  }, [currentFarm, projects, fetchPipes, fetchCoordinates])

  // 命名設定
  const [namingSettings, setNamingSettings] = useState<NamingSettings>({
    upstream: 'C',
    downstream: 'A',
    middle: 'B',
  })

  // 設定パネルの表示
  const [showSettings, setShowSettings] = useState(false)

  // 同一点集約を実行するか
  const [enableMerge, setEnableMerge] = useState(true)

  // 選択中の点
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null)

  // 地図表示設定
  const [showLabels, setShowLabels] = useState(true)
  const [showDirection, setShowDirection] = useState(true)
  const [showSurveyPoints, setShowSurveyPoints] = useState(true)
  const [showZones, setShowZones] = useState(false)
  const [showCoordinates, setShowCoordinates] = useState(true)
  const [showSelectedRoute, setShowSelectedRoute] = useState(true)
  const [baseLayer, setBaseLayer] = useState<BaseLayerType>('osm')

  // 出力点選択モード (順路選択) は 「座標管理 → 測設」 に 移設 (2026-10)。
  // ここ では 残置 状態 を 使う 箇所 (地図 の 選択表示 など) を 無害化 した 残骸 のみ 残す。
  const isSelectMode = false
  const exportPoints: ExportPoint[] = []

  // 「座標管理に登録」 ボタン の 実行中 フラグ
  const [registering, setRegistering] = useState(false)

  // 測点を生成
  const surveyPoints = useMemo(() => {
    const points: SurveyPoint[] = []

    for (const pipe of pipes) {
      if (pipe.vertices.length < 2) continue

      const vertices = pipe.vertices

      // 最上流（始点）
      points.push({
        id: `${pipe.id}-upstream`,
        pipeId: pipe.id,
        pipeNumber: pipe.number,
        position: 'upstream',
        name: `${pipe.number}${namingSettings.upstream}`,
        x: vertices[0].x,
        y: vertices[0].y,
        z: vertices[0].z,
      })

      // 中間点（下流から順にB1, B2, B3...）
      if (vertices.length > 2) {
        // 中間点のインデックス（終点を除く、始点を除く）
        // vertices[1] から vertices[length-2] まで
        const middleCount = vertices.length - 2
        for (let i = 0; i < middleCount; i++) {
          // 下流から順なので、実際の配列インデックスは逆順
          const vertexIndex = vertices.length - 2 - i
          const middleIndex = i + 1 // B1, B2, B3...

          points.push({
            id: `${pipe.id}-middle-${middleIndex}`,
            pipeId: pipe.id,
            pipeNumber: pipe.number,
            position: 'middle',
            middleIndex,
            name: `${pipe.number}${namingSettings.middle}${middleIndex}`,
            x: vertices[vertexIndex].x,
            y: vertices[vertexIndex].y,
            z: vertices[vertexIndex].z,
          })
        }
      }

      // 最下流（終点）
      const lastVertex = vertices[vertices.length - 1]
      points.push({
        id: `${pipe.id}-downstream`,
        pipeId: pipe.id,
        pipeNumber: pipe.number,
        position: 'downstream',
        name: `${pipe.number}${namingSettings.downstream}`,
        x: lastVertex.x,
        y: lastVertex.y,
        z: lastVertex.z,
      })
    }

    return points
  }, [pipes, namingSettings])

  // 座標管理からの点を変換
  const coordinatePoints: CoordinatePoint[] = useMemo(() => {
    return coordinates.map(coord => ({
      id: coord.id,
      pointNumber: coord.pointNumber,
      x: coord.x,
      y: coord.y,
      z: coord.z,
      type: coord.type,
    }))
  }, [coordinates])

  // 同一点を集約
  const mergedPoints = useMemo(() => {
    if (!enableMerge) {
      // 集約しない場合はそのまま返す
      return surveyPoints.map(point => ({
        id: point.id,
        originalPoints: [point],
        mergedName: point.name,
        x: point.x,
        y: point.y,
        z: point.z,
      }))
    }

    const result: MergedPoint[] = []
    const processed = new Set<string>()

    for (const point of surveyPoints) {
      if (processed.has(point.id)) continue

      // この点と同一位置の点を探す
      const samePoints = surveyPoints.filter(p => {
        if (processed.has(p.id)) return false
        const dx = p.x - point.x
        const dy = p.y - point.y
        return Math.sqrt(dx * dx + dy * dy) <= MERGE_THRESHOLD
      })

      // 集約名を生成（ピリオドで連結）
      const mergedName = samePoints.map(p => p.name).join('.')

      // 処理済みにマーク
      for (const p of samePoints) {
        processed.add(p.id)
      }

      // Z座標は最初の非nullを使用
      const z = samePoints.find(p => p.z !== null)?.z ?? null

      result.push({
        id: samePoints.map(p => p.id).join('-'),
        originalPoints: samePoints,
        mergedName,
        x: point.x,
        y: point.y,
        z,
      })
    }

    return result
  }, [surveyPoints, enableMerge])

  // 地図表示用の測点データを生成
  const mapSurveyPoints: SurveyPointData[] = useMemo(() => {
    return mergedPoints.map(point => ({
      id: point.id,
      name: point.mergedName,
      x: point.x,
      y: point.y,
      z: point.z,
      isMerged: point.originalPoints.length > 1,
      originalCount: point.originalPoints.length,
    }))
  }, [mergedPoints])

  // 選択中の出力点IDセット
  const selectedPointIdsSet = useMemo(() => {
    return new Set(exportPoints.map(p => p.id))
  }, [exportPoints])

  // 選択した点を結ぶルートの座標（緯度経度）を計算
  const selectedPointRoute = useMemo(() => {
    if (exportPoints.length < 2) return []

    const converter = new CoordinateConverter(zone)

    return exportPoints.map(point => {
      const { lat, lng } = converter.toLatLng(point.x, point.y)
      return [lat, lng] as [number, number]
    })
  }, [exportPoints, zone])

  // 地図 の 点 を クリック した 時 の 挙動。 「出力点選択」 機能 は 測設 ページ に
  // 移設 した の で、 ここ では 単に ハイライト 用 の 選択点 を 更新 する だけ。
  const handlePointClick = (pointId: string) => {
    setSelectedPointId(pointId)
  }

  /**
   * 座標計算 の 結果 (集約後 の 測点) を 座標管理 (design_coordinates) に 新規 登録 する。
   *
   * 既存 の 同名 座標 が ある 場合 は 自動 で 「-2」「-3」… を 付けて 衝突 回避。
   * 「順路 の 選択」 は 座標管理 → 測設 ページ で、 ここ で 登録 した 点 を 対象 に 行う。
   */
  const handleRegisterToCoordinates = async () => {
    if (!currentFarm) {
      alert('工区が選択されていません')
      return
    }
    if (mergedPoints.length === 0) {
      alert('登録する測点がありません。 管路から測点を生成してください。')
      return
    }
    const existingNames = new Set(coordinates.map((c) => c.pointNumber))
    // 既存 の 点名 と 衝突 する 場合 は 連番 を 振る (-2, -3, ...)
    const makeUnique = (name: string): string => {
      if (!existingNames.has(name)) return name
      for (let i = 2; i < 1000; i += 1) {
        const cand = `${name}-${i}`
        if (!existingNames.has(cand)) return cand
      }
      return `${name}-${Date.now()}`
    }
    const toInsert = mergedPoints.map((p) => {
      const name = makeUnique(p.mergedName)
      existingNames.add(name) // 同一 バッチ内 で も 衝突 を 避ける
      return {
        pointNumber: name,
        x: p.x,
        y: p.y,
        z: p.z ?? null,
        // 暗渠 として 登録。 座標管理 で は 種別 「暗渠」 と 表示 される。
        type: 'underdrain' as unknown as CoordinateType,
      }
    })
    const confirmed = window.confirm(
      `${toInsert.length} 点を 座標管理 に 登録 します。 よろしい ですか？\n` +
        '順路の選択 は 「座標管理 → 測設」 で 行います。',
    )
    if (!confirmed) return
    setRegistering(true)
    try {
      const inserted = await importCoordinates(toInsert)
      if (inserted.length > 0) {
        alert(`${inserted.length} 点 を 座標管理 に 登録 しました。`)
      } else {
        const err = useCoordinateStore.getState().error ?? '不明なエラー'
        alert(`登録 に 失敗 しました: ${err}`)
      }
    } finally {
      setRegistering(false)
    }
  }

  // SIMA 出力 は 「座標管理 → 測設」 ページ に 移設 (順路 の 並び順 で 出力 する ため)

  // 点種の日本語名マップ
  const TYPE_NAMES: Record<string, string> = {
    control: '基準点',
    boundary: '境界点',
    underdrain: '暗渠構成点',
    soil_import: '客土構成点',
    stake: '測点',
    pipe: '管路測点',
  }

  // Excelエクスポート
  const handleExportExcel = async () => {
    const farmName = currentFarm?.name || 'NoName'
    const projectObj = currentFarm
      ? projects.find((p) => p.id === currentFarm.project_id)
      : null
    const projectName = projectObj?.name || ''

    // 出力データを準備
    const pointsToExport = exportPoints.length > 0 ? exportPoints : [
      ...mergedPoints.map(p => ({
        name: p.mergedName,
        x: p.x,
        y: p.y,
        z: p.z,
        source: 'pipe' as const,
        type: undefined,
      })),
      ...coordinatePoints.map(p => ({
        name: p.pointNumber,
        x: p.x,
        y: p.y,
        z: p.z,
        source: 'coordinate' as const,
        type: p.type,
      })),
    ]

    // ワークブックを作成
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('座標一覧')

    // 列幅を設定 (点種を Z の右へ)
    ws.columns = [
      { key: 'no', width: 6 },     // 番号
      { key: 'name', width: 20 },  // 点名
      { key: 'x', width: 14 },     // X
      { key: 'y', width: 14 },     // Y
      { key: 'z', width: 10 },     // Z
      { key: 'type', width: 14 },  // 点種 (Z の右)
    ]

    // 1 行目: タイトル (現場名 › 工区名) を全列にマージ
    const titleText = projectName
      ? `${projectName} › ${farmName}`
      : farmName
    ws.mergeCells('A1:F1')
    const titleCell = ws.getCell('A1')
    titleCell.value = titleText
    titleCell.font = { bold: true, size: 12 }
    titleCell.alignment = { vertical: 'middle', horizontal: 'left' }

    // 2 行目: 点種ごとの点数サマリ (基準点X点 / 管路測点Y点 / 境界点Z点 ...)
    const typeCounts: Record<string, number> = {}
    pointsToExport.forEach((point) => {
      const key =
        point.source === 'pipe'
          ? TYPE_NAMES.pipe
          : TYPE_NAMES[point.type || ''] || point.type || 'その他'
      typeCounts[key] = (typeCounts[key] ?? 0) + 1
    })
    // 表示順: 基準点 / 管路測点 / 境界点 / 暗渠構成点 / 客土構成点 / 測点 / その他
    const summaryOrder = [
      TYPE_NAMES.control,
      TYPE_NAMES.pipe,
      TYPE_NAMES.boundary,
      TYPE_NAMES.underdrain,
      TYPE_NAMES.soil_import,
      TYPE_NAMES.stake,
    ]
    const summaryParts = summaryOrder.map(
      (label) => `${label}${typeCounts[label] ?? 0}点`,
    )
    // 上記に含まれない型 (customType 等) は後尾に付与
    for (const [k, v] of Object.entries(typeCounts)) {
      if (!summaryOrder.includes(k)) summaryParts.push(`${k}${v}点`)
    }
    ws.mergeCells('A2:F2')
    const summaryCell = ws.getCell('A2')
    summaryCell.value = summaryParts.join(' / ')
    summaryCell.font = { size: 10 }
    summaryCell.alignment = { vertical: 'middle', horizontal: 'left' }

    // 3 行目: 列ヘッダー
    const headerRow = ws.getRow(3)
    headerRow.values = ['番号', '点名', 'X (m)', 'Y (m)', 'Z (m)', '点種']
    headerRow.font = { bold: true }
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' }
    headerRow.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin' },
        bottom: { style: 'thin' },
        left: { style: 'thin' },
        right: { style: 'thin' },
      }
    })

    // 4 行目以降: データ
    let pipeSeq = 0 // 管路測点だけをカウントして 10 ごとに罫線
    pointsToExport.forEach((point, index) => {
      const typeLabel =
        point.source === 'pipe'
          ? TYPE_NAMES.pipe
          : TYPE_NAMES[point.type || ''] || point.type || ''
      const row = ws.getRow(index + 4)
      row.values = [
        index + 1,
        point.name,
        Number(point.x.toFixed(3)),
        Number(point.y.toFixed(3)),
        point.z != null ? Number(point.z.toFixed(3)) : null,
        typeLabel,
      ]
      // 数値の書式 (小数 3 桁)
      row.getCell(3).numFmt = '0.000'
      row.getCell(4).numFmt = '0.000'
      row.getCell(5).numFmt = '0.000'
      // 管路測点 10 点ごとに下罫線
      if (point.source === 'pipe') {
        pipeSeq++
        if (pipeSeq % 10 === 0) {
          row.eachCell({ includeEmpty: true }, (cell) => {
            cell.border = { ...(cell.border || {}), bottom: { style: 'thin' } }
          })
        }
      }
    })

    // ダウンロード
    const buffer = await wb.xlsx.writeBuffer()
    const blob = new Blob([buffer as unknown as BlobPart], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${farmName}_座標一覧.xlsx`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // 工区が選択されていない場合のエラー表示
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
      {/* ヘッダー */}
      <div className="p-4 border-b bg-white flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            座標計算
          </h1>
          <p className="text-sm text-muted-foreground">
            管路の頂点から測点座標を生成・同一点を集約
          </p>
        </div>
      </div>

      {/* メインコンテンツ */}
      <ResizableSplit
        storageKey="pipe-coordinate-calc"
        defaultLeft={620}
        minLeft={320}
        maxLeft={1400}
        className="flex-1"
        left={
        <div className="flex-1 flex flex-col overflow-hidden border-r">
          {/* 出力ボタン */}
          <div className="p-3 bg-slate-50 border-b text-sm flex items-center justify-end">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowSettings(!showSettings)}
                className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 ${
                  showSettings ? 'bg-blue-50 border-blue-300' : ''
                }`}
              >
                <Settings className="h-4 w-4" />
                命名設定
              </button>
              <button
                onClick={handleRegisterToCoordinates}
                disabled={registering || mergedPoints.length === 0}
                className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded disabled:opacity-50 disabled:cursor-not-allowed bg-blue-600 text-white border-blue-700 hover:bg-blue-700"
                title="計算結果の測点を座標管理に新規登録 (順路は「座標管理 → 測設」で選ぶ)"
              >
                <Map className="h-4 w-4" />
                {registering ? '登録中…' : '座標管理に登録'}
              </button>
              <button
                onClick={handleExportExcel}
                disabled={mergedPoints.length === 0 && coordinatePoints.length === 0}
                className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed bg-green-50 border-green-300 text-green-700"
              >
                <Table className="h-4 w-4" />
                Excel出力
              </button>
            </div>
          </div>

          {/* 設定パネル */}
          {showSettings && (
            <div className="p-4 bg-blue-50 border-b">
              <h3 className="text-sm font-medium mb-3">測点命名規則</h3>
              <div className="grid grid-cols-3 gap-4 max-w-lg">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">最上流</label>
                  <input
                    type="text"
                    value={namingSettings.upstream}
                    onChange={(e) => setNamingSettings(prev => ({ ...prev, upstream: e.target.value }))}
                    className="w-full px-2 py-1.5 border rounded text-sm"
                    placeholder="C"
                  />
                  <p className="text-xs text-muted-foreground mt-1">例: 1C</p>
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">最下流</label>
                  <input
                    type="text"
                    value={namingSettings.downstream}
                    onChange={(e) => setNamingSettings(prev => ({ ...prev, downstream: e.target.value }))}
                    className="w-full px-2 py-1.5 border rounded text-sm"
                    placeholder="A"
                  />
                  <p className="text-xs text-muted-foreground mt-1">例: 1A</p>
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">中間</label>
                  <input
                    type="text"
                    value={namingSettings.middle}
                    onChange={(e) => setNamingSettings(prev => ({ ...prev, middle: e.target.value }))}
                    className="w-full px-2 py-1.5 border rounded text-sm"
                    placeholder="B"
                  />
                  <p className="text-xs text-muted-foreground mt-1">例: 1B1, 1B2...</p>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <input
                  type="checkbox"
                  id="enableMerge"
                  checked={enableMerge}
                  onChange={(e) => setEnableMerge(e.target.checked)}
                  className="h-4 w-4"
                />
                <label htmlFor="enableMerge" className="text-sm">
                  同一点を集約（{MERGE_THRESHOLD * 100}cm以内の点を統合）
                </label>
              </div>
            </div>
          )}

          {/* 出力点選択 (順路) / SIMA 出力 / JSON / サーバ保存 は
              「座標管理 → 測設」 ページ に 移設 (2026-10)。
              この ページ は 管路 からの 測点生成 + 命名 + 座標管理 に 登録 まで。 */}

          {/* 測点一覧 テーブル */}
          <div className="flex-1 overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 sticky top-0 z-10">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">点名</th>
                  <th className="px-3 py-2 text-right font-medium">X (m)</th>
                  <th className="px-3 py-2 text-right font-medium">Y (m)</th>
                  <th className="px-3 py-2 text-right font-medium">Z (m)</th>
                  {enableMerge && (
                    <th className="px-3 py-2 text-center font-medium">集約</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y">
                {mergedPoints.map((point) => {
                  const isMerged = point.originalPoints.length > 1
                  const isInExport = exportPoints.some(p => p.id === point.id)
                  return (
                    <tr
                      key={point.id}
                      className={`hover:bg-slate-50 cursor-pointer ${
                        selectedPointId === point.id ? 'bg-blue-50' : ''
                      } ${isMerged ? 'bg-yellow-50' : ''} ${isInExport ? 'bg-green-50' : ''}`}
                      onClick={() => handlePointClick(point.id)}
                    >
                      <td className="px-3 py-2 font-mono">
                        {isInExport && (
                          <span className="inline-flex items-center justify-center w-4 h-4 text-xs bg-green-600 text-white rounded-full mr-1">
                            {exportPoints.findIndex(p => p.id === point.id) + 1}
                          </span>
                        )}
                        {point.mergedName}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {point.x.toFixed(3)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {point.y.toFixed(3)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {point.z?.toFixed(3) ?? '-'}
                      </td>
                      {enableMerge && (
                        <td className="px-3 py-2 text-center">
                          {isMerged && (
                            <span className="inline-flex items-center px-2 py-0.5 text-xs bg-yellow-200 text-yellow-800 rounded">
                              {point.originalPoints.length}点
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}

                {/* 座標管理の点も表示（選択モード中は特に目立つように） */}
                {coordinatePoints.length > 0 && (
                  <>
                    <tr className="bg-orange-100">
                      <td colSpan={enableMerge ? 5 : 4} className="px-3 py-2 text-sm font-medium text-orange-800">
                        座標管理の点
                      </td>
                    </tr>
                    {coordinatePoints.map((point) => {
                      const isInExport = exportPoints.some(p => p.id === point.id)
                      return (
                        <tr
                          key={point.id}
                          className={`hover:bg-slate-50 cursor-pointer ${
                            selectedPointId === point.id ? 'bg-blue-50' : ''
                          } ${isInExport ? 'bg-green-50' : ''}`}
                          onClick={() => handlePointClick(point.id)}
                        >
                          <td className="px-3 py-2 font-mono">
                            {isInExport && (
                              <span className="inline-flex items-center justify-center w-4 h-4 text-xs bg-green-600 text-white rounded-full mr-1">
                                {exportPoints.findIndex(p => p.id === point.id) + 1}
                              </span>
                            )}
                            {point.pointNumber}
                            <span className="ml-2 text-xs text-orange-600">({point.type})</span>
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {point.x.toFixed(3)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {point.y.toFixed(3)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {point.z?.toFixed(3) ?? '-'}
                          </td>
                          {enableMerge && <td></td>}
                        </tr>
                      )
                    })}
                  </>
                )}

                {mergedPoints.length === 0 && coordinatePoints.length === 0 && (
                  <tr>
                    <td colSpan={enableMerge ? 5 : 4} className="px-4 py-8 text-center text-muted-foreground">
                      管路データがありません。CAD解析で管路を登録してください。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        }
        right={
        <div className="flex-1 flex flex-col bg-slate-100">
          {/* 地図表示ボタン */}
          <div className="p-2 bg-white border-b flex items-center gap-2">
            <button
              onClick={() => setShowLabels(!showLabels)}
              className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 ${
                showLabels ? 'bg-blue-50 border-blue-300 text-blue-700' : ''
              }`}
            >
              <Hash className="h-4 w-4" />
              番号表示
            </button>
            <button
              onClick={() => setShowDirection(!showDirection)}
              className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 ${
                showDirection ? 'bg-blue-50 border-blue-300 text-blue-700' : ''
              }`}
            >
              <Navigation className="h-4 w-4" />
              方向表示
            </button>
            <button
              onClick={() => setShowSurveyPoints(!showSurveyPoints)}
              className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 ${
                showSurveyPoints ? 'bg-green-50 border-green-300 text-green-700' : ''
              }`}
            >
              <Target className="h-4 w-4" />
              測点表示
            </button>
            <div className="border-l h-6 mx-1" />
            <button
              onClick={() => setShowZones(!showZones)}
              className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 ${
                showZones ? 'bg-purple-50 border-purple-300 text-purple-700' : ''
              }`}
            >
              <Square className="h-4 w-4" />
              区域
            </button>
            <button
              onClick={() => setShowCoordinates(!showCoordinates)}
              className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 ${
                showCoordinates ? 'bg-orange-50 border-orange-300 text-orange-700' : ''
              }`}
            >
              <Map className="h-4 w-4" />
              座標
            </button>
            {exportPoints.length >= 2 && (
              <button
                onClick={() => setShowSelectedRoute(!showSelectedRoute)}
                className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 ${
                  showSelectedRoute ? 'bg-orange-50 border-orange-300 text-orange-700' : ''
                }`}
              >
                <Route className="h-4 w-4" />
                ルート
              </button>
            )}
            <select
              value={baseLayer}
              onChange={(e) => setBaseLayer(e.target.value as BaseLayerType)}
              className="px-2 py-1.5 text-sm border rounded bg-white"
            >
              <option value="osm">地図</option>
              <option value="gsi-photo">航空写真</option>
              <option value="gsi-std">地理院地図</option>
            </select>
          </div>
          {/* 選択モード表示 */}
          {isSelectMode && (
            <div className="px-3 py-2 bg-green-100 border-b text-sm text-green-800 flex items-center gap-2">
              <MousePointer className="h-4 w-4" />
              地図上の点をクリックして出力順序を指定
            </div>
          )}
          {/* 地図 */}
          <div className="flex-1">
            <PipeMap
              showLabels={showLabels}
              showDirection={showDirection}
              showSurveyPoints={showSurveyPoints}
              surveyPoints={mapSurveyPoints}
              showZones={showZones}
              showCoordinates={showCoordinates}
              onPointClick={isSelectMode ? handlePointClick : undefined}
              selectablePoints={isSelectMode}
              selectedPointIds={selectedPointIdsSet}
              selectedPointRoute={selectedPointRoute}
              showSelectedRoute={showSelectedRoute}
              baseLayer={baseLayer}
            />
          </div>
        </div>
        }
      />
    </div>
  )
}
