// GPS 設定モーダル。バッジ (GPS設定ボタン) から開かれる 3 タブの統合 UI:
//   1. GPS接続  — Drogger BT 接続状態 / Fix品質 / 再接続
//   2. NTRIP接続 — NTRIP キャスター プロファイル管理 + 接続
//   3. 衛星状況 — スカイマップ + SNR バー
//
// これまで DroggerStatusBadge の 隣にあった NTRIP 歯車ボタンを 廃止し、
// 全ての GNSS 関連設定を ここに集約する。

import { useEffect, useState } from 'react'
import {
  X,
  Radio,
  Loader2,
  Satellite,
  Trash2,
  Plus,
  Pencil,
  Wifi,
  RefreshCw,
  RadioTower,
  WifiOff,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { useGnssSettingsStore } from '@/stores/gnssSettingsStore'
import { useDroggerConnection } from '@/stores/droggerConnectionStore'
import {
  DroggerLocation,
  accuracyNote,
  correctionSource,
  CORRECTION_SOURCE_LABEL,
  fetchNtripSourceTable,
  getNtripStatus,
  startNtrip,
  stopNtrip,
  type DroggerFixQuality,
  type DroggerLocationEvent,
  type NtripConfig,
  type NtripMountpoint,
  type NtripStatus,
} from '@/lib/drogger'
import {
  DEFAULT_NTRIP_CONFIG,
  addNtripProfile,
  deleteNtripProfile,
  loadNtripStore,
  renameNtripProfile,
  saveNtripStore,
  setActiveNtripProfile,
  type NtripProfile,
} from '@/lib/ntripPrefs'
import { SkyMap } from '@/features/ntrip/SkyMap'

type Tab = 'gps' | 'ntrip' | 'sky'

interface Props {
  open: boolean
  onClose: () => void
}

/** GPS接続タブ内 の 位置情報 (lat/lon/alt/精度) は 詳細情報 用の 追加取得。
 *  接続状態 (connected/fixQuality/hdop/satellites) は 全体共有 store から。 */
interface PositionSnapshot {
  lat: number | null
  lon: number | null
  altitude: number | null
  accuracy: number | null
  /** accuracy が 実測 (GST) か 典型値かの 出どころ */
  accuracySource: string | null
  altitudeAccuracy: number | null
  /** GGA field 11: 受信機内蔵ジオイド と 楕円体 の差 [m] (Drogger のみ) */
  geoidalSep: number | null
  /** RMC の 進行方向 (COG) [deg]。真北から 時計回り */
  heading: number | null
  /** RMC の 対地速度 [km/h]。COG が 当てに なるかの 判断に 使う */
  speedKmh: number | null
}

const FIX_LABEL: Record<DroggerFixQuality, string> = {
  0: '受信中',
  1: 'GPS',
  2: 'DGPS',
  4: 'RTK-FIX',
  5: 'RFLOAT',
}

const FIX_CLASS: Record<DroggerFixQuality, string> = {
  0: 'bg-red-100 border-red-400 text-red-800',
  1: 'bg-slate-100 border-slate-400 text-slate-700',
  2: 'bg-blue-100 border-blue-400 text-blue-800',
  4: 'bg-emerald-100 border-emerald-500 text-emerald-800',
  5: 'bg-amber-100 border-amber-500 text-amber-800',
}

export function GpsSettingsModal({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('gps')

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[10000] bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white text-slate-800 rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="flex items-center gap-2">
            <Wifi className="h-4 w-4 text-emerald-600" />
            <h2 className="text-sm font-bold">GPS 設定</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 hover:bg-slate-100 rounded"
            aria-label="閉じる"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* タブバー */}
        <div className="flex border-b bg-slate-50 text-[11px]">
          <TabButton active={tab === 'gps'} onClick={() => setTab('gps')} icon={<Wifi className="h-3 w-3" />} label="GPS接続" />
          <TabButton active={tab === 'ntrip'} onClick={() => setTab('ntrip')} icon={<Radio className="h-3 w-3" />} label="NTRIP接続" />
          <TabButton active={tab === 'sky'} onClick={() => setTab('sky')} icon={<Satellite className="h-3 w-3" />} label="衛星状況" />
        </div>

        <div className="p-4">
          {tab === 'gps' && <GpsConnectionTab />}
          {tab === 'ntrip' && <NtripTab />}
          {tab === 'sky' && <SkyMap />}
        </div>
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 py-2 font-semibold flex items-center justify-center gap-1 ${
        active
          ? 'bg-white border-b-2 border-emerald-600 text-emerald-800'
          : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

// ============================================================================
// タブ 1: GPS接続 — Drogger BT 状態 + 再接続 + 現在位置
// ============================================================================

function GpsConnectionTab() {
  // 接続状態は 全アプリ横断 store から取得 (工区遷移で 切れないため)
  const {
    connected,
    deviceName,
    fixQuality,
    hdop,
    satellites,
    diffAge,
    stationId,
    lastUpdateAt,
    ntrip,
    ensureStarted,
    reconnect,
    disconnect,
  } = useDroggerConnection()
  // モーダルを開いている 間だけ 位置情報も 詳細取得 (lat/lon/alt/精度)
  const [pos, setPos] = useState<PositionSnapshot>({
    lat: null,
    lon: null,
    altitude: null,
    accuracy: null,
    accuracySource: null,
    altitudeAccuracy: null,
    geoidalSep: null,
    heading: null,
    speedKmh: null,
  })
  const [reconnecting, setReconnecting] = useState(false)
  const [reconnectError, setReconnectError] = useState<string | null>(null)
  // MobileStakingPage と 同じ 標高補正を 適用するため 設定と geoid grid を読む
  const antennaHeight = useGnssSettingsStore((s) => s.antennaHeight)
  const useGeoidCorrection = useGnssSettingsStore((s) => s.useGeoidCorrection)
  const [geoidGrid, setGeoidGrid] = useState<import('@/lib/geoid').GeoidGrid | null>(null)
  useEffect(() => {
    if (!useGeoidCorrection || geoidGrid) return
    void import('@/lib/geoid').then(({ loadGeoid }) => loadGeoid())
      .then((g) => setGeoidGrid(g))
      .catch(() => { /* ignore */ })
  }, [useGeoidCorrection, geoidGrid])

  // ensureStarted は 初回のみ発火 (idempotent)。既に 起動済みなら 何もしない
  useEffect(() => {
    void ensureStarted()
  }, [ensureStarted])

  // 位置情報 (lat/lon/alt 等) は モーダル open 中だけ 直接 listen
  useEffect(() => {
    let cancelled = false
    let handle: { remove: () => Promise<void> } | null = null
    void DroggerLocation.addListener('location', (ev: DroggerLocationEvent) => {
      setPos({
        lat: ev.lat,
        lon: ev.lon,
        altitude: ev.altitude_m,
        accuracy: ev.accuracy_m,
        accuracySource: ev.accuracySource ?? null,
        altitudeAccuracy: ev.altitude_accuracy_m,
        geoidalSep: ev.geoidal_separation_m ?? null,
        heading: ev.heading_deg,
        speedKmh: ev.speed_kmh,
      })
    }).then((h) => {
      if (cancelled) void h.remove()
      else handle = h
    })
    return () => {
      cancelled = true
      if (handle) void handle.remove()
    }
  }, [])

  const handleReconnect = async () => {
    setReconnecting(true)
    setReconnectError(null)
    try {
      await reconnect()
    } catch (e) {
      setReconnectError((e as Error)?.message ?? String(e))
    } finally {
      setReconnecting(false)
    }
  }

  const handleDisconnect = async () => {
    setReconnectError(null)
    try {
      await disconnect()
    } catch (e) {
      setReconnectError((e as Error)?.message ?? String(e))
    }
  }

  // ダミー status オブジェクト (下記 render は 元コードのまま 動作)
  const status = {
    connected,
    deviceName,
    fixQuality,
    hdop,
    satellites,
    diffAge,
    stationId,
    lat: pos.lat,
    lon: pos.lon,
    altitude: pos.altitude,
    accuracy: pos.accuracy,
    accuracySource: pos.accuracySource,
    altitudeAccuracy: pos.altitudeAccuracy,
    geoidalSep: pos.geoidalSep,
    heading: pos.heading,
    speedKmh: pos.speedKmh,
    lastUpdateAt,
  }
  const fq = status.fixQuality
  const fixClass =
    fq != null
      ? FIX_CLASS[fq]
      : status.connected
        ? 'bg-slate-100 border-slate-400 text-slate-700'
        : 'bg-red-100 border-red-400 text-red-800'
  // COG (進行方向) は 静止中 まったく 当てに ならない。歩行速度を 目安に
  // 「動いている」ことを 判定して、止まっている 間は 薄字に 落とす
  const movingForCog = status.speedKmh != null && status.speedKmh >= 2.0
  const staleMs = status.lastUpdateAt ? Date.now() - status.lastUpdateAt : null
  const isStale = staleMs != null && staleMs > 5000
  // 補正の 出どころ。CLAS と NTRIP は どちらも 品質 4/5 になるので、
  // NTRIP を 繋いでいないのに 補正が 効いている = CLAS と 見なす
  const corrSrc = status.connected
    ? correctionSource({ fixQuality: fq, diffAge: status.diffAge }, ntrip.connected)
    : 'none'
  // バッジと 同じ 呼び方に 揃える (CLAS で 解けていれば RTK-FIX ではなく CLAS)
  const fixLabel = !status.connected
    ? '切断'
    : fq == null
      ? '受信中'
      : corrSrc === 'clas' && fq === 4
        ? 'CLAS'
        : corrSrc === 'clas' && fq === 5
          ? 'CLAS-F'
          : FIX_LABEL[fq]

  return (
    <div className="space-y-3 text-xs">
      {/* 接続状態 */}
      <div className="border rounded p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-slate-600">接続状態</span>
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-semibold ${fixClass}`}
          >
            {!status.connected ? (
              <WifiOff className="h-3 w-3" />
            ) : fq === 4 ? (
              <RadioTower className="h-3 w-3" />
            ) : (
              <Radio className="h-3 w-3" />
            )}
            {fixLabel}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-y-1 gap-x-3 text-slate-700">
          <div>
            <div className="text-[10px] text-slate-500">デバイス</div>
            <div className="font-mono">{status.deviceName ?? '(未接続)'}</div>
          </div>
          <div>
            <div className="text-[10px] text-slate-500">HDOP / 衛星</div>
            <div className="font-mono">
              {status.hdop != null ? status.hdop.toFixed(2) : '-'} /{' '}
              {status.satellites ?? '-'}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-slate-500">補正源</div>
            <div className="flex items-center gap-1">
              <span
                className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${
                  corrSrc === 'clas'
                    ? 'bg-violet-100 border-violet-400 text-violet-800'
                    : corrSrc === 'ntrip'
                      ? 'bg-blue-100 border-blue-400 text-blue-800'
                      : 'bg-slate-100 border-slate-300 text-slate-600'
                }`}
              >
                {CORRECTION_SOURCE_LABEL[corrSrc]}
              </span>
              <span className="font-mono text-[10px] text-slate-500">
                {status.diffAge != null ? `${status.diffAge.toFixed(1)}s` : '-'}
              </span>
            </div>
          </div>
          <div>
            <div className="text-[10px] text-slate-500">基準局 ID</div>
            <div className="font-mono">{status.stationId ?? '-'}</div>
          </div>
        </div>
      </div>

      {/* 現在位置 */}
      <div className="border rounded p-3 space-y-1 text-slate-700">
        <div className="text-slate-600">現在位置</div>
        <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
          <div>
            <div className="text-[10px] text-slate-500">緯度</div>
            <div>{status.lat != null ? status.lat.toFixed(7) : '-'}</div>
          </div>
          <div>
            <div className="text-[10px] text-slate-500">経度</div>
            <div>{status.lon != null ? status.lon.toFixed(7) : '-'}</div>
          </div>
          <div>
            <div className="text-[10px] text-slate-500">標高 (地表)</div>
            <div>{(() => {
              if (status.altitude == null || status.lat == null || status.lon == null) return '-'
              // MobileStakingPage と同じ式:
              //   楕円体高 h = altitude + geoidalSep
              //   正 MSL H = h − N_JPGEO2024
              //   地表 = H − アンテナ高
              let H: number | null = null
              if (useGeoidCorrection && geoidGrid) {
                const hEllip = status.altitude + (status.geoidalSep ?? 0)
                const rRow = (geoidGrid.latMax - status.lat) / geoidGrid.dLat
                const rCol = (status.lon - geoidGrid.lonMin) / geoidGrid.dLon
                if (rRow >= 0 && rCol >= 0 && rRow < geoidGrid.nrows && rCol < geoidGrid.ncols) {
                  const r0 = Math.floor(rRow), c0 = Math.floor(rCol)
                  const r1 = Math.min(r0 + 1, geoidGrid.nrows - 1)
                  const c1 = Math.min(c0 + 1, geoidGrid.ncols - 1)
                  const tr = rRow - r0, tc = rCol - c0
                  const v00 = geoidGrid.values[r0 * geoidGrid.ncols + c0]
                  const v01 = geoidGrid.values[r0 * geoidGrid.ncols + c1]
                  const v10 = geoidGrid.values[r1 * geoidGrid.ncols + c0]
                  const v11 = geoidGrid.values[r1 * geoidGrid.ncols + c1]
                  const N = (v00 * (1 - tc) + v01 * tc) * (1 - tr) + (v10 * (1 - tc) + v11 * tc) * tr
                  if (Number.isFinite(N)) H = hEllip - N - antennaHeight
                }
              } else {
                H = status.altitude - antennaHeight
              }
              return `${(H ?? status.altitude).toFixed(3)}m`
            })()}</div>
          </div>
          {/* 方位 (RMC の COG)。静止中は 値が 定まらないので 薄く 出す */}
          <div>
            <div className="text-[10px] text-slate-500">方位 (進行方向)</div>
            <div className={movingForCog ? '' : 'text-slate-400'}>
              {status.heading != null ? `${status.heading.toFixed(1)}°` : '-'}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-slate-500">速度</div>
            <div>
              {status.speedKmh != null ? `${status.speedKmh.toFixed(1)} km/h` : '-'}
            </div>
          </div>
        </div>
        {!movingForCog && status.heading != null && (
          <div className="text-[10px] text-slate-500">
            方位は NMEA $--RMC の 進行方向 (COG)。静止中は 定まらないので
            薄字に しています
          </div>
        )}
        <div className="text-[10px] text-slate-500">
          {/* 受信機が GST を 出していないと 品質ごとの 固定値になるので、
              実測かどうかが 分かるように 注記を 添える */}
          精度 H: {status.accuracy != null ? `${status.accuracy.toFixed(3)}m` : '-'}
          {accuracyNote(status.accuracySource) ? ` (${accuracyNote(status.accuracySource)})` : ''} /
          V: {status.altitudeAccuracy != null ? `${status.altitudeAccuracy.toFixed(3)}m` : '-'} /
          最終更新:{' '}
          {status.lastUpdateAt
            ? `${Math.round(((staleMs ?? 0) / 1000))} 秒前`
            : '-'}
          {isStale && <span className="text-red-600 ml-1">(stale)</span>}
        </div>
      </div>

      {/* 再接続 / 切断 */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={handleReconnect}
          disabled={reconnecting}
          className="flex items-center justify-center gap-2 px-3 py-2 rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-50"
        >
          {reconnecting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {status.connected ? '再接続' : '接続'}
        </button>
        <button
          type="button"
          onClick={handleDisconnect}
          disabled={!status.connected}
          className="flex items-center justify-center gap-2 px-3 py-2 rounded bg-red-600 text-white font-semibold hover:bg-red-700 disabled:opacity-50"
        >
          <WifiOff className="h-4 w-4" />
          切断
        </button>
      </div>
      {reconnectError && (
        <div className="bg-red-50 border border-red-300 rounded p-2 text-red-800">
          {reconnectError}
        </div>
      )}

      {/* ---- 端末側 GNSS 設定 (音声 / 平均秒数 / アンテナ高 / ジオイド) ---- */}
      <GnssSettingsSection />
    </div>
  )
}

/**
 * アンテナ高 入力コンポーネント。
 * 内部で string state を 持ち、途中の 「.」や 空文字も 受け付ける。
 * 有効な数値に なった時のみ 親の onChange を呼び、store に 反映。
 * (以前は value に number を 直接バインドしていたため、backspace で 空にすると
 *  state が 更新されず 表示が 元に戻り、数字が はじかれる ように 見えていた)
 */
function AntennaHeightInput({
  value,
  onChange,
}: {
  value: number
  onChange: (n: number) => void
}) {
  const [str, setStr] = useState(String(value))
  // 外部 (store) が 変わった時は 反映 (ただし ユーザー編集中は 上書きしない)
  useEffect(() => {
    setStr((prev) => {
      const prevNum = parseFloat(prev)
      // 現在の文字列が 有効数値で 親と一致するなら 触らない
      if (Number.isFinite(prevNum) && prevNum === value) return prev
      return String(value)
    })
  }, [value])
  return (
    <label className="block">
      <span className="text-slate-700">アンテナ高 (m)</span>
      <input
        type="text"
        inputMode="decimal"
        value={str}
        onChange={(e) => {
          const v = e.target.value
          setStr(v)
          // 空文字 or 「.」等の途中入力は 親に流さない (フォーカス外れる時 or 有効時のみ)
          const n = parseFloat(v)
          if (Number.isFinite(n)) onChange(n)
        }}
        onBlur={() => {
          // フォーカス外れる時に 現在値で 表示を正規化
          const n = parseFloat(str)
          setStr(Number.isFinite(n) ? String(n) : String(value))
        }}
        className="mt-1 w-full px-2 py-1 border border-slate-300 rounded text-right font-mono"
      />
      <span className="text-[10px] text-slate-500">
        ロッド/ポール先端 〜 アンテナ位相中心 までの 高さ。標高 = 楕円体高 − ジオイド高 − アンテナ高
      </span>
    </label>
  )
}

function GnssSettingsSection() {
  const {
    avgSeconds,
    setAvgSeconds,
    soundEnabled,
    setSoundEnabled,
    antennaHeight,
    setAntennaHeight,
    useGeoidCorrection,
    setUseGeoidCorrection,
    headingUp,
    setHeadingUp,
  } = useGnssSettingsStore()

  return (
    <div className="border-t pt-3 space-y-3">
      <div className="text-slate-700 font-semibold">計測設定</div>

      {/* 音声ガイダンス */}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={soundEnabled}
          onChange={(e) => setSoundEnabled(e.target.checked)}
        />
        <span>音声ガイダンス</span>
        {soundEnabled ? (
          <Volume2 className="h-3.5 w-3.5 ml-auto text-emerald-600" />
        ) : (
          <VolumeX className="h-3.5 w-3.5 ml-auto text-slate-400" />
        )}
      </label>
      <div className="text-[10px] text-slate-500 -mt-2 pl-6">
        FIX: ピッ / 1m 以内: ピピ / 10cm 以内: ピピピ / FIX 喪失: ブーッ
      </div>

      {/* 平均秒数 */}
      <label className="block">
        <div className="flex items-center justify-between">
          <span className="text-slate-700">計測数 (平均秒数)</span>
          <span className="font-mono">{avgSeconds} 秒</span>
        </div>
        <input
          type="range"
          min={1}
          max={10}
          step={1}
          value={avgSeconds}
          onChange={(e) => setAvgSeconds(parseInt(e.target.value, 10))}
          className="w-full mt-1"
        />
      </label>

      {/* アンテナ高 - string state で編集 (数字が はじかれる問題対策) */}
      <AntennaHeightInput value={antennaHeight} onChange={setAntennaHeight} />

      {/* ジオイド補正 */}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={useGeoidCorrection}
          onChange={(e) => setUseGeoidCorrection(e.target.checked)}
        />
        <span>ジオイド補正 (JPGEO2024)</span>
      </label>

      {/* 方位表示の 基準 (測設画面の 矢印 / 近接モードの レーダー) */}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={headingUp}
          onChange={(e) => setHeadingUp(e.target.checked)}
        />
        <span>方位を 進行方向基準で 表示</span>
      </label>
      <div className="text-[10px] text-slate-500 -mt-2 pl-6">
        OFF = 北が 上。ON = 自分の 向きが 上 (歩行中は GNSS の 進行方向、静止中は
        端末の コンパス)。静止中の 向きには 方位センサーの 許可が 要るので、
        測設画面の 「進行↑」ボタンから ON に すると 確実です。
      </div>
    </div>
  )
}

// ============================================================================
// タブ 2: NTRIP接続 — プロファイル管理 + キャスター接続
// (旧 NtripConfigModal から 移設)
// ============================================================================

function NtripTab() {
  const [profiles, setProfiles] = useState<NtripProfile[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [cfg, setCfg] = useState<NtripConfig>(DEFAULT_NTRIP_CONFIG)
  const [profileName, setProfileName] = useState<string>('')
  const [mountpoints, setMountpoints] = useState<NtripMountpoint[] | null>(null)
  const [fetching, setFetching] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<NtripStatus | null>(null)

  useEffect(() => {
    const store = loadNtripStore()
    setProfiles(store.profiles)
    setActiveId(store.activeId)
    const active = store.profiles.find((p) => p.id === store.activeId)
    if (active) {
      setCfg(active.config)
      setProfileName(active.name)
    } else {
      setCfg(DEFAULT_NTRIP_CONFIG)
      setProfileName('')
    }
    void getNtripStatus().then(setStatus).catch(() => setStatus(null))
    // NTRIP 状態変化を購読
    let cancelled = false
    let h: { remove: () => Promise<void> } | null = null
    void DroggerLocation.addListener('ntripStatusChange', (ev) => {
      if (!cancelled) setStatus(ev)
    }).then((handle) => {
      if (cancelled) void handle.remove()
      else h = handle
    })
    return () => {
      cancelled = true
      if (h) void h.remove()
    }
  }, [])

  const switchProfile = (id: string) => {
    const p = profiles.find((x) => x.id === id)
    if (!p) return
    setActiveNtripProfile(id)
    setActiveId(id)
    setCfg(p.config)
    setProfileName(p.name)
    setMountpoints(null)
    setError(null)
  }

  const handleAddProfile = () => {
    const name = window.prompt('新しいプロファイル名を入力:', '')
    if (!name || !name.trim()) return
    const p = addNtripProfile(name.trim(), DEFAULT_NTRIP_CONFIG)
    const store = loadNtripStore()
    setProfiles(store.profiles)
    setActiveId(p.id)
    setCfg(p.config)
    setProfileName(p.name)
    setMountpoints(null)
    setError(null)
  }

  const handleRenameProfile = () => {
    if (!activeId) return
    const current = profiles.find((p) => p.id === activeId)
    const name = window.prompt('プロファイル名を変更:', current?.name ?? '')
    if (!name || !name.trim()) return
    renameNtripProfile(activeId, name.trim())
    setProfileName(name.trim())
    setProfiles(loadNtripStore().profiles)
  }

  const handleDeleteProfile = () => {
    if (!activeId) return
    const current = profiles.find((p) => p.id === activeId)
    if (!window.confirm(`プロファイル「${current?.name ?? ''}」を削除しますか？`)) return
    deleteNtripProfile(activeId)
    const store = loadNtripStore()
    setProfiles(store.profiles)
    setActiveId(store.activeId)
    const active = store.profiles.find((p) => p.id === store.activeId)
    if (active) {
      setCfg(active.config)
      setProfileName(active.name)
    } else {
      setCfg(DEFAULT_NTRIP_CONFIG)
      setProfileName('')
    }
  }

  const handleFetchSourceTable = async () => {
    if (!cfg.host || !cfg.port) {
      setError('host / port を入力してください')
      return
    }
    setFetching(true)
    setError(null)
    try {
      const r = await fetchNtripSourceTable({
        host: cfg.host,
        port: cfg.port,
        user: cfg.user || undefined,
        pass: cfg.pass || undefined,
      })
      setMountpoints(r.mountpoints)
      if (r.mountpoints.length === 0) {
        setError('mountpoint が 見つかりません (SourceTable が空)')
      }
    } catch (e) {
      setError(`SourceTable 取得失敗: ${(e as Error)?.message ?? e}`)
      setMountpoints(null)
    } finally {
      setFetching(false)
    }
  }

  const handleConnect = async () => {
    if (!cfg.host || !cfg.port || !cfg.mountpoint) {
      setError('host / port / mountpoint は 必須です')
      return
    }
    setConnecting(true)
    setError(null)
    try {
      const store = loadNtripStore()
      const active = store.profiles.find((p) => p.id === store.activeId)
      if (active) {
        active.config = cfg
        active.name = profileName || active.name
        saveNtripStore(store)
      } else {
        const p = addNtripProfile(profileName || cfg.mountpoint || cfg.host || '(名称未設定)', cfg)
        setActiveId(p.id)
      }
      setProfiles(loadNtripStore().profiles)
      await startNtrip(cfg)
      const s = await getNtripStatus()
      setStatus(s)
    } catch (e) {
      setError(`接続失敗: ${(e as Error)?.message ?? e}`)
    } finally {
      setConnecting(false)
    }
  }

  const handleDisconnect = async () => {
    try {
      await stopNtrip()
      const s = await getNtripStatus()
      setStatus(s)
    } catch (e) {
      setError(`切断失敗: ${(e as Error)?.message ?? e}`)
    }
  }

  return (
    <div className="space-y-3 text-xs">
      {status?.connected && (
        <div className="bg-emerald-50 border border-emerald-300 rounded p-2 flex items-center justify-between">
          <div>
            <div className="font-semibold text-emerald-800">
              接続中: {status.host}/{status.mountpoint}
            </div>
            <div className="text-emerald-700 mt-0.5">
              受信 {(status.bytesReceived / 1024).toFixed(1)} KB
              {status.lastRtcmAt > 0 && (
                <>
                  {' / '}
                  {Math.max(0, Math.round((Date.now() - status.lastRtcmAt) / 1000))} 秒前
                </>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={handleDisconnect}
            className="px-3 py-1 rounded bg-red-600 text-white text-xs font-semibold hover:bg-red-700"
          >
            切断
          </button>
        </div>
      )}

      {/* プロファイル選択 */}
      <div className="border-b pb-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-slate-700 font-semibold">プロファイル</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleAddProfile}
              className="p-1 rounded hover:bg-slate-100 text-slate-600"
              title="新規追加"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={handleRenameProfile}
              disabled={!activeId}
              className="p-1 rounded hover:bg-slate-100 text-slate-600 disabled:opacity-40"
              title="名前変更"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={handleDeleteProfile}
              disabled={!activeId}
              className="p-1 rounded hover:bg-red-50 text-red-600 disabled:opacity-40"
              title="削除"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        {profiles.length === 0 ? (
          <div className="text-slate-500 italic">
            プロファイル未登録。下の 「接続」で 自動作成 or 「＋」で 新規追加
          </div>
        ) : (
          <select
            value={activeId ?? ''}
            onChange={(e) => switchProfile(e.target.value)}
            className="w-full border border-slate-300 rounded px-2 py-1 font-mono"
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.config.host}/{p.config.mountpoint || '(未設定)'})
              </option>
            ))}
          </select>
        )}
      </div>

      <label className="block">
        <span className="text-slate-700 font-semibold">キャスター host</span>
        <input
          type="text"
          value={cfg.host}
          onChange={(e) => setCfg({ ...cfg, host: e.target.value })}
          placeholder="例: rtk2go.com / MADOCA など"
          className="mt-1 w-full border border-slate-300 rounded px-2 py-1 font-mono"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-slate-700 font-semibold">port</span>
          <input
            type="number"
            value={cfg.port}
            onChange={(e) => setCfg({ ...cfg, port: parseInt(e.target.value, 10) || 0 })}
            className="mt-1 w-full border border-slate-300 rounded px-2 py-1 font-mono"
          />
        </label>
        <label className="flex items-center gap-1.5 pt-6">
          <input
            type="checkbox"
            checked={cfg.sendGga}
            onChange={(e) => setCfg({ ...cfg, sendGga: e.target.checked })}
          />
          <span className="text-slate-700">GGA 送信 (VRS)</span>
        </label>
      </div>

      <div className="border-t pt-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-slate-700 font-semibold">mountpoint</span>
          <button
            type="button"
            onClick={handleFetchSourceTable}
            disabled={fetching}
            className="text-emerald-700 hover:text-emerald-900 disabled:opacity-50 flex items-center gap-1"
          >
            {fetching && <Loader2 className="h-3 w-3 animate-spin" />}
            一覧を取得
          </button>
        </div>
        {mountpoints && mountpoints.length > 0 ? (
          <select
            value={cfg.mountpoint}
            onChange={(e) => setCfg({ ...cfg, mountpoint: e.target.value })}
            className="w-full border border-slate-300 rounded px-2 py-1 font-mono"
          >
            <option value="">-- 選択 --</option>
            {mountpoints.map((m) => (
              <option key={m.mountpoint} value={m.mountpoint}>
                {m.mountpoint} ({m.format} / {m.navSystem}
                {m.nmeaRequired ? ' / GGA必須' : ''}
                {m.auth === 'B' ? ' / 認証要' : ''})
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={cfg.mountpoint}
            onChange={(e) => setCfg({ ...cfg, mountpoint: e.target.value })}
            placeholder="mountpoint 名 (例: MADOCA01, 電子基準点コード等)"
            className="w-full border border-slate-300 rounded px-2 py-1 font-mono"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        )}
      </div>

      <label className="block">
        <span className="text-slate-700 font-semibold">user</span>
        <input
          type="text"
          value={cfg.user}
          onChange={(e) => setCfg({ ...cfg, user: e.target.value })}
          className="mt-1 w-full border border-slate-300 rounded px-2 py-1 font-mono"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>

      <label className="block">
        <span className="text-slate-700 font-semibold">pass</span>
        <input
          type="password"
          value={cfg.pass}
          onChange={(e) => setCfg({ ...cfg, pass: e.target.value })}
          className="mt-1 w-full border border-slate-300 rounded px-2 py-1 font-mono"
        />
      </label>

      {error && (
        <div className="bg-red-50 border border-red-300 rounded p-2 text-red-800">{error}</div>
      )}

      <button
        type="button"
        onClick={handleConnect}
        disabled={connecting}
        className="w-full flex items-center justify-center gap-1 px-3 py-2 rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-50"
      >
        {connecting && <Loader2 className="h-3 w-3 animate-spin" />}
        {status?.connected ? '再接続' : '接続'}
      </button>
    </div>
  )
}
