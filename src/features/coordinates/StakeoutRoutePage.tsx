// 測設 ページ (/stakeout)。 座標管理 > 測設。
//
// 役割:
//   - 座標管理 に 登録 済み の 点 を 右側 の 地図 で 見ながら、 左側 で 現場 で 落とす
//     「順路 (ルート)」 を 作成 する。
//   - 作成 した 順路 は スマホ 杭打ち (起工 測量) で 使う 「保存済み ルート」 として
//     サーバ に 保存。
//
// 内部 的 に は 座標管理 と 同じ useCoordinateStore の route 系 API を 使う:
//   appendRoutePoint / removeRoutePoint / setRouteDirection / moveRoutePoint
//   / clearRoute / saveRoute / fetchRoute。 座標 一覧 ページ の 「経路モード」
//   と 共有 される の で、 同じ 編集中 ルート が 両画面 で 見える 挙動 と なる。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Route, X } from 'lucide-react'
import { Polyline as LeafletPolyline, CircleMarker, Tooltip } from 'react-leaflet'
import { CoordinateMap } from '@/components/map/CoordinateMap'
import { OpenChannelOverlay } from '@/components/map/OpenChannelOverlay'
import { MapLayerControl } from '@/components/map/MapLayerControl'
import { ResizableSplit } from '@/components/layout/ResizableSplit'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useFarmStore } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useUnderdrainStore, type PipeRow } from '@/stores/underdrainStore'
import { useOpenChannelStore } from '@/stores/openChannelStore'
import { useMapLayersStore } from '@/stores/mapLayersStore'
import { useExportRouteStore } from '@/stores/exportRouteStore'
import { CoordinateConverter } from '@/lib/coordinates'
import { buildChannelOverlay } from '@/lib/openChannel/overlayRender'

// 「+ 新規」 タブ の 識別子
const NEW_ROUTE_KEY = '__new__'

