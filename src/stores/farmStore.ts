import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { supabase } from '@/lib/supabase'
import { CoordinateConverter } from '@/lib/coordinates'
import { useMapViewStore } from './mapViewStore'
import { useProjectListStore } from './projectListStore'

export interface Farm {
  id: string
  user_id: string
  project_id: string
  name: string
  description: string | null
  created_at: string
  updated_at: string
}

// 工区の先頭座標情報
export interface FarmLocation {
  farmId: string
  lat: number
  lng: number
  pointNumber: string
}

// 工事区域のポリゴン情報
export interface WorkAreaPolygon {
  id: string
  farmId: string
  workType: string
  name: string
  positions: [number, number][]
}

// プロジェクトIDから座標系を取得（projectListStore を優先し、不足分はDBから補完）
async function fetchProjectZones(projectIds: string[]): Promise<Map<string, number>> {
  const unique = Array.from(new Set(projectIds))
  const zones = new Map<string, number>()

  // まずストアから取得
  const storeProjects = useProjectListStore.getState().projects
  const missing: string[] = []
  for (const id of unique) {
    const proj = storeProjects.find((p) => p.id === id)
    if (proj) {
      zones.set(id, proj.coordinate_zone)
    } else {
      missing.push(id)
    }
  }

  // ストアに無いものだけDBから取得
  if (missing.length > 0) {
    const { data, error } = await supabase
      .from('projects')
      .select('id, coordinate_zone')
      .in('id', missing)
    if (!error && data) {
      const rows = data as Array<{ id: string; coordinate_zone: number }>
      for (const row of rows) {
        zones.set(row.id, row.coordinate_zone)
      }
    }
  }

  return zones
}

interface FarmState {
  // 工区一覧
  farms: Farm[]
  loading: boolean
  error: string | null

  // 工区の位置情報（先頭座標）
  farmLocations: Map<string, FarmLocation>

  // 工事区域ポリゴン
  workAreaPolygons: WorkAreaPolygon[]

  // 現在の工区
  currentFarm: Farm | null
  setCurrentFarm: (farm: Farm | null) => void

  // CRUD操作
  fetchFarms: (projectId?: string) => Promise<void>
  fetchFarmLocations: () => Promise<void>
  fetchWorkAreaPolygons: () => Promise<void>
  createFarm: (projectId: string, name: string, description?: string) => Promise<Farm | null>
  updateFarm: (id: string, updates: Partial<Pick<Farm, 'name' | 'description'>>) => Promise<void>
  deleteFarm: (
    id: string,
    onProgress?: (phase: string, done?: number, total?: number) => void,
  ) => Promise<void>
}

