// Drogger 直接受信の 接続状態 + Fix 品質バッジ。
// LocationSource='drogger' の時だけ表示され、既存の位置取得パイプラインには影響しない。
//
// 使い方:
//   <DroggerStatusBadge />
// を任意ページの ヘッダ/オーバーレイに配置するだけ。source が 'drogger' でない
// 時は null を返すため、常時マウントしていても 邪魔にならない。

import { useEffect, useState } from 'react'
import { Radio, RadioTower, WifiOff } from 'lucide-react'
import { getActiveSource } from '@/lib/geolocation'
import {
  DroggerLocation,
  type DroggerFixQuality,
  type DroggerLocationEvent,
} from '@/lib/drogger'

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

    void (async () => {
      const locH = await DroggerLocation.addListener('location', onLocation)
      const stH = await DroggerLocation.addListener('statusChange', onStatusChange)
      const errH = await DroggerLocation.addListener('error', onError)
      if (removed) {
        await locH.remove()
        await stH.remove()
        await errH.remove()
        return
      }
      handles.push(locH, stH, errH)
      // 初回状態を取得
      const cur = await DroggerLocation.getStatus()
      setStatus((prev) => ({ ...prev, connected: cur.connected, deviceName: cur.deviceName }))
      // まだ接続していなければ 自動的に接続開始 (BT 権限プロンプトが出る)
      if (!cur.connected) {
        try {
          await DroggerLocation.start()
        } catch (e) {
          // start() が reject した場合 (権限拒否/BT off/未ペアリング等) は
          // onError リスナー経由で badge に反映されるので ここでは何もしない
          console.warn('DroggerLocation.start failed:', e)
        }
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
  const label = fq != null ? FIX_LABEL[fq] : status.connected ? '受信中…' : '未接続'
  const icon = !status.connected ? (
    <WifiOff className="h-3 w-3" />
  ) : fq === 4 ? (
    <RadioTower className="h-3 w-3" />
  ) : (
    <Radio className="h-3 w-3" />
  )
  const staleMs =
    status.lastUpdateAt != null ? Date.now() - status.lastUpdateAt : null
  const isStale = staleMs != null && staleMs > 5000
  const tooltip = [
    `Drogger: ${status.deviceName ?? '(未接続)'}`,
    fq != null ? `Fix: ${FIX_LABEL[fq]}` : null,
    status.hdop != null ? `HDOP: ${status.hdop.toFixed(2)}` : null,
    status.satellites != null ? `Sats: ${status.satellites}` : null,
    isStale ? `${Math.round((staleMs ?? 0) / 1000)} 秒前` : null,
  ]
    .filter(Boolean)
    .join(' / ')

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${boxClass} ${
        isStale ? 'opacity-60' : ''
      } ${className ?? ''}`}
      title={tooltip}
    >
      {icon}
      <span>{label}</span>
      {status.hdop != null && (
        <span className="text-[9px] font-mono opacity-70">H{status.hdop.toFixed(1)}</span>
      )}
      {status.satellites != null && (
        <span className="text-[9px] font-mono opacity-70">S{status.satellites}</span>
      )}
    </span>
  )
}