export function StakeoutRoutePage() {
  const { currentFarm } = useFarmStore()
  const { projects } = useProjectListStore()

  const coordinates = useCoordinateStore((s) => s.coordinates)
  const fetchCoordinates = useCoordinateStore((s) => s.fetchCoordinates)
  const zone = useCoordinateStore((s) => s.zone)
  const route = useCoordinateStore((s) => s.route)
  const fetchRoute = useCoordinateStore((s) => s.fetchRoute)
  const appendRoutePoint = useCoordinateStore((s) => s.appendRoutePoint)
  const removeRoutePoint = useCoordinateStore((s) => s.removeRoutePoint)
  const moveRoutePoint = useCoordinateStore((s) => s.moveRoutePoint)
  const setRouteDirection = useCoordinateStore((s) => s.setRouteDirection)
  const saveRoute = useCoordinateStore((s) => s.saveRoute)

  // 暗渠 配線 + 線形物 の 読取 (全体図 と 同じ 見た目 に 揃える)
  const fetchPipes = useUnderdrainStore((s) => s.fetchPipes)
  const pipes = useUnderdrainStore((s) => s.pipes)
  const fetchOpenChannels = useOpenChannelStore((s) => s.fetchChannels)
  const openChannels = useOpenChannelStore((s) => s.channels)

  // 地図 の レイヤ 表示 設定 (全ページ 共通)
  const layerVis = useMapLayersStore((s) => s.visibility)
  const showPipes = layerVis['pipes'] !== false
  const showChannels = layerVis['channels'] !== false

  // 測点 の 可視 type Set を 作る。 既定 (visibility 未登録) は 表示。
  // 'control' / 'boundary' / 'current' / 'measured' / 'underdrain' は 個別 切替、
  // それ 以外 は 「その他」 (map_xml, witness, tombo, chohari 等) に まとめる。
  const visibleTypes = useMemo(() => {
    const builtin: Record<string, string> = {
      control: 'points.control',
      boundary: 'points.boundary',
      current: 'points.current',
      measured: 'points.measured',
      underdrain: 'points.underdrain',
    }
    const otherVisible = layerVis['points.other'] !== false
    const set = new Set<string>()
    // 既知 の type: その type の key が true なら 追加
    for (const [type, key] of Object.entries(builtin)) {
      if (layerVis[key] !== false) set.add(type)
    }
    // 既知 以外 の 全 type (coordinates 内 に 存在 する もの) を 一括 制御
    if (otherVisible) {
      for (const c of coordinates) {
        if (!(c.type in builtin)) set.add(c.type)
      }
    }
    return set
  }, [coordinates, layerVis])

  // 保管ルート 一覧 (export_point_routes)。 タブ 表示 用 に 購読。
  // 無い とき は Map.get が undefined → selector 内 の ?? [] は 毎回 新 配列 を 作って
  // React 無限 ループ に なる の で、 Map そのもの を 購読 して useMemo で 解決 する。
  const routesByFarmId = useExportRouteStore((s) => s.routesByFarmId)
  const savedRoutes = useMemo(
    () => (currentFarm ? routesByFarmId.get(currentFarm.id) ?? [] : []),
    [routesByFarmId, currentFarm],
  )
  const fetchSavedRoutes = useExportRouteStore((s) => s.fetchRoutes)
  const deleteSavedRoute = useExportRouteStore((s) => s.deleteRoute)
  const setStoreRoute = useCoordinateStore.setState

  // 選択モード / 手動保存 ボタン は 廃止 (常時 選択 + 自動保存)
  const [routeName, setRouteName] = useState('既定')
  const [activeRouteId, setActiveRouteId] = useState<string | typeof NEW_ROUTE_KEY>(NEW_ROUTE_KEY)
  // 「保存中…」 「保存済」 の 表示
  const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  // ルート 変更 の 追跡 (coordinateStore 側)
  const routeHasChanges = useCoordinateStore((s) => s.routeHasChanges)

  // 工区 変更 時: 座標 / 現在 の 編集中 ルート / 暗渠 / 線形 を 取得
  useEffect(() => {
    if (!currentFarm) return
    const project = projects.find((p) => p.id === currentFarm.project_id)
    if (project) {
      const { setZone } = useCoordinateStore.getState()
      setZone(project.coordinate_zone)
    }
    void fetchCoordinates(currentFarm.id)
    void fetchRoute(currentFarm.id)
    void fetchPipes(currentFarm.id)
    void fetchOpenChannels(currentFarm.id)
    void fetchSavedRoutes(currentFarm.id)
  }, [
    currentFarm?.id,
    projects,
    fetchCoordinates,
    fetchRoute,
    fetchPipes,
    fetchOpenChannels,
    fetchSavedRoutes,
    currentFarm,
  ])

  /**
   * 保管 ルート の タブ を 選ぶ: その ルート の 点列 を 編集中 ルート (coordinateStore.route)
   * に 反映。 保存済み は RoutePoint[] (coordinateId を 持たない 変換後 の 形) なので、
   * p.id (coordinate id) を 使って 復元 する。 方向 は 失われて いる の で 'down' 既定。
   */
  const handleSelectRouteTab = useCallback(
    (routeId: string | typeof NEW_ROUTE_KEY) => {
      if (routeId === NEW_ROUTE_KEY) {
        setActiveRouteId(NEW_ROUTE_KEY)
        setRouteName('既定')
        setStoreRoute({ route: [], routeHasChanges: false })
        return
      }
      const saved = savedRoutes.find((r) => r.id === routeId)
      if (!saved) return
      setActiveRouteId(routeId)
      setRouteName(saved.name)
      setStoreRoute({
        route: saved.points.map((p) => ({
          coordinateId: p.id,
          direction: 'down' as const,
        })),
        routeHasChanges: false,
      })
    },
    [savedRoutes, setStoreRoute],
  )

  // 削除 (タブ の X ボタン)
  const handleDeleteRoute = useCallback(
    async (routeId: string, name: string) => {
      if (!currentFarm) return
      if (!confirm(`ルート 「${name}」 を 削除 しますか？ (元 に 戻せません)`)) return
      const ok = await deleteSavedRoute(currentFarm.id, routeId)
      if (ok && activeRouteId === routeId) {
        handleSelectRouteTab(NEW_ROUTE_KEY)
      }
    },
    [currentFarm, deleteSavedRoute, activeRouteId, handleSelectRouteTab],
  )

  // 暗渠配線 を 線 + 頂点 ラベル に 展開 (全体図 と 同一 ロジック)
  const pipeOverlay = useMemo(() => {
    const empty = {
      lines: [] as Array<{ id: string; positions: [number, number][] }>,
      vertices: [] as Array<{ key: string; lat: number; lng: number; label: string }>,
    }
    if (zone == null) return empty
    const conv = new CoordinateConverter(zone)
    const lines: typeof empty.lines = []
    const vertices: typeof empty.vertices = []
    for (const pipe of pipes as PipeRow[]) {
      if (pipe.vertices.length === 0) continue
      const positions: [number, number][] = []
      const total = pipe.vertices.length
      for (let i = 0; i < total; i += 1) {
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
          /* skip 無効 座標 */
        }
      }
      if (positions.length >= 2) lines.push({ id: pipe.id, positions })
    }
    return { lines, vertices }
  }, [pipes, zone])

  // 線形物 (中心線 + 幅杭 等)。 subOn は 「全部 ON」 で 全体図 と 揃える
  const channelOverlay = useMemo(
    () =>
      buildChannelOverlay(
        openChannels,
        coordinates,
        zone == null ? null : new CoordinateConverter(zone),
      ),
    [openChannels, coordinates, zone],
  )

  const handlePointSelect = useCallback(
    (id: string) => {
      // すでに ルート 末尾 と 同じ 点 な ら 無視 (連続 クリック の 誤 追加 を 防ぐ)
      if (route.length > 0 && route[route.length - 1]?.coordinateId === id) return
      void appendRoutePoint(id, 'down')
    },
    [route, appendRoutePoint],
  )

  // 自動保存: route / routeName が 変わって routeHasChanges=true の 間、 800ms
  // 無編集 で 保存。 タブ 切替 / 初回 ロード 直後 は routeHasChanges=false なので
  // 走らない。 「保存中…」「保存済」 を 表示 して ユーザー に 進捗 を 伝える。
  useEffect(() => {
    if (!currentFarm) return
    if (!routeHasChanges) return
    setAutoSaveStatus('saving')
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const name = routeName.trim() || '既定'
          await saveRoute(name)
          const updated = await fetchSavedRoutes(currentFarm.id)
          const match = updated.find((r) => r.name === name)
          if (match) setActiveRouteId(match.id)
          setAutoSaveStatus('saved')
          window.setTimeout(() => setAutoSaveStatus('idle'), 1500)
        } catch (err) {
          console.error('[stakeout] auto save failed', err)
          setAutoSaveStatus('idle')
        }
      })()
    }, 800)
    return () => window.clearTimeout(timer)
  }, [route, routeName, routeHasChanges, currentFarm, saveRoute, fetchSavedRoutes])

  // 座標ID → 点 の 索引。 ルート 行 の 表示 で 点名 / 種別 を 引く ため
  const coordById = useMemo(() => {
    const map = new Map<string, (typeof coordinates)[number]>()
    for (const c of coordinates) map.set(c.id, c)
    return map
  }, [coordinates])

  // ルート に 含まれる 点 を 地図 上 で オレンジ 強調 する (経路モード の 視認性)
  const orangeCoordIds = useMemo(
    () => new Set(route.map((p) => p.coordinateId)),
    [route],
  )

  if (!currentFarm) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-slate-500">
        工区を選択してください
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* タイトル ヘッダ は パンくず と 重複 するので 省略 (縦 領域 を 広く 使う) */}
      <ResizableSplit
        storageKey="stakeout-route"
        defaultLeft={420}
        minLeft={320}
        maxLeft={900}
        className="flex-1"
        left={
          <div className="flex-1 flex flex-col overflow-hidden border-r">
            {/* 保管ルート タブ。 クリック で ルート を 切替、× で 削除、「+ 新規」 で
                空 ルート を 開く。 隣 と の 区切り を 分かり やすく する ため 非選択 タブ も
                薄い 枠 (border + 間隔) を 入れる。 選択中 は 白背景 + 青下線 で 浮き 上がる。 */}
            <div className="px-3 pt-1.5 border-b bg-slate-100 flex items-end gap-1 overflow-x-auto">
              {savedRoutes.map((r) => {
                const on = activeRouteId === r.id
                return (
                  <div
                    key={r.id}
                    className={`inline-flex items-center -mb-px rounded-t border border-b-0 whitespace-nowrap ${
                      on
                        ? 'bg-white border-slate-300 border-b-2 border-b-blue-600'
                        : 'bg-slate-50 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleSelectRouteTab(r.id)}
                      className={`px-3 py-1.5 text-xs whitespace-nowrap ${
                        on ? 'text-blue-700 font-medium' : 'text-slate-600 hover:text-slate-800'
                      }`}
                    >
                      {r.name}
                      <span className="ml-1 text-slate-400">{r.points.length}</span>
                    </button>
                    {on && (
                      <button
                        type="button"
                        onClick={() => void handleDeleteRoute(r.id, r.name)}
                        title="このルートを削除"
                        className="mr-1 p-1 rounded text-slate-400 hover:text-red-600 hover:bg-red-50"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                )
              })}
              <div
                className={`inline-flex items-center -mb-px rounded-t border border-b-0 whitespace-nowrap ${
                  activeRouteId === NEW_ROUTE_KEY
                    ? 'bg-white border-slate-300 border-b-2 border-b-blue-600'
                    : 'bg-slate-50 border-slate-200 hover:bg-slate-100'
                }`}
              >
                <button
                  type="button"
                  onClick={() => handleSelectRouteTab(NEW_ROUTE_KEY)}
                  className={`px-3 py-1.5 text-xs whitespace-nowrap ${
                    activeRouteId === NEW_ROUTE_KEY
                      ? 'text-blue-700 font-medium'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  + 新規
                </button>
              </div>
            </div>

            {/* ツールバー (ルート名 + 自動保存 ステータス のみ) */}
            <div className="p-3 bg-slate-50 border-b space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 shrink-0">ルート名</span>
                <input
                  type="text"
                  value={routeName}
                  onChange={(e) => setRouteName(e.target.value)}
                  placeholder="既定"
                  className="flex-1 min-w-0 px-2 py-1 text-sm border rounded"
                />
                <span className="text-[11px] text-slate-500 w-16 text-right">
                  {autoSaveStatus === 'saving'
                    ? '保存中…'
                    : autoSaveStatus === 'saved'
                      ? '保存済'
                      : ''}
                </span>
              </div>
              <div className="text-[11px] text-emerald-700">
                地図上の点をクリックして順番に追加（自動保存されます）
              </div>
            </div>

            {/* 選択済みルート 一覧 */}
            <div className="flex-1 overflow-auto">
              {route.length === 0 ? (
                <div className="p-6 text-center text-sm text-slate-500">
                  <Route className="h-10 w-10 mx-auto mb-2 text-slate-300" />
                  地図から点を選んで順路を作ります
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-slate-100 sticky top-0 text-xs">
                    <tr>
                      <th className="px-2 py-1.5 text-right w-10">#</th>
                      <th className="px-2 py-1.5 text-left">点名</th>
                      <th className="px-2 py-1.5 text-left w-20">向き</th>
                      <th className="px-2 py-1.5 w-24"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {route.map((p, idx) => {
                      const coord = coordById.get(p.coordinateId)
                      return (
                        <tr key={`${p.coordinateId}-${idx}`} className="hover:bg-slate-50">
                          <td className="px-2 py-1 text-right text-slate-500">{idx + 1}</td>
                          <td className="px-2 py-1 font-mono">
                            {coord?.pointNumber ?? '(不明)'}
                          </td>
                          <td className="px-2 py-1">
                            <button
                              onClick={() =>
                                setRouteDirection(idx, p.direction === 'down' ? 'up' : 'down')
                              }
                              className={`px-1.5 py-0.5 text-[10px] rounded border ${
                                p.direction === 'down'
                                  ? 'bg-blue-100 border-blue-300 text-blue-800'
                                  : 'bg-slate-100 border-slate-300 text-slate-500'
                              }`}
                              title="向き (ダウン/アップ) 切替"
                            >
                              {p.direction === 'down' ? '↓ 落' : '↑ 戻'}
                            </button>
                          </td>
                          <td className="px-2 py-1">
                            <div className="flex items-center gap-0.5">
                              <button
                                onClick={() => moveRoutePoint(idx, -1)}
                                disabled={idx === 0}
                                className="p-0.5 hover:bg-slate-200 rounded disabled:opacity-30"
                                title="上へ"
                              >
                                <ArrowUp className="h-3 w-3" />
                              </button>
                              <button
                                onClick={() => moveRoutePoint(idx, 1)}
                                disabled={idx === route.length - 1}
                                className="p-0.5 hover:bg-slate-200 rounded disabled:opacity-30"
                                title="下へ"
                              >
                                <ArrowDown className="h-3 w-3" />
                              </button>
                              <button
                                onClick={() => removeRoutePoint(idx)}
                                className="p-0.5 hover:bg-red-100 rounded text-red-500"
                                title="削除"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        }
        right={
          <div className="flex-1 flex flex-col bg-slate-100 relative">
            {/* 地図 左下 の レイヤ 切替 ボタン (全ページ 共通)。 法務省地図 ボタン (bottom-6)
                の 上 に 置く ため bottom-16 相当。 CoordinateMap の 外 に 配置 する の は、
                MapContainer 内 の 子 に React 要素 を 置くと Leaflet 側 の 座標 制御 に
                干渉 する ため */}
            <MapLayerControl
              sections={[
                {
                  title: '測点',
                  layers: [
                    { key: 'points.control', label: '基準点', indent: 1 },
                    { key: 'points.boundary', label: '境界点', indent: 1 },
                    { key: 'points.current', label: '現況', indent: 1 },
                    { key: 'points.measured', label: '実測点', indent: 1 },
                    { key: 'points.underdrain', label: '暗渠', indent: 1 },
                    { key: 'points.other', label: 'その他', indent: 1 },
                  ],
                },
                {
                  title: 'オーバーレイ',
                  layers: [
                    { key: 'pipes', label: '暗渠配線' },
                    { key: 'channels', label: '線形物' },
                  ],
                },
              ]}
            />
            <CoordinateMap
              key={currentFarm.id}
              farmId={currentFarm.id}
              showOrtho
              showRoute
              route={route}
              orangeCoordIds={orangeCoordIds}
              onPointSelect={handlePointSelect}
              coordinatesInteractive
              visibleTypes={visibleTypes}
            >
              {/* 暗渠 配線 (読取 専用)。 全体図 と 同じ 配色 (シアン 系) で 統一 */}
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
              {/* 線形物 (中心線 / 幅杭 / IP / 中間点) */}
              {showChannels && (
                <OpenChannelOverlay
                  overlay={channelOverlay}
                  subOn={() => true}
                  disableClicks
                />
              )}
            </CoordinateMap>
          </div>
        }
      />
    </div>
  )
}
