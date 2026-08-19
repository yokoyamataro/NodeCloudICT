// NTRIP キャスター設定の localStorage 永続化 (複数プロファイル対応)。
//
// v2 スキーマ: 名前付きプロファイルを 複数保存し 切替可能
//   { profiles: [{ id, name, config }], activeId }
// v1 スキーマ (旧): 単一 config オブジェクト → 初回読込時に自動 migrate
//
// パスワードを 平文で localStorage に置くのは 理想的ではないが、単一端末の
// ネイティブ WebView 内 (他アプリ から isolate 済み) なので 実運用上の
// リスクは 限定的。後日 Capacitor Preferences (SharedPreferences) や
// Android の EncryptedSharedPreferences への移行を検討。

import type { NtripConfig } from './drogger'

const KEY_V2 = 'nodecloud.ntrip.profiles.v2'
const KEY_V1 = 'nodecloud.ntrip.config.v1'

export interface NtripProfile {
  id: string
  name: string
  config: NtripConfig
}

interface NtripProfileStore {
  profiles: NtripProfile[]
  activeId: string | null
}

/** 既定値 (電子基準点 想定でユーザー入力を促す用) */
export const DEFAULT_NTRIP_CONFIG: NtripConfig = {
  host: '',
  port: 2101,
  mountpoint: '',
  user: '',
  pass: '',
  sendGga: true,
}

function isValidConfig(o: unknown): o is NtripConfig {
  const c = o as Record<string, unknown> | null
  return (
    !!c &&
    typeof c.host === 'string' &&
    typeof c.port === 'number' &&
    typeof c.mountpoint === 'string'
  )
}

function coerceConfig(raw: unknown): NtripConfig | null {
  if (!isValidConfig(raw)) return null
  const o = raw as unknown as Record<string, unknown>
  return {
    host: raw.host,
    port: raw.port,
    mountpoint: raw.mountpoint,
    user: typeof o.user === 'string' ? (o.user as string) : '',
    pass: typeof o.pass === 'string' ? (o.pass as string) : '',
    sendGga: typeof o.sendGga === 'boolean' ? (o.sendGga as boolean) : true,
  }
}

function genId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * ストア全体を読み込む。存在しない場合は 空 or v1 からの migrate 結果を返す。
 * 破損時は 空ストア。
 */
export function loadNtripStore(): NtripProfileStore {
  if (typeof window === 'undefined') return { profiles: [], activeId: null }
  try {
    const raw = window.localStorage.getItem(KEY_V2)
    if (raw) {
      const obj = JSON.parse(raw)
      if (Array.isArray(obj?.profiles)) {
        const profiles: NtripProfile[] = obj.profiles
          .map((p: unknown) => {
            const pr = p as Record<string, unknown>
            const cfg = coerceConfig(pr?.config)
            if (!pr?.id || typeof pr.id !== 'string' || !cfg) return null
            return {
              id: pr.id as string,
              name: typeof pr.name === 'string' ? (pr.name as string) : '(名称未設定)',
              config: cfg,
            }
          })
          .filter((x: NtripProfile | null): x is NtripProfile => x !== null)
        const activeId =
          typeof obj.activeId === 'string' && profiles.some((p) => p.id === obj.activeId)
            ? obj.activeId
            : profiles[0]?.id ?? null
        return { profiles, activeId }
      }
    }
    // v1 からの migrate
    const v1Raw = window.localStorage.getItem(KEY_V1)
    if (v1Raw) {
      const v1cfg = coerceConfig(JSON.parse(v1Raw))
      if (v1cfg) {
        const profile: NtripProfile = {
          id: genId(),
          name: v1cfg.mountpoint || v1cfg.host || 'default',
          config: v1cfg,
        }
        const store: NtripProfileStore = { profiles: [profile], activeId: profile.id }
        saveNtripStore(store)
        window.localStorage.removeItem(KEY_V1)
        return store
      }
    }
  } catch {
    /* 破損した JSON は無視 */
  }
  return { profiles: [], activeId: null }
}

export function saveNtripStore(store: NtripProfileStore): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(KEY_V2, JSON.stringify(store))
}

/** アクティブプロファイルの config を返す (無ければ null)。旧 API 互換用。 */
export function loadNtripConfig(): NtripConfig | null {
  const s = loadNtripStore()
  const p = s.profiles.find((x) => x.id === s.activeId)
  return p?.config ?? null
}

/** 現在アクティブなプロファイルを取得 */
export function getActiveProfile(): NtripProfile | null {
  const s = loadNtripStore()
  return s.profiles.find((x) => x.id === s.activeId) ?? null
}

/** アクティブなプロファイルの config を差し替えて 保存 (無ければ 新規作成) */
export function saveNtripConfig(cfg: NtripConfig, name?: string): NtripProfile {
  const s = loadNtripStore()
  const active = s.profiles.find((x) => x.id === s.activeId)
  if (active) {
    active.config = cfg
    if (name) active.name = name
    saveNtripStore(s)
    return active
  }
  const newProfile: NtripProfile = {
    id: genId(),
    name: name || cfg.mountpoint || cfg.host || '(名称未設定)',
    config: cfg,
  }
  s.profiles.push(newProfile)
  s.activeId = newProfile.id
  saveNtripStore(s)
  return newProfile
}

/** 新規プロファイル追加 + アクティブ化 */
export function addNtripProfile(name: string, cfg: NtripConfig): NtripProfile {
  const s = loadNtripStore()
  const profile: NtripProfile = { id: genId(), name, config: cfg }
  s.profiles.push(profile)
  s.activeId = profile.id
  saveNtripStore(s)
  return profile
}

/** 指定 ID のプロファイル削除。アクティブなら他に切替 */
export function deleteNtripProfile(id: string): void {
  const s = loadNtripStore()
  const idx = s.profiles.findIndex((p) => p.id === id)
  if (idx < 0) return
  s.profiles.splice(idx, 1)
  if (s.activeId === id) s.activeId = s.profiles[0]?.id ?? null
  saveNtripStore(s)
}

/** プロファイル名変更 */
export function renameNtripProfile(id: string, name: string): void {
  const s = loadNtripStore()
  const p = s.profiles.find((x) => x.id === id)
  if (!p) return
  p.name = name
  saveNtripStore(s)
}

/** アクティブプロファイルを 切替 */
export function setActiveNtripProfile(id: string): void {
  const s = loadNtripStore()
  if (!s.profiles.some((p) => p.id === id)) return
  s.activeId = id
  saveNtripStore(s)
}

/** 全プロファイルクリア (デバッグ / リセット用) */
export function clearNtripConfig(): void {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(KEY_V2)
  window.localStorage.removeItem(KEY_V1)
}
