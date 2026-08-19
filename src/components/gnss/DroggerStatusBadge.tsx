// GPS 設定バッジ。Fix 品質と NTRIP RTCM 受信状態を コンパクトに表示し、
// タップで GpsSettingsModal を開く。
//
// 以前は Drogger 状態バッジ + NTRIP 歯車 の 2 個並びだったが、
// 「GPS設定」1 個に集約 (モーダル 4 タブで 詳細設定)。
//
// LocationSource='drogger' の時だけ表示。source が 'drogger' でない
// 時は null を返すため、常時マウントしていても 邪魔にならない。

import { useEffect, useState } from 'react'
import { Radio, RadioTower, WifiOff, Settings } from 'lucide-react'
import { getActiveSource } from '@/lib/geolocation'
import {
  DroggerLocation,
  startNtrip,
  startWithAutoDetect,
  type DroggerFixQuality,
  type DroggerLocationEvent,
  type NtripStatus,
} from '@/lib/drogger'
import { loadNtripConfig } from '@/lib/ntripPrefs'
import { GpsSettingsModal } from '@/features/gnss/GpsSettingsModal'

interface DroggerStatus {
  connected: boolean
  deviceName: string | null
  fixQuality: DroggerFixQuality | null
  hdop: number | null
  satellites: number | null
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

export function DroggerStatusBadge({ className }: { className?: string }) {
  const [source, setSource] = useState(() => getActiveSource())
  const [status, setStatus] = useState<DroggerStatus>({
    connected: false,
    deviceName: null,
    fixQuality: null,
    hdop: null,
    satellites: null,
    lastUpdateAt: null,
  })
  const [ntrip, setNtrip] = useState<NtripStatus>({
    connected: false,
    host: null,
    mountpoint: null,
    bytesReceived: 0,
    lastRtcmAt: 0,
  })
  const [showSettings, setShowSettings] = useState(false)

  // source は URL クエリ or プラットフォーム判定で決まる。ページ遷移で
  // 変わり得るため一応 poll する (URL 変更検知の代替)。
  useEffect(() => {
    const t = window.setInterval(() => {
      const s = getActiveSource()
      setSource((prev) => (prev !== s ? s : prev))
    }, 2000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    if (source !== 'drogger') return
    let removed = false
    const handles: Array<{ remove: () => Promise<void> }> = []

    const onLocation = (ev: DroggerLocationEvent) => {
      setStatus((prev) => ({
        ...prev,
        fixQuality: ev.fixQuality,
        hdop: ev.hdop,
        satellites: ev.satellites,
        lastUpdateAt: Date.now(),
      }))
    }
    const onStatusChange = (ev: { connected: boolean; deviceName: string | null }) => {
      setStatus((prev) => ({ ...prev, connected: ev.connected, deviceName: ev.deviceName }))
    }
    const onError = (ev: { code: string; message: string }) => {
      // 接続失敗時は connected を false に落として badge を「未接続」表示に
      setStatus((prev) => ({
        ...prev,
        connected: false,
        deviceName: `${prev.deviceName ?? ''} [${ev.code}]`,
      }))
    }
    const onNtripStatus = (ev: NtripStatus) => {
      setNtrip(ev)
    }

    void (async () => {
      const locH = await DroggerLocation.addListener('location', onLocation)
      const stH = await DroggerLocation.addListener('statusChange', onStatusChange)
      const errH = await DroggerLocation.addListener('error', onError)
      const ntH = await DroggerLocation.addListener('ntripStatusChange', onNtripStatus)
      if (removed) {
        await locH.remove()
        await stH.remove()
        await errH.remove()
        await ntH.remove()
        return
      }
      handles.push(locH, stH, errH, ntH)
      // 初回状態を取得
      const cur = await DroggerLocation.getStatus()
      setStatus((prev) => ({ ...prev, connected: cur.connected, deviceName: cur.deviceName }))
      try {
        const ns = await DroggerLocation.getNtripStatus()
        setNtrip(ns)
      } catch {
        /* ネイティブ未実装環境等は無視 */
      }
      // 常に stop → start で 前セッションの残留接続を綺麗に切ってから開始する
      // (BT 権限プロンプトも start 側で自動的に出る)
      try {
        await DroggerLocation.stop().catch(() => undefined)
        await startWithAutoDetect()
        // BT 接続成功 → 保存済み NTRIP 設定があれば自動接続
        const cfg = loadNtripConfig()
        if (cfg && cfg.host && cfg.port && cfg.mountpoint) {
          try {
            await startNtrip(cfg)
          } catch (e) {
            console.warn('NTRIP auto-start failed:', e)
          }
        }
      } catch (e) {
        // start() が reject した場合 (権限拒否/BT off/未ペアリング等) は
        // onError リスナー経由で badge に反映されるので ここでは何もしない
        console.warn('DroggerLocation.start failed:', e)
      }
    })()

    return () => {
      removed = true
      for (const h of handles) void h.remove()
    }
  }, [source])

  if (source !== 'drogger') return null

  const fq = status.fixQuality
  const boxClass =
    fq != null
      ? FIX_CLASS[fq]
      : status.connected
        ? 'bg-slate-100 border-slate-400 text-slate-700'
        : 'bg-red-100 border-red-400 text-red-800'
  const fixLabel = fq != null ? FIX_LABEL[fq] : status.connected ? '受信中…' : '未接続'
  const icon = !status.connected ? (
    <WifiOff className="h-3 w-3" />
  ) : fq === 4 ? (
    <RadioTower className="h-3 w-3" />
  ) : (
    <Radio className="h-3 w-3" />
  )
  const staleMs = status.lastUpdateAt != null ? Date.now() - status.lastUpdateAt : null
  const isStale = staleMs != null && staleMs > 5000
  const ntripStaleMs = ntrip.lastRtcmAt > 0 ? Date.now() - ntrip.lastRtcmAt : null
  const ntripStale = ntrip.connected && ntripStaleMs != null && ntripStaleMs > 15_000

  const tooltip = [
    `GPS: ${status.deviceName ?? '(未接続)'}`,
    fq != null ? `Fix: ${FIX_LABEL[fq]}` : null,
    status.hdop != null ? `HDOP: ${status.hdop.toFixed(2)}` : null,
    status.satellites != null ? `Sats: ${status.satellites}` : null,
    isStale ? `更新: ${Math.round((staleMs ?? 0) / 1000)} 秒前` : null,
    ntrip.connected
      ? `NTRIP: ${ntrip.host}/${ntrip.mountpoint} (${(ntrip.bytesReceived / 1024).toFixed(1)} KB${
          ntripStale ? ' / stale' : ''
        })`
      : 'NTRIP: 未接続',
    '(タップで GPS 設定)',
  ]
    .filter(Boolean)
    .join(' / ')

  return (
    <>
      <button
        type="button"
        onClick={() => setShowSettings(true)}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold cursor-pointer hover:brightness-110 ${boxClass} ${
          isStale ? 'opacity-60' : ''
        } ${className ?? ''}`}
        title={tooltip}
      >
        <Settings className="h-3 w-3" />
        {icon}
        <span>{fixLabel}</span>
        {status.hdop != null && (
          <span className="text-[9px] font-mono opacity-70">H{status.hdop.toFixed(1)}</span>
        )}
        {status.satellites != null && (
          <span className="text-[9px] font-mono opacity-70">S{status.satellites}</span>
        )}
        {/* NTRIP 受信インジケーター (小さな 点) */}
        {ntrip.connected && (
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${
              ntripStale ? 'bg-amber-500' : 'bg-emerald-500 animate-pulse'
            }`}
            title="NTRIP RTCM 受信中"
          />
        )}
      </button>
      <GpsSettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
    </>
  )
}
