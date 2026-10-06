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
import {
  ArrowDown,
  ArrowUp,
  Route,
  Save,
  Trash2,
  X,
} from 'lucide-react'
import { Polyline as LeafletPolyline, CircleMarker, Tooltip } from 'react-leaflet'
import { CoordinateMap } from '@/components/map/CoordinateMap'
import { OpenChannelOverlay } from '@/components/map/OpenChannelOverlay'
import { ResizableSplit } from '@/components/layout/ResizableSplit'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useFarmStore } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useUnderdrainStore, type PipeRow } from '@/stores/underdrainStore'
import { useOpenChannelStore } from '@/stores/openChannelStore'
import { CoordinateConverter } from '@/lib/coordinates'
import { buildChannelOverlay } from '@/lib/openChannel/overlayRender'

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
  const clearRoute = useCoordinateStore((s) => s.clearRoute)
  const saveRoute = useCoordinateStore((s) => s.saveRoute)

  // 暗渠 配線 + 線形物 の 読取 (全体図 と 同じ 見た目 に 揃える)
  const fetchPipes = useUnderdrainStore((s) => s.fetchPipes)
  const pipes = useUnderdrainStore((s) => s.pipes)
  const fetchOpenChannels = useOpenChannelStore((s) => s.fetchChannels)
  const openChannels = useOpenChannelStore((s) => s.channels)

  const [selectMode, setSelectMode] = useState(true)
  const [routeName, setRouteName] = useState('既定')
  const [saving, setSaving] = useState(false)

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
  }, [
    currentFarm?.id,
    projects,
    fetchCoordinates,
    fetchRoute,
    fetchPipes,
    fetchOpenChannels,
    currentFarm,
  ])

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
      if (!selectMode) return
      // すでに ルート 末尾 と 同じ 点 な ら 無視 (連続 クリック の 誤 追加 を 防ぐ)
      if (route.length > 0 && route[route.length - 1]?.coordinateId === id) return
      void appendRoutePoint(id, 'down')
    },
    [selectMode, route, appendRoutePoint],
  )

  const handleSave = async () => {
    if (!currentFarm) return
    const name = routeName.trim() || '既定'
    setSaving(true)
    try {
      await saveRoute(name)
      alert(
        `ルート「${name}」を保存しました。\nスマホ 杭打ち で この 名前 を 選べます。`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      alert(`保存に失敗しました: ${msg}`)
    } finally {
      setSaving(false)
    }
  }

  const handleClear = () => {
    if (route.length === 0) return
    if (!confirm('編集中 の ルート を すべて クリア しますか？')) return
    void clearRoute()
  }

  // 座標ID → 点 の 索引。 ルート 行 の 表示 で 点名 / 種別 を 引く ため
  const coordById = useMemo(() => {
    const map = new Map<string, (typeof coordinates)[number]>()
    for (const c of coordinates) map.set(c.id, c)
    return map
  }, [coordinates])

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
            {/* ツールバー */}
            <div className="p-3 bg-slate-50 border-b space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => setSelectMode((v) => !v)}
                  className={`px-3 py-1.5 text-sm rounded border ${
                    selectMode
                      ? 'bg-emerald-600 text-white border-emerald-700'
                      : 'bg-white border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  {selectMode ? '選択モード ON' : '選択モード OFF'}
                </button>
                <button
                  onClick={handleClear}
                  disabled={route.length === 0}
                  className="px-3 py-1.5 text-sm rounded border border-slate-300 hover:bg-slate-50 disabled:opacity-40"
                >
                  <Trash2 className="h-3.5 w-3.5 inline mr-1" />
                  クリア
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 shrink-0">ルート名</span>
                <input
                  type="text"
                  value={routeName}
                  onChange={(e) => setRouteName(e.target.value)}
                  placeholder="既定"
                  className="flex-1 min-w-0 px-2 py-1 text-sm border rounded"
                />
                <button
                  onClick={handleSave}
                  disabled={saving || route.length === 0}
                  className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                  title="このルートをスマホ杭打ち用に保存"
                >
                  <Save className="h-3.5 w-3.5" />
                  {saving ? '保存中…' : 'サーバ保存'}
                </button>
              </div>
              {selectMode && (
                <div className="text-[11px] text-emerald-700">
                  地図上の点をクリックして順番に追加してください
                </div>
              )}
            </div>

            {/* 選択済みルート 一覧 */}
            <div className="flex-1 overflow-auto">
              {route.length === 0 ? (
                <div className="p-6 text-center text-sm text-slate-500">
                  <Route className="h-10 w-10 mx-auto mb-2 text-slate-300" />
                  {selectMode
                    ? '地図から点を選んで順路を作ります'
                    : '選択モードを ON にして地図から点を選びます'}
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
          <div className="flex-1 flex flex-col bg-slate-100">
            <CoordinateMap
              key={currentFarm.id}
              farmId={currentFarm.id}
              showOrtho
              showRoute
              onPointSelect={handlePointSelect}
              coordinatesInteractive
            >
              {/* 暗渠 配線 (読取 専用)。 全体図 と 同じ 配色 (シアン 系) で 統一 */}
              {pipeOverlay.lines.map((line) => (
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
              {pipeOverlay.vertices.map((v) => (
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
              {/* 線形物 (中心線 / 幅杭 / IP / 中間点)。 subOn は 全部 ON (全体図 と 同一) */}
              <OpenChannelOverlay
                overlay={channelOverlay}
                subOn={() => true}
                disableClicks
              />
            </CoordinateMap>
          </div>
        }
      />
    </div>
  )
}
