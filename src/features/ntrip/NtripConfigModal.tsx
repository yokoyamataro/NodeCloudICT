// NTRIP キャスター設定 UI。
//
// - host / port / mountpoint / user / pass / sendGga を入力
// - 「mountpoint 取得」ボタンで キャスターの SourceTable を fetch して プルダウン化
// - 「接続」ボタンで startNtrip を呼び、localStorage にも保存
// - 「切断」で stopNtrip

import { useEffect, useState } from 'react'
import { X, Radio, Loader2, Satellite, Trash2, Plus, Pencil } from 'lucide-react'
import {
  fetchNtripSourceTable,
  getNtripStatus,
  startNtrip,
  stopNtrip,
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
import { SkyMap } from './SkyMap'

type Tab = 'ntrip' | 'skymap'

interface Props {
  open: boolean
  onClose: () => void
}

export function NtripConfigModal({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('ntrip')
  const [profiles, setProfiles] = useState<NtripProfile[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [cfg, setCfg] = useState<NtripConfig>(DEFAULT_NTRIP_CONFIG)
  const [profileName, setProfileName] = useState<string>('')
  const [mountpoints, setMountpoints] = useState<NtripMountpoint[] | null>(null)
  const [fetching, setFetching] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<NtripStatus | null>(null)

  // 開いた時に プロファイル一覧を再ロード + 現状取得
  useEffect(() => {
    if (!open) return
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
  }, [open])

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

  if (!open) return null

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
      // アクティブプロファイルに 現在値を保存 (無ければ 新規作成)
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
            <Radio className="h-4 w-4 text-emerald-600" />
            <h2 className="text-sm font-bold">GNSS / NTRIP</h2>
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

        {/* タブ */}
        <div className="flex border-b bg-slate-50">
          <button
            type="button"
            onClick={() => setTab('ntrip')}
            className={`flex-1 py-2 text-xs font-semibold flex items-center justify-center gap-1 ${
              tab === 'ntrip'
                ? 'bg-white border-b-2 border-emerald-600 text-emerald-800'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Radio className="h-3 w-3" />
            接続設定
          </button>
          <button
            type="button"
            onClick={() => setTab('skymap')}
            className={`flex-1 py-2 text-xs font-semibold flex items-center justify-center gap-1 ${
              tab === 'skymap'
                ? 'bg-white border-b-2 border-emerald-600 text-emerald-800'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Satellite className="h-3 w-3" />
            衛星 (スカイマップ)
          </button>
        </div>

        {tab === 'skymap' ? (
          <div className="p-4">
            <SkyMap />
          </div>
        ) : (
        <div className="p-4 space-y-3 text-xs">
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
            <div className="bg-red-50 border border-red-300 rounded p-2 text-red-800">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-50"
            >
              閉じる
            </button>
            <button
              type="button"
              onClick={handleConnect}
              disabled={connecting}
              className="px-3 py-1.5 rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1"
            >
              {connecting && <Loader2 className="h-3 w-3 animate-spin" />}
              {status?.connected ? '再接続' : '接続'}
            </button>
          </div>
        </div>
        )}
      </div>
    </div>
  )
}
