// GPS 設定モーダル。バッジ (GPS設定ボタン) から開かれる 4 タブの統合 UI:
//   1. GPS接続  — Drogger BT 接続状態 / Fix品質 / 再接続
//   2. NTRIP接続 — NTRIP キャスター プロファイル管理 + 接続
//   3. 衛星状況 — スカイマップ + SNR バー
//   4. 姿勢情報 — heading/pitch/roll (NMEA から)
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
  Compass,
  RefreshCw,
  RadioTower,
  WifiOff,
  Volume2,
  VolumeX,
} from 'lucide-react'
import {
  useGnssSettingsStore,
  FIX_ACCURACY_MIN_M,
  FIX_ACCURACY_MAX_M,
} from '@/stores/gnssSettingsStore'
import {
  DroggerLocation,
  fetchNtripSourceTable,
  getNtripStatus,
  startNtrip,
  startWithAutoDetect,
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
import { AttitudeView } from './AttitudeView'

type Tab = 'gps' | 'ntrip' | 'sky' | 'attitude'

interface Props {
  open: boolean
  onClose: () => void
}

interface DroggerStatusSnapshot {
  connected: boolean
  deviceName: string | null
  fixQuality: DroggerFixQuality | null
  hdop: number | null
  satellites: number | null
  lat: number | null
  lon: number | null
  altitude: number | null
  accuracy: number | null
  altitudeAccuracy: number | null
  lastUpdateAt: number | null
}

const FIX_LABEL: Record<DroggerFixQuality, string> = {
  0: 'No Fix',
  1: 'GPS',
  2: 'DGPS',
  4: 'RTK Fix',
  5: 'RTK Float',
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
          <TabButton active={tab === 'attitude'} onClick={() => setTab('attitude')} icon={<Compass className="h-3 w-3" />} label="姿勢情報" />
        </div>

        <div className="p-4">
          {tab === 'gps' && <GpsConnectionTab />}
          {tab === 'ntrip' && <NtripTab />}
          {tab === 'sky' && <SkyMap />}
          {tab === 'attitude' && <AttitudeView />}
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
  const [status, setStatus] = useState<DroggerStatusSnapshot>({
    connected: false,
    deviceName: null,
    fixQuality: null,
    hdop: null,
    satellites: null,
    lat: null,
    lon: null,
    altitude: null,
    accuracy: null,
    altitudeAccuracy: null,
    lastUpdateAt: null,
  })
  const [reconnecting, setReconnecting] = useState(false)
  const [reconnectError, setReconnectError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const handles: Array<{ remove: () => Promise<void> }> = []

    const onLocation = (ev: DroggerLocationEvent) => {
      setStatus((prev) => ({
        ...prev,
        lat: ev.lat,
        lon: ev.lon,
        altitude: ev.altitude_m,
        accuracy: ev.accuracy_m,
        altitudeAccuracy: ev.altitude_accuracy_m,
        fixQuality: ev.fixQuality,
        hdop: ev.hdop,
        satellites: ev.satellites,
        lastUpdateAt: Date.now(),
      }))
    }
    const onStatusChange = (ev: { connected: boolean; deviceName: string | null }) => {
      setStatus((prev) => ({ ...prev, connected: ev.connected, deviceName: ev.deviceName }))
    }

    void (async () => {
      const locH = await DroggerLocation.addListener('location', onLocation)
      const stH = await DroggerLocation.addListener('statusChange', onStatusChange)
      if (cancelled) {
        await locH.remove()
        await stH.remove()
        return
      }
      handles.push(locH, stH)
      try {
        const cur = await DroggerLocation.getStatus()
        setStatus((prev) => ({ ...prev, connected: cur.connected, deviceName: cur.deviceName }))
      } catch {
        /* ignore */
      }
    })()

    return () => {
      cancelled = true
      for (const h of handles) void h.remove()
    }
  }, [])

  const handleReconnect = async () => {
    setReconnecting(true)
    setReconnectError(null)
    try {
      await DroggerLocation.stop().catch(() => undefined)
      await startWithAutoDetect()
    } catch (e) {
      setReconnectError((e as Error)?.message ?? String(e))
    } finally {
      setReconnecting(false)
    }
  }

  const fq = status.fixQuality
  const fixClass =
    fq != null
      ? FIX_CLASS[fq]
      : status.connected
        ? 'bg-slate-100 border-slate-400 text-slate-700'
        : 'bg-red-100 border-red-400 text-red-800'
  const fixLabel = fq != null ? FIX_LABEL[fq] : status.connected ? '受信中…' : '未接続'
  const staleMs = status.lastUpdateAt ? Date.now() - status.lastUpdateAt : null
  const isStale = staleMs != null && staleMs > 5000

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
            <div className="text-[10px] text-slate-500">標高</div>
            <div>{status.altitude != null ? `${status.altitude.toFixed(3)}m` : '-'}</div>
          </div>
        </div>
        <div className="text-[10px] text-slate-500">
          精度 H: {status.accuracy != null ? `${status.accuracy.toFixed(3)}m` : '-'} /
          V: {status.altitudeAccuracy != null ? `${status.altitudeAccuracy.toFixed(3)}m` : '-'} /
          最終更新:{' '}
          {status.lastUpdateAt
            ? `${Math.round(((staleMs ?? 0) / 1000))} 秒前`
            : '-'}
          {isStale && <span className="text-red-600 ml-1">(stale)</span>}
        </div>
      </div>

      {/* 再接続 */}
      <button
        type="button"
        onClick={handleReconnect}
        disabled={reconnecting}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-50"
      >
        {reconnecting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4" />
        )}
        再接続 (stop → start)
      </button>
      {reconnectError && (
        <div className="bg-red-50 border border-red-300 rounded p-2 text-red-800">
          {reconnectError}
        </div>
      )}

      <div className="text-[10px] text-slate-500 leading-relaxed">
        Bluetooth SPP で Drogger 受信機に 直接接続。BT の 権限プロンプトが 出た場合は 許可。
        接続失敗時は 端末の Bluetooth 設定を 確認 or Drogger を 再起動。
      </div>

      {/* ---- 端末側 GNSS 設定 (音声 / 平均秒数 / アンテナ高 / ジオイド / 判定精度) ---- */}
      <GnssSettingsSection />
    </div>
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
    rtkFixAccuracyM,
    setRtkFixAccuracyM,
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

      {/* アンテナ高 */}
      <label className="block">
        <span className="text-slate-700">アンテナ高 (m)</span>
        <input
          type="number"
          step={0.01}
          value={antennaHeight}
          onChange={(e) => {
            const n = parseFloat(e.target.value)
            if (Number.isFinite(n)) setAntennaHeight(n)
          }}
          className="mt-1 w-full px-2 py-1 border border-slate-300 rounded text-right font-mono"
        />
        <span className="text-[10px] text-slate-500">
          ロッド/ポール先端 〜 アンテナ位相中心 までの 高さ。標高 = 楕円体高 − ジオイド高 − アンテナ高
        </span>
      </label>

      {/* ジオイド補正 */}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={useGeoidCorrection}
          onChange={(e) => setUseGeoidCorrection(e.target.checked)}
        />
        <span>ジオイド補正 (JPGEO2024)</span>
      </label>

      {/* RTK 判定精度 */}
      <label className="block">
        <div className="flex items-center justify-between">
          <span className="text-slate-700">RTK 判定精度</span>
          <span className="font-mono">{(rtkFixAccuracyM * 100).toFixed(1)} cm 以下で FIX</span>
        </div>
        <input
          type="range"
          min={FIX_ACCURACY_MIN_M}
          max={FIX_ACCURACY_MAX_M}
          step={0.005}
          value={rtkFixAccuracyM}
          onChange={(e) => setRtkFixAccuracyM(parseFloat(e.target.value))}
          className="w-full mt-1"
        />
        <span className="text-[10px] text-slate-500">
          この精度を上回るときは 測定ボタンが 琥珀色になり、RTK 受信音 (ピッ) も止まります。
        </span>
      </label>
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