export const useFarmStore = create<FarmState>()(
  persist(
    (set, get) => ({
  farms: [],
  loading: false,
  error: null,
  currentFarm: null,
  farmLocations: new Map(),
  workAreaPolygons: [],

  setCurrentFarm: (farm) => {
    // 工区が変わったら地図の表示状態をリセット（座標にフィットさせる）
    const currentFarm = get().currentFarm
    if (farm?.id !== currentFarm?.id) {
      useMapViewStore.getState().resetView()
    }
    set({ currentFarm: farm })
  },

  fetchFarms: async (projectId?: string) => {
    set({ loading: true, error: null })
    try {
      let query = supabase
        .from('farms')
        .select('*')
        .order('updated_at', { ascending: false })

      if (projectId) {
        query = query.eq('project_id', projectId)
      }

      const { data, error } = await query

      if (error) throw error
      set({ farms: data || [], loading: false })

      // 位置情報も取得
      get().fetchFarmLocations()
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '工区の取得に失敗しました', loading: false })
    }
  },

  fetchFarmLocations: async () => {
    const { farms } = get()
    if (farms.length === 0) return

    try {
      // 工区ごとの先頭座標 1 行だけを RPC で取得する。
      // 生の .from('design_coordinates').in(...) だと Supabase の db-max-rows
      // （既定 1000）に引っかかって、座標数の多いプロジェクトで後ろの工区が
      // 結果から欠落してしまうため、DISTINCT ON を行う SQL 関数を経由する。
      const { data, error } = await (
        supabase.rpc as unknown as (
          fn: string,
          args: { p_farm_ids: string[] },
        ) => Promise<{
          data: Array<{ farm_id: string; point_number: string; x: number; y: number }> | null
          error: { message: string } | null
        }>
      )('get_farm_first_coords', { p_farm_ids: farms.map((f) => f.id) })

      if (error) throw error

      // プロジェクトごとの座標系を取得
      const projectZones = await fetchProjectZones(farms.map(f => f.project_id))

      // RPC は工区ごとに 1 行を返す前提だが、保険として Map で集約
      const byFarmId = new Map<string, { point_number: string; x: number; y: number }>()
      for (const row of data ?? []) {
        if (!byFarmId.has(row.farm_id)) {
          byFarmId.set(row.farm_id, {
            point_number: row.point_number,
            x: row.x,
            y: row.y,
          })
        }
      }

      const locations = new Map<string, FarmLocation>()
      for (const farm of farms) {
        const head = byFarmId.get(farm.id)
        if (!head) continue
        const zone = projectZones.get(farm.project_id) ?? 13
        const converter = new CoordinateConverter(zone)
        const { lat, lng } = converter.toLatLng(head.x, head.y)
        locations.set(farm.id, {
          farmId: farm.id,
          lat,
          lng,
          pointNumber: head.point_number,
        })
      }

      set({ farmLocations: locations })
    } catch (err) {
      console.error('位置情報の取得に失敗:', err)
    }
  },

  fetchWorkAreaPolygons: async () => {
    // farms 配列が空でも currentFarm が立っていれば、そのファームだけを対象に
    // ポリゴンを取りに行く。
    // 例えばモバイルから直接 staking 画面へ来た場合は fetchFarms() が呼ばれて
    // おらず farms が空のままで、地番ポリゴンが一切表示されない不具合があった。
    const { farms, currentFarm } = get()
    const targetFarms = farms.length > 0
      ? farms
      : (currentFarm ? [currentFarm] : [])
    if (targetFarms.length === 0) {
      set({ workAreaPolygons: [] })
      return
    }

    try {
      const polygons: WorkAreaPolygon[] = []

      // 1. design_work_areas から工事区域を取得（客土、整地など）
      const { data: areasData, error: areaError } = await supabase
        .from('design_work_areas')
        .select('id, farm_id, work_type, zone_number, name')
        .in('farm_id', targetFarms.map(f => f.id))

      if (areaError) throw areaError

      const areas = areasData as Array<{
        id: string
        farm_id: string
        work_type: string
        zone_number: string
        name: string | null
      }> | null

      if (areas && areas.length > 0) {
        // design_work_areasのpoint_idsを取得
        const { data: areasWithPointIds, error: pointIdsError } = await supabase
          .from('design_work_areas')
          .select('id, point_ids')
          .in('id', areas.map(a => a.id))

        if (pointIdsError) throw pointIdsError

        const areasPointIds = areasWithPointIds as Array<{
          id: string
          point_ids: string[] | null
        }> | null

        // design_coordinates は work_area が属する各 farm_id 単位でページング取得する
        // （in('id', [...uuids]) は URL 長 + 1000 行上限の問題があるため使わない）
        const coordsMap: Record<string, { x: number; y: number }> = {}
        const farmIdsWithAreas = new Set(areas.map(a => a.farm_id))
        const PAGE = 1000
        for (const fid of farmIdsWithAreas) {
          let from = 0
          while (from < 1_000_000) {
            // ORDER BY を付けないとページ境界でロウがこぼれ、ポリゴン
            // の構成点不足 (< 3 点) で polygon が丸ごと捨てられるため、
            // 2000 点規模で地番が画面に出なくなる。id 順で安定ページング
            // する。
            const { data: coordsData, error: coordError } = await supabase
              .from('design_coordinates')
              .select('id, x, y')
              .eq('farm_id', fid)
              .order('id')
              .range(from, from + PAGE - 1)
            if (coordError) throw coordError
            const rows = (coordsData || []) as Array<{ id: string; x: number; y: number }>
            for (const c of rows) coordsMap[c.id] = { x: c.x, y: c.y }
            if (rows.length < PAGE) break
            from += PAGE
          }
        }

        // プロジェクトごとの座標系を取得
        const projectZones = await fetchProjectZones(targetFarms.map(f => f.project_id))

        for (const area of areas) {
          const farm = targetFarms.find(f => f.id === area.farm_id)
          if (!farm) continue

          const areaPointIds = areasPointIds?.find(a => a.id === area.id)?.point_ids || []
          if (areaPointIds.length < 3) continue

          const zone = projectZones.get(farm.project_id) ?? 13
          const converter = new CoordinateConverter(zone)
          const positions: [number, number][] = []

          for (const pointId of areaPointIds) {
            const coord = coordsMap[pointId]
            if (coord) {
              const { lat, lng } = converter.toLatLng(coord.x, coord.y)
              positions.push([lat, lng])
            }
          }

          if (positions.length < 3) continue

          polygons.push({
            id: area.id,
            farmId: area.farm_id,
            workType: area.work_type,
            name: area.name || area.zone_number || '',
            positions,
          })
        }
      }

      // 取得結果のサマリ（地番が出ない時の原因切り分け用）
      const byType = new Map<string, number>()
      for (const p of polygons) byType.set(p.workType, (byType.get(p.workType) ?? 0) + 1)
      // eslint-disable-next-line no-console
      console.info(
        '[farmStore] fetchWorkAreaPolygons',
        `total=${polygons.length}`,
        Object.fromEntries(byType),
        `targetFarms=${targetFarms.map((f) => f.id).join(',')}`,
      )
      set({ workAreaPolygons: polygons })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[farmStore] fetchWorkAreaPolygons failed', err)
      set({ workAreaPolygons: [] })
    }
  },

  createFarm: async (projectId, name, description) => {
    set({ loading: true, error: null })
    try {
      // 現在のユーザーIDを取得
      const { data: { user }, error: userError } = await supabase.auth.getUser()
      if (userError || !user) {
        throw new Error('ユーザー認証情報を取得できませんでした')
      }

      const insertData = {
        user_id: user.id,
        project_id: projectId,
        name,
        description: description || null,
      }

      const { data, error } = await supabase
        .from('farms')
        .insert(insertData as never)
        .select()
        .single()

      if (error) throw error

      set((state) => ({
        farms: [data, ...state.farms],
        loading: false,
      }))

      return data
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '工区の作成に失敗しました', loading: false })
      return null
    }
  },

  updateFarm: async (id, updates) => {
    set({ loading: true, error: null })
    try {
      const { error } = await supabase
        .from('farms')
        .update(updates as never)
        .eq('id', id)

      if (error) throw error

      set((state) => ({
        farms: state.farms.map((f) =>
          f.id === id ? { ...f, ...updates } : f
        ),
        currentFarm: state.currentFarm?.id === id
          ? { ...state.currentFarm, ...updates }
          : state.currentFarm,
        loading: false,
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '工区の更新に失敗しました', loading: false })
    }
  },

  deleteFarm: async (id, onProgress) => {
    set({ loading: true, error: null })
    try {
      // 1. 関連する design_coordinates / design_work_areas / design_pipes の ID を集める。
      //    attachments は entity_type/entity_id で参照しているので、これらの ID を経由して
      //    attachments を引く必要がある。
      onProgress?.('関連データを集約中')
      const [coordsRes, wareasRes, pipesRes] = await Promise.all([
        supabase.from('design_coordinates').select('id').eq('farm_id', id),
        supabase.from('design_work_areas').select('id').eq('farm_id', id),
        supabase.from('design_pipes').select('id').eq('farm_id', id),
      ])
      const coordIds = ((coordsRes.data ?? []) as { id: string }[]).map((r) => r.id)
      const wareaIds = ((wareasRes.data ?? []) as { id: string }[]).map((r) => r.id)
      const pipeIds = ((pipesRes.data ?? []) as { id: string }[]).map((r) => r.id)

      // 2. 関連 attachments を 1 つの配列にまとめる
      const collectAttachments = async (entityType: string, entityIds: string[]) => {
        const result: { id: string; file_path: string }[] = []
        if (entityIds.length === 0) return result
        for (let i = 0; i < entityIds.length; i += 500) {
          const slice = entityIds.slice(i, i + 500)
          const { data, error } = await supabase
            .from('attachments')
            .select('id, file_path')
            .eq('entity_type', entityType)
            .in('entity_id', slice)
          if (error) throw error
          for (const a of (data ?? []) as { id: string; file_path: string }[]) {
            result.push(a)
          }
        }
        return result
      }
      const allAttachments = [
        ...(await collectAttachments('coordinate', coordIds)),
        ...(await collectAttachments('work_area', wareaIds)),
        ...(await collectAttachments('pipe', pipeIds)),
        ...(await collectAttachments('farm', [id])),
      ]

      // 3. attachments の Storage 実体を削除
      if (allAttachments.length > 0) {
        onProgress?.('写真ファイルを削除中', 0, allAttachments.length)
        const paths = allAttachments.map((a) => a.file_path)
        const CHUNK = 100
        for (let i = 0; i < paths.length; i += CHUNK) {
          const slice = paths.slice(i, i + CHUNK)
          // 失敗してもメタは消す（孤児ファイル < 孤児メタ）
          await supabase.storage.from('attachments').remove(slice)
          onProgress?.('写真ファイルを削除中', Math.min(i + CHUNK, paths.length), paths.length)
        }

        // 4. attachments の DB 行も削除
        onProgress?.('写真メタを削除中', 0, allAttachments.length)
        const attIds = allAttachments.map((a) => a.id)
        for (let i = 0; i < attIds.length; i += 500) {
          const slice = attIds.slice(i, i + 500)
          const { error: delErr } = await supabase
            .from('attachments')
            .delete()
            .in('id', slice)
          if (delErr) throw delErr
          onProgress?.('写真メタを削除中', Math.min(i + 500, attIds.length), attIds.length)
        }
      }

      // 5. LandXML の Storage 実体を削除（DB 行は farms 削除時の CASCADE で消える）
      const { data: lxRows } = await supabase
        .from('landxml_files')
        .select('storage_path')
        .eq('farm_id', id)
      const lxPaths = ((lxRows ?? []) as { storage_path: string }[]).map((r) => r.storage_path)
      if (lxPaths.length > 0) {
        onProgress?.('LandXML ファイルを削除中', 0, lxPaths.length)
        for (let i = 0; i < lxPaths.length; i += 100) {
          const slice = lxPaths.slice(i, i + 100)
          await supabase.storage.from('landxml').remove(slice)
          onProgress?.('LandXML ファイルを削除中', Math.min(i + 100, lxPaths.length), lxPaths.length)
        }
      }

      // 6. オルソタイルの Storage 実体（DB 行は CASCADE）
      const { data: orthoRows } = await supabase
        .from('orthophoto_tilesets')
        .select('storage_path')
        .eq('farm_id', id)
      const orthoPrefixes = ((orthoRows ?? []) as { storage_path: string }[]).map(
        (r) => r.storage_path,
      )
      if (orthoPrefixes.length > 0) {
        onProgress?.('オルソ画像タイルを削除中', 0, orthoPrefixes.length)
        // 各タイルセット配下を再帰列挙して remove
        const listAllFiles = async (prefix: string): Promise<string[]> => {
          const all: string[] = []
          const walk = async (current: string) => {
            let offset = 0
            const LIMIT = 100
            // eslint-disable-next-line no-constant-condition
            while (true) {
              const { data, error } = await supabase.storage
                .from('orthophoto-tiles')
                .list(current, { limit: LIMIT, offset })
              if (error) throw error
              if (!data || data.length === 0) break
              for (const item of data) {
                if (!item.name) continue
                const full = current ? `${current}/${item.name}` : item.name
                if (item.id === null) {
                  // フォルダ: 再帰
                  await walk(full)
                } else {
                  all.push(full)
                }
              }
              if (data.length < LIMIT) break
              offset += data.length
            }
          }
          await walk(prefix)
          return all
        }
        for (let i = 0; i < orthoPrefixes.length; i++) {
          const prefix = orthoPrefixes[i]
          const files = await listAllFiles(prefix)
          for (let j = 0; j < files.length; j += 100) {
            const slice = files.slice(j, j + 100)
            await supabase.storage.from('orthophoto-tiles').remove(slice)
          }
          onProgress?.('オルソ画像タイルを削除中', i + 1, orthoPrefixes.length)
        }
      }

      // 7. 最後に工区を削除（残りの DB 関連行は CASCADE で消える）
      onProgress?.('工区を削除中')
      const { error: delFarmErr } = await supabase.from('farms').delete().eq('id', id)
      if (delFarmErr) throw delFarmErr

      set((state) => ({
        farms: state.farms.filter((f) => f.id !== id),
        currentFarm: state.currentFarm?.id === id ? null : state.currentFarm,
        loading: false,
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '工区の削除に失敗しました', loading: false })
      throw err
    }
  },
    }),
    {
      name: 'nodecloud-current-farm',
      // 選択中の工区だけ永続化（一覧・位置情報・ポリゴンは毎回取り直す）
      partialize: (state) => ({ currentFarm: state.currentFarm }),
    },
  ),
)
