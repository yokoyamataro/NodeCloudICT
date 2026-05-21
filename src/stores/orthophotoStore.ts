import { create } from 'zustand'
import { supabase } from '@/lib/supabase'

export interface OrthophotoTileset {
  id: string
  farmId: string
  name: string
  storagePath: string // 例: '{farm_id}/{tileset_id}'
  minZoom: number
  maxZoom: number
  bounds: { north: number; south: number; east: number; west: number }
  tileFormat: string
  opacity: number
  enabledByDefault: boolean
  createdAt: string
}

interface RawRow {
  id: string
  farm_id: string
  name: string
  storage_path: string
  min_zoom: number
  max_zoom: number
  bounds_north: number
  bounds_south: number
  bounds_east: number
  bounds_west: number
  tile_format: string
  opacity: number
  enabled_by_default: boolean
  created_at: string
}

function rowToTileset(r: RawRow): OrthophotoTileset {
  return {
    id: r.id,
    farmId: r.farm_id,
    name: r.name,
    storagePath: r.storage_path,
    minZoom: r.min_zoom,
    maxZoom: r.max_zoom,
    bounds: {
      north: r.bounds_north,
      south: r.bounds_south,
      east: r.bounds_east,
      west: r.bounds_west,
    },
    tileFormat: r.tile_format,
    opacity: r.opacity,
    enabledByDefault: r.enabled_by_default,
    createdAt: r.created_at,
  }
}

// 公開バケット URL を組み立てる
function getPublicTileUrlTemplate(storagePath: string, tileFormat: string): string {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
  return `${supabaseUrl}/storage/v1/object/public/orthophoto-tiles/${storagePath}/{z}/{x}/{y}.${tileFormat}`
}

interface State {
  byFarm: Map<string, OrthophotoTileset[]>
  loading: boolean
  error: string | null

  fetchByFarm: (farmId: string) => Promise<void>
  createTileset: (input: {
    farmId: string
    name: string
    minZoom: number
    maxZoom: number
    bounds: { north: number; south: number; east: number; west: number }
    tileFormat?: string
    opacity?: number
  }) => Promise<OrthophotoTileset | null>
  /** Storage に z/x/y.png をまとめてアップロード（並列度を制限） */
  uploadTiles: (
    tileset: OrthophotoTileset,
    files: Array<{ relPath: string; file: File }>,
    onProgress?: (done: number, total: number) => void,
  ) => Promise<{ uploaded: number; failed: number; firstError?: string }>
  deleteTileset: (id: string) => Promise<void>
  tileUrlTemplate: (tileset: OrthophotoTileset) => string
}

