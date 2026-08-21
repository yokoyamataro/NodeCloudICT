// GPS 設定バッジ。 Fix 品質と NTRIP RTCM 受信状態を コンパクトに表示し、
// タップで GpsSettingsModal を 開く。
//
// BT 接続の ライフサイクルは 全アプリ横断の droggerConnectionStore が 管理。
// バッジは 表示専用 で 「マウント/アンマウント で BT を 触らない」ため、
// ページ遷移 (工区 → 工区一覧 → 別工区) で 接続が 切れない。

import { useEffect, useState } from 'react'
import { Radio, RadioTower, WifiOff, Settings } from 'lucide-react'
import { getActiveSource } from '@/lib/geolocation'
import type { DroggerFixQuality } from '@/lib/drogger'
import { useDroggerConnection } from '@/stores/droggerConnectionStore'
import { GpsSettingsModal } from '@/features/gnss/GpsSettingsModal'

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

export function DroggerStatusBadge({ className }: { className?: string }) {
  const [source, setSource] = useState(() => getActiveSource())
  const {
    connected,
    deviceName,
    fixQuality,
    hdop,
    satellites,
    lastUpdateAt,
    ntrip,
    ensureStarted,
  } = useDroggerConnection()
  const [showSettings, setShowSettings] = useState(false)

  // source は URL クエリ or プラットフォーム判定で決まる。
  // ページ遷移で 変わり得るため 一応 poll する (URL 変更検知の代替)。
  useEffect(() => {
    const t = window.setInterval(() => {
      const s = getActiveSource()
      setSource((prev) => (prev !== s ? s : prev))
    }, 2000)
    return () => window.clearInterval(t)
  }, [])

  // Drogger モード の 時に BT を 開始 (グローバル store が 1 回だけ実行)。
  // バッジ アンマウント時 は 何もしない = 接続維持
  useEffect(() => {
    if (source === 'drogger') void ensureStarted()
  }, [source, ensureStarted])

  if (source !== 'drogger') return null

  const fq = fixQuality
  const boxClass =
    fq != null
      ? FIX_CLASS[fq]
      : connected
        ? 'bg-slate-100 border-slate-400 text-slate-700'
        : 'bg-red-100 border-red-400 text-red-800'
  const fixLabel = !connected ? '切断' : fq != null ? FIX_LABEL[fq] : '受信中'
  const icon = !connected ? (
    <WifiOff className="h-3 w-3" />
  ) : fq === 4 ? (
    <RadioTower className="h-3 w-3" />
  ) : (
    <Radio className="h-3 w-3" />
  )
  const staleMs = lastUpdateAt != null ? Date.now() - lastUpdateAt : null
  const isStale = staleMs != null && staleMs > 5000
  const ntripStaleMs = ntrip.lastRtcmAt > 0 ? Date.now() - ntrip.lastRtcmAt : null
  const ntripStale = ntrip.connected && ntripStaleMs != null && ntripStaleMs > 15_000

  const tooltip = [
    `GPS: ${deviceName ?? '(未接続)'}`,
    fq != null ? `Fix: ${FIX_LABEL[fq]}` : null,
    hdop != null ? `HDOP: ${hdop.toFixed(2)}` : null,
    satellites != null ? `Sats: ${satellites}` : null,
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