export const useOrthophotoStore = create<State>((set, get) => ({
  byFarm: new Map(),
  loading: false,
  error: null,

  tileUrlTemplate: (tileset) => getPublicTileUrlTemplate(tileset.storagePath, tileset.tileFormat),

  fetchByFarm: async (farmId) => {
    set({ loading: true, error: null })
    try {
      const { data, error } = await (
        supabase.from('orthophoto_tilesets' as never) as unknown as {
          select: (cols: string) => {
            eq: (col: string, val: string) => {
              order: (col: string, opts: { ascending: boolean }) => Promise<{
                data: RawRow[] | null
                error: { message: string } | null
              }>
            }
          }
        }
      )
        .select('*')
        .eq('farm_id', farmId)
        .order('created_at', { ascending: true })
      if (error) throw error
      const rows = (data ?? []).map(rowToTileset)
      const next = new Map(get().byFarm)
      next.set(farmId, rows)
      set({ byFarm: next, loading: false })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'オルソタイル一覧の取得に失敗しました',
      })
    }
  },

  createTileset: async ({ farmId, name, minZoom, maxZoom, bounds, tileFormat = 'png', opacity = 0.85 }) => {
    try {
      const tilesetId =
        crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const storagePath = `${farmId}/${tilesetId}`
      const payload = {
        id: tilesetId,
        farm_id: farmId,
        name,
        storage_path: storagePath,
        min_zoom: minZoom,
        max_zoom: maxZoom,
        bounds_north: bounds.north,
        bounds_south: bounds.south,
        bounds_east: bounds.east,
        bounds_west: bounds.west,
        tile_format: tileFormat,
        opacity,
        enabled_by_default: false,
      }
      const { data, error } = await (
        supabase.from('orthophoto_tilesets' as never) as unknown as {
          insert: (p: typeof payload) => {
            select: (cols: string) => {
              single: () => Promise<{
                data: RawRow | null
                error: { message: string } | null
              }>
            }
          }
        }
      )
        .insert(payload)
        .select('*')
        .single()
      if (error) throw error
      if (!data) return null
      const saved = rowToTileset(data)
      const list = get().byFarm.get(farmId) ?? []
      const next = new Map(get().byFarm)
      next.set(farmId, [...list, saved])
      set({ byFarm: next })
      return saved
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'タイルセット作成に失敗しました' })
      return null
    }
  },

  uploadTiles: async (tileset, files, onProgress) => {
    const total = files.length
    let done = 0
    let failed = 0
    let firstError: string | undefined
    const CONCURRENCY = 8
    onProgress?.(0, total)

    // ワーカープール: CONCURRENCY 個の同時アップロード
    let idx = 0
    const worker = async () => {
      while (idx < files.length) {
        const my = idx++
        const item = files[my]
        const path = `${tileset.storagePath}/${item.relPath}`
        const { error } = await supabase.storage
          .from('orthophoto-tiles')
          .upload(path, item.file, {
            contentType: item.file.type || 'image/png',
            cacheControl: '604800', // 7 日キャッシュ
            upsert: true,
          })
        if (error) {
          failed++
          if (!firstError) {
            firstError = error.message
            console.error('[orthophoto] upload error', { path, error })
          }
        }
        done++
        onProgress?.(done, total)
      }
    }
    const workers: Promise<void>[] = []
    for (let i = 0; i < CONCURRENCY; i++) workers.push(worker())
    await Promise.all(workers)
    return { uploaded: total - failed, failed, firstError }
  },

  deleteTileset: async (id) => {
    try {
      // 1) Storage 上のファイル削除（フォルダごと）
      const { data: tileset } = await (
        supabase.from('orthophoto_tilesets' as never) as unknown as {
          select: (cols: string) => {
            eq: (c: string, v: string) => {
              single: () => Promise<{ data: RawRow | null }>
            }
          }
        }
      )
        .select('*')
        .eq('id', id)
        .single()
      if (tileset) {
        // 大量ファイルは list → remove のバッチで掃除（最大 1000 件/回）
        const basePrefix = tileset.storage_path + '/'
        // 注: Supabase Storage に再帰削除 API は無いので、list を z/x ごとに再帰で辿る。
        // 簡略のため、ここでは tileset の DB 行のみ削除（孤立ファイルは別途清掃）。
        // 詳細削除は将来対応。
        void basePrefix
      }
      const { error } = await (
        supabase.from('orthophoto_tilesets' as never) as unknown as {
          delete: () => {
            eq: (c: string, v: string) => Promise<{ error: { message: string } | null }>
          }
        }
      )
        .delete()
        .eq('id', id)
      if (error) throw error
      // state 更新（該当行を削除）
      const next = new Map(get().byFarm)
      for (const [fid, list] of next) {
        const filtered = list.filter((t) => t.id !== id)
        if (filtered.length !== list.length) next.set(fid, filtered)
      }
      set({ byFarm: next })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'タイルセット削除に失敗しました' })
    }
  },
}))

// XYZ タイル (z, x, y) の地理境界を計算（Web メルカトル）
export function tileBoundsLatLng(
  z: number,
  x: number,
  y: number,
): { north: number; south: number; west: number; east: number } {
  const n = Math.pow(2, z)
  const lonWest = (x / n) * 360 - 180
  const lonEast = ((x + 1) / n) * 360 - 180
  const latNorth = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
  const latSouth = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI
  return { north: latNorth, south: latSouth, west: lonWest, east: lonEast }
}
