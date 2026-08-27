import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import type { PipeType, PipeVertex, DesignPipe } from '@/types/database'
import { useFarmStore } from './farmStore'
import { useSettingsStore } from './settingsStore'

// ローカル状態用の管路型
export interface PipeRow {
  id: string
  number: string           // 管路番号
  layerName: string        // CADレイヤ名
  pipeType: PipeType | null  // 管種
  diameter: number | null    // 管径(mm)
  designLength: number | null   // 設計延長(m)
  measuredLength: number | null // 実測延長(m)
  vertices: PipeVertex[]   // 構成点リスト
  connectionTo: string | null   // 接続先（管路ID）
  notes: string | null
}

// 管種の表示名
export const PIPE_TYPE_NAMES: Record<PipeType, string> = {
  main: '集水',
  branch: '吸水',
  outlet: '落口',
  connection: '連絡渠',
  spring: '湧水処理',
  auxiliary: '補助暗渠',
  self_funded: '自費施工',
}

// 追加の管種（拡張）
export const EXTENDED_PIPE_TYPES = [
  { value: 'main', label: '集水' },
  { value: 'branch', label: '吸水' },
  { value: 'outlet', label: '落口' },
  { value: 'connection', label: '連絡渠' },
  { value: 'spring', label: '湧水処理' },
  { value: 'auxiliary', label: '補助暗渠' },
  { value: 'self_funded', label: '自費施工' },
] as const

// 拡張管種の型
export type ExtendedPipeType = typeof EXTENDED_PIPE_TYPES[number]['value']

// 管径の選択肢 (mm)
export const PIPE_DIAMETERS = [60, 80, 90, 100, 125, 150, 200, 250] as const

// 工区IDを取得するヘルパー
const getCurrentFarmId = (): string | null => {
  return useFarmStore.getState().currentFarm?.id ?? null
}

interface UnderdrainState {
  // 管路データ
  pipes: PipeRow[]
  /** 現在 pipes に 入っている データが 属する farm ID (圃場切替時の 残留 表示防止用) */
  loadedForFarmId: string | null
  loading: boolean
  error: string | null
  fetchPipes: (farmId: string) => Promise<void>
  addPipe: (pipe: Omit<PipeRow, 'id'>) => Promise<string | null>
  addPipes: (pipes: Omit<PipeRow, 'id'>[]) => Promise<void>
  updatePipe: (id: string, updates: Partial<PipeRow>) => Promise<void>
  deletePipe: (id: string) => Promise<void>
  clearPipes: () => Promise<void>
  getPipeById: (id: string) => PipeRow | undefined
  reversePipeDirection: (id: string) => void // 上流/下流反転
  mergePipes: (
    ids: string[],
    overrides?: Partial<Pick<PipeRow, 'number' | 'layerName' | 'pipeType' | 'diameter' | 'designLength' | 'connectionTo' | 'notes'>>
  ) => string | null // 管路の結合（overrides で属性の引き継ぎ元を明示指定できる）
  splitPipe: (id: string, vertexIndex: number) => [string, string] | null // 管路の分割
  splitPipeAtPoint: (id: string, point: { x: number; y: number }) => [string, string] | null // 任意の座標で管路を分割
  autoInsertMidpoints: (maxSegmentLength: number, pipeTypes: PipeType[]) => number // 自動中間点設置（返り値は追加された中間点数）
  previewMidpoints: (maxSegmentLength: number, pipeTypes: PipeType[]) => PipeVertex[] // 中間点のプレビュー（適用せずに計算のみ）

  // 選択状態
  selectedPipeId: string | null
  setSelectedPipeId: (id: string | null) => void

  // 複数選択状態
  selectedPipeIds: Set<string>
  togglePipeSelection: (id: string) => void
  clearPipeSelection: () => void
  addToPipeSelection: (id: string) => void

  // インポート履歴
  lastImportFile: string | null
  setLastImportFile: (filename: string | null) => void

  // 手動保存モード用
  pendingPipeChanges: Map<string, PipeRow>
  saveAllPipes: () => Promise<void>
  resetPipeChanges: () => void
}

export const useUnderdrainStore = create<UnderdrainState>()((set, get) => ({
  // 管路データ
  pipes: [],
  loadedForFarmId: null,
  loading: false,
  error: null,

  fetchPipes: async (farmId: string) => {
    // 圃場切替時 は 前圃場の pipes を 即クリア (残留 表示防止)
    const prev = get().loadedForFarmId
    if (prev !== farmId) {
      set({ pipes: [], loadedForFarmId: null, loading: true, error: null })
    } else {
      set({ loading: true, error: null })
    }
    try {
      const { data, error } = await supabase
        .from('design_pipes')
        .select('*')
        .eq('farm_id', farmId)
        .order('number')

      if (error) throw error

      const pipes: PipeRow[] = ((data || []) as DesignPipe[]).map((row) => ({
        id: row.id,
        number: row.number,
        layerName: row.layer_name || '',
        pipeType: row.pipe_type as PipeType | null,
        diameter: row.diameter,
        designLength: row.design_length,
        measuredLength: row.measured_length,
        vertices: row.vertices || [],
        connectionTo: row.connection_to,
        notes: row.notes,
      }))

      set({ pipes, loadedForFarmId: farmId, loading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '管路の取得に失敗しました', loading: false })
    }
  },

  addPipe: async (pipe) => {
    const farmId = getCurrentFarmId()
    if (!farmId) {
      set({ error: '工区が選択されていません' })
      return null
    }

    try {
      const { data, error } = await supabase
        .from('design_pipes')
        .insert({
          farm_id: farmId,
          number: pipe.number,
          layer_name: pipe.layerName,
          pipe_type: pipe.pipeType,
          diameter: pipe.diameter,
          design_length: pipe.designLength,
          measured_length: pipe.measuredLength,
          vertices: pipe.vertices,
          connection_to: pipe.connectionTo,
          notes: pipe.notes,
        } as never)
        .select()
        .single()

      if (error) throw error

      const row = data as DesignPipe
      const newPipe: PipeRow = {
        id: row.id,
        number: row.number,
        layerName: row.layer_name || '',
        pipeType: row.pipe_type as PipeType | null,
        diameter: row.diameter,
        designLength: row.design_length,
        measuredLength: row.measured_length,
        vertices: row.vertices || [],
        connectionTo: row.connection_to,
        notes: row.notes,
      }

      set((state) => ({ pipes: [...state.pipes, newPipe] }))
      return row.id
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '管路の追加に失敗しました' })
      return null
    }
  },

  addPipes: async (pipes) => {
    const farmId = getCurrentFarmId()
    if (!farmId) {
      set({ error: '工区が選択されていません' })
      return
    }

    try {
      const insertData = pipes.map((pipe) => ({
        farm_id: farmId,
        number: pipe.number,
        layer_name: pipe.layerName,
        pipe_type: pipe.pipeType,
        diameter: pipe.diameter,
        design_length: pipe.designLength,
        measured_length: pipe.measuredLength,
        vertices: pipe.vertices,
        connection_to: pipe.connectionTo,
        notes: pipe.notes,
      }))

      const { data, error } = await supabase
        .from('design_pipes')
        .insert(insertData as never)
        .select()

      if (error) throw error

      const newPipes: PipeRow[] = ((data || []) as DesignPipe[]).map((row) => ({
        id: row.id,
        number: row.number,
        layerName: row.layer_name || '',
        pipeType: row.pipe_type as PipeType | null,
        diameter: row.diameter,
        designLength: row.design_length,
        measuredLength: row.measured_length,
        vertices: row.vertices || [],
        connectionTo: row.connection_to,
        notes: row.notes,
      }))

      set((state) => ({ pipes: [...state.pipes, ...newPipes] }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '管路の追加に失敗しました' })
    }
  },

  updatePipe: async (id, updates) => {
    const state = get()
    const pipe = state.pipes.find((p) => p.id === id)
    if (!pipe) return

    const updated = { ...pipe, ...updates }

    // ローカル状態を即座に更新
    set({
      pipes: state.pipes.map((p) => (p.id === id ? updated : p)),
    })

    // 手動保存モードに統一: 変更を pendingPipeChanges に積み、保存ボタンを有効化
    const newPendingPipeChanges = new Map(state.pendingPipeChanges)
    newPendingPipeChanges.set(id, updated)
    set({ pendingPipeChanges: newPendingPipeChanges })
    useSettingsStore.getState().setHasUnsavedChanges(true)
  },

  deletePipe: async (id) => {
    try {
      const { error } = await supabase
        .from('design_pipes')
        .delete()
        .eq('id', id)

      if (error) throw error

      set((state) => ({
        pipes: state.pipes.filter((p) => p.id !== id),
        selectedPipeId: state.selectedPipeId === id ? null : state.selectedPipeId,
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '管路の削除に失敗しました' })
    }
  },

  clearPipes: async () => {
    const farmId = getCurrentFarmId()
    if (!farmId) return

    try {
      const { error } = await supabase
        .from('design_pipes')
        .delete()
        .eq('farm_id', farmId)

      if (error) throw error

      set({ pipes: [], selectedPipeId: null })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '管路の削除に失敗しました' })
    }
  },

  getPipeById: (id) => {
    return get().pipes.find((p) => p.id === id)
  },

  reversePipeDirection: (id) => {
    const state = get()
    const pipe = state.pipes.find(p => p.id === id)
    if (!pipe) return

    const reversedVertices = [...pipe.vertices].reverse()
    get().updatePipe(id, { vertices: reversedVertices })
  },

  mergePipes: (ids, overrides) => {
    const state = get()
    if (ids.length < 2) return null

    const pipesToMerge = ids.map(id => state.pipes.find(p => p.id === id)).filter((p): p is PipeRow => p !== undefined)
    if (pipesToMerge.length < 2) return null

    const threshold = 0.1 // 10cm

    // 距離計算ヘルパー
    const dist = (p1: PipeVertex, p2: PipeVertex) =>
      Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2))

    // 隣接する管路を順番に結合
    const orderedPipes: PipeRow[] = [pipesToMerge[0]]
    const remaining = pipesToMerge.slice(1)

    // 繰り返し探索（前後両方向に拡張）
    let changed = true
    while (changed && remaining.length > 0) {
      changed = false

      const firstPipe = orderedPipes[0]
      const lastPipe = orderedPipes[orderedPipes.length - 1]
      const firstStart = firstPipe.vertices[0]
      const lastEnd = lastPipe.vertices[lastPipe.vertices.length - 1]

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i]
        const candidateStart = candidate.vertices[0]
        const candidateEnd = candidate.vertices[candidate.vertices.length - 1]

        if (dist(lastEnd, candidateStart) <= threshold) {
          orderedPipes.push(candidate)
          remaining.splice(i, 1)
          changed = true
          break
        } else if (dist(lastEnd, candidateEnd) <= threshold) {
          orderedPipes.push({ ...candidate, vertices: [...candidate.vertices].reverse() })
          remaining.splice(i, 1)
          changed = true
          break
        }

        if (dist(firstStart, candidateEnd) <= threshold) {
          orderedPipes.unshift(candidate)
          remaining.splice(i, 1)
          changed = true
          break
        } else if (dist(firstStart, candidateStart) <= threshold) {
          orderedPipes.unshift({ ...candidate, vertices: [...candidate.vertices].reverse() })
          remaining.splice(i, 1)
          changed = true
          break
        }
      }
    }

    if (remaining.length > 0) {
      return null
    }

    // 頂点を結合
    const mergedVertices: PipeVertex[] = [...orderedPipes[0].vertices]
    for (let i = 1; i < orderedPipes.length; i++) {
      mergedVertices.push(...orderedPipes[i].vertices.slice(1))
    }

    // 延長を再計算
    let totalLength = 0
    for (let i = 0; i < mergedVertices.length - 1; i++) {
      const dx = mergedVertices[i + 1].x - mergedVertices[i].x
      const dy = mergedVertices[i + 1].y - mergedVertices[i].y
      totalLength += Math.sqrt(dx * dx + dy * dy)
    }

    const firstPipe = orderedPipes[0]
    const newId = crypto.randomUUID()
    // overrides が指定されていればそちらを優先。なければ従来通り先頭管路の属性を引き継ぐ。
    const pick = <K extends keyof PipeRow>(key: K): PipeRow[K] =>
      overrides && key in overrides && (overrides as Partial<PipeRow>)[key] !== undefined
        ? (overrides as Partial<PipeRow>)[key] as PipeRow[K]
        : firstPipe[key]
    const newPipe: PipeRow = {
      id: newId,
      number: pick('number'),
      layerName: pick('layerName'),
      pipeType: pick('pipeType'),
      diameter: pick('diameter'),
      designLength: pick('designLength'),
      measuredLength: totalLength,
      vertices: mergedVertices,
      connectionTo: pick('connectionTo'),
      notes: pick('notes'),
    }

    // 古い管路を削除し、新しい管路を追加
    set((state) => ({
      pipes: [
        ...state.pipes
          .filter(p => !ids.includes(p.id))
          .map(p => {
            if (p.connectionTo && ids.includes(p.connectionTo)) {
              return { ...p, connectionTo: newId }
            }
            return p
          }),
        newPipe,
      ],
      selectedPipeId: newId,
      selectedPipeIds: new Set(),
    }))

    // Supabaseに同期
    const farmId = getCurrentFarmId()
    if (farmId) {
      // 古い管路を削除し、新しい管路を挿入
      ;(async () => {
        try {
          // 古い管路を削除
          const { error: deleteError } = await supabase
            .from('design_pipes')
            .delete()
            .in('id', ids)

          if (deleteError) {
            console.error('管路削除エラー:', deleteError)
            set({ error: deleteError.message })
            return
          }

          // 新しい管路を挿入
          const { error: insertError } = await supabase
            .from('design_pipes')
            .insert({
              id: newId,
              farm_id: farmId,
              number: newPipe.number,
              layer_name: newPipe.layerName,
              pipe_type: newPipe.pipeType,
              diameter: newPipe.diameter,
              design_length: newPipe.designLength,
              measured_length: newPipe.measuredLength,
              vertices: newPipe.vertices,
              connection_to: newPipe.connectionTo,
              notes: newPipe.notes,
            } as never)

          if (insertError) {
            console.error('管路挿入エラー:', insertError)
            set({ error: insertError.message })
            return
          }

          // 接続先を更新した他の管路も同期
          const pipesToUpdate = state.pipes.filter(
            p => p.connectionTo && ids.includes(p.connectionTo) && !ids.includes(p.id)
          )
          for (const pipe of pipesToUpdate) {
            await supabase
              .from('design_pipes')
              .update({ connection_to: newId } as never)
              .eq('id', pipe.id)
          }
        } catch (err) {
          console.error('管路結合の同期エラー:', err)
          set({ error: err instanceof Error ? err.message : '管路結合の同期に失敗しました' })
        }
      })()
    }

    return newId
  },

  splitPipe: (id, vertexIndex) => {
    const state = get()
    const pipe = state.pipes.find(p => p.id === id)
    if (!pipe) return null
    if (vertexIndex <= 0 || vertexIndex >= pipe.vertices.length - 1) return null

    const firstVertices = pipe.vertices.slice(0, vertexIndex + 1)
    const secondVertices = pipe.vertices.slice(vertexIndex)

    const calcLength = (vertices: PipeVertex[]) => {
      let length = 0
      for (let i = 0; i < vertices.length - 1; i++) {
        const dx = vertices[i + 1].x - vertices[i].x
        const dy = vertices[i + 1].y - vertices[i].y
        length += Math.sqrt(dx * dx + dy * dy)
      }
      return length
    }

    const id1 = crypto.randomUUID()
    const id2 = crypto.randomUUID()

    const pipe1: PipeRow = {
      id: id1,
      number: `${pipe.number}-1`,
      layerName: pipe.layerName,
      pipeType: pipe.pipeType,
      diameter: pipe.diameter,
      designLength: null,
      measuredLength: calcLength(firstVertices),
      vertices: firstVertices,
      connectionTo: id2,
      notes: pipe.notes,
    }

    const pipe2: PipeRow = {
      id: id2,
      number: `${pipe.number}-2`,
      layerName: pipe.layerName,
      pipeType: pipe.pipeType,
      diameter: pipe.diameter,
      designLength: null,
      measuredLength: calcLength(secondVertices),
      vertices: secondVertices,
      connectionTo: pipe.connectionTo,
      notes: null,
    }

    // 接続先を更新する必要がある他の管路
    const pipesToUpdateConnection = state.pipes.filter(p => p.connectionTo === id && p.id !== id)

    set((state) => ({
      pipes: [
        ...state.pipes
          .filter(p => p.id !== id)
          .map(p => {
            if (p.connectionTo === id) {
              return { ...p, connectionTo: id1 }
            }
            return p
          }),
        pipe1,
        pipe2,
      ],
      selectedPipeId: id1,
      selectedPipeIds: new Set(),
    }))

    // Supabaseに同期
    const farmId = getCurrentFarmId()
    if (farmId) {
      ;(async () => {
        try {
          // 元の管路を削除
          const { error: deleteError } = await supabase
            .from('design_pipes')
            .delete()
            .eq('id', id)

          if (deleteError) {
            console.error('管路削除エラー:', deleteError)
            set({ error: deleteError.message })
            return
          }

          // 2つの新しい管路を挿入
          const { error: insertError } = await supabase
            .from('design_pipes')
            .insert([
              {
                id: id1,
                farm_id: farmId,
                number: pipe1.number,
                layer_name: pipe1.layerName,
                pipe_type: pipe1.pipeType,
                diameter: pipe1.diameter,
                design_length: pipe1.designLength,
                measured_length: pipe1.measuredLength,
                vertices: pipe1.vertices,
                connection_to: pipe1.connectionTo,
                notes: pipe1.notes,
              },
              {
                id: id2,
                farm_id: farmId,
                number: pipe2.number,
                layer_name: pipe2.layerName,
                pipe_type: pipe2.pipeType,
                diameter: pipe2.diameter,
                design_length: pipe2.designLength,
                measured_length: pipe2.measuredLength,
                vertices: pipe2.vertices,
                connection_to: pipe2.connectionTo,
                notes: pipe2.notes,
              },
            ] as never)

          if (insertError) {
            console.error('管路挿入エラー:', insertError)
            set({ error: insertError.message })
            return
          }

          // 接続先を更新した他の管路も同期
          for (const p of pipesToUpdateConnection) {
            await supabase
              .from('design_pipes')
              .update({ connection_to: id1 } as never)
              .eq('id', p.id)
          }
        } catch (err) {
          console.error('管路分割の同期エラー:', err)
          set({ error: err instanceof Error ? err.message : '管路分割の同期に失敗しました' })
        }
      })()
    }

    return [id1, id2]
  },

  splitPipeAtPoint: (id, point) => {
    const state = get()
    const pipe = state.pipes.find(p => p.id === id)
    if (!pipe || pipe.vertices.length < 2) return null

    const threshold = 0.5 // 50cm以内なら分割可能

    // 点がどのセグメント上にあるかを探す
    let bestSegmentIndex = -1
    let bestT = 0
    let bestDistance = Infinity

    for (let i = 0; i < pipe.vertices.length - 1; i++) {
      const v1 = pipe.vertices[i]
      const v2 = pipe.vertices[i + 1]

      const dx = v2.x - v1.x
      const dy = v2.y - v1.y
      const lengthSq = dx * dx + dy * dy

      if (lengthSq === 0) continue

      // 線分上の最近点のパラメータ t を計算
      let t = ((point.x - v1.x) * dx + (point.y - v1.y) * dy) / lengthSq
      t = Math.max(0, Math.min(1, t))

      // 最近点の座標
      const nearestX = v1.x + t * dx
      const nearestY = v1.y + t * dy

      // 距離を計算
      const dist = Math.sqrt(
        Math.pow(point.x - nearestX, 2) + Math.pow(point.y - nearestY, 2)
      )

      if (dist < bestDistance) {
        bestDistance = dist
        bestSegmentIndex = i
        bestT = t
      }
    }

    // 閾値内でなければ分割不可
    if (bestDistance > threshold || bestSegmentIndex < 0) {
      return null
    }

    // 分割点を計算
    const v1 = pipe.vertices[bestSegmentIndex]
    const v2 = pipe.vertices[bestSegmentIndex + 1]
    const splitPoint: PipeVertex = {
      x: v1.x + bestT * (v2.x - v1.x),
      y: v1.y + bestT * (v2.y - v1.y),
      z: (v1.z !== null && v2.z !== null)
        ? v1.z + bestT * (v2.z - v1.z)
        : v1.z ?? v2.z,
    }

    // 既存の頂点とほぼ同じ位置なら、その頂点で分割
    for (let i = 0; i < pipe.vertices.length; i++) {
      const v = pipe.vertices[i]
      const dist = Math.sqrt(Math.pow(v.x - splitPoint.x, 2) + Math.pow(v.y - splitPoint.y, 2))
      if (dist < 0.1) { // 10cm以内なら既存頂点
        // 端点なら分割不可
        if (i === 0 || i === pipe.vertices.length - 1) return null
        // 既存のsplitPipe関数で分割
        return get().splitPipe(id, i)
      }
    }

    // 新しい頂点を挿入して分割
    const firstVertices = [
      ...pipe.vertices.slice(0, bestSegmentIndex + 1),
      splitPoint,
    ]
    const secondVertices = [
      splitPoint,
      ...pipe.vertices.slice(bestSegmentIndex + 1),
    ]

    const calcLength = (vertices: PipeVertex[]) => {
      let length = 0
      for (let i = 0; i < vertices.length - 1; i++) {
        const dx = vertices[i + 1].x - vertices[i].x
        const dy = vertices[i + 1].y - vertices[i].y
        length += Math.sqrt(dx * dx + dy * dy)
      }
      return length
    }

    const id1 = crypto.randomUUID()
    const id2 = crypto.randomUUID()

    const pipe1: PipeRow = {
      id: id1,
      number: `${pipe.number}-1`,
      layerName: pipe.layerName,
      pipeType: pipe.pipeType,
      diameter: pipe.diameter,
      designLength: null,
      measuredLength: calcLength(firstVertices),
      vertices: firstVertices,
      connectionTo: id2,
      notes: pipe.notes,
    }

    const pipe2: PipeRow = {
      id: id2,
      number: `${pipe.number}-2`,
      layerName: pipe.layerName,
      pipeType: pipe.pipeType,
      diameter: pipe.diameter,
      designLength: null,
      measuredLength: calcLength(secondVertices),
      vertices: secondVertices,
      connectionTo: pipe.connectionTo,
      notes: null,
    }

    // 接続先を更新する必要がある他の管路
    const pipesToUpdateConnection = state.pipes.filter(p => p.connectionTo === id && p.id !== id)

    set((state) => ({
      pipes: [
        ...state.pipes
          .filter(p => p.id !== id)
          .map(p => {
            if (p.connectionTo === id) {
              return { ...p, connectionTo: id1 }
            }
            return p
          }),
        pipe1,
        pipe2,
      ],
      selectedPipeId: id1,
      selectedPipeIds: new Set(),
    }))

    // Supabaseに同期
    const farmId = getCurrentFarmId()
    if (farmId) {
      ;(async () => {
        try {
          // 元の管路を削除
          const { error: deleteError } = await supabase
            .from('design_pipes')
            .delete()
            .eq('id', id)

          if (deleteError) {
            console.error('管路削除エラー:', deleteError)
            set({ error: deleteError.message })
            return
          }

          // 2つの新しい管路を挿入
          const { error: insertError } = await supabase
            .from('design_pipes')
            .insert([
              {
                id: id1,
                farm_id: farmId,
                number: pipe1.number,
                layer_name: pipe1.layerName,
                pipe_type: pipe1.pipeType,
                diameter: pipe1.diameter,
                design_length: pipe1.designLength,
                measured_length: pipe1.measuredLength,
                vertices: pipe1.vertices,
                connection_to: pipe1.connectionTo,
                notes: pipe1.notes,
              },
              {
                id: id2,
                farm_id: farmId,
                number: pipe2.number,
                layer_name: pipe2.layerName,
                pipe_type: pipe2.pipeType,
                diameter: pipe2.diameter,
                design_length: pipe2.designLength,
                measured_length: pipe2.measuredLength,
                vertices: pipe2.vertices,
                connection_to: pipe2.connectionTo,
                notes: pipe2.notes,
              },
            ] as never)

          if (insertError) {
            console.error('管路挿入エラー:', insertError)
            set({ error: insertError.message })
            return
          }

          // 接続先を更新した他の管路も同期
          for (const p of pipesToUpdateConnection) {
            await supabase
              .from('design_pipes')
              .update({ connection_to: id1 } as never)
              .eq('id', p.id)
          }
        } catch (err) {
          console.error('管路分割の同期エラー:', err)
          set({ error: err instanceof Error ? err.message : '管路分割の同期に失敗しました' })
        }
      })()
    }

    return [id1, id2]
  },

  autoInsertMidpoints: (maxSegmentLength, pipeTypes) => {
    const state = get()
    let totalInserted = 0

    const targetPipes = state.pipes.filter(p =>
      p.pipeType !== null && pipeTypes.includes(p.pipeType)
    )

    const updatedPipes = state.pipes.map(pipe => {
      if (!targetPipes.find(p => p.id === pipe.id)) {
        return pipe
      }

      const vertices = pipe.vertices
      if (vertices.length < 2) return pipe

      const newVertices: PipeVertex[] = []

      for (let i = 0; i < vertices.length - 1; i++) {
        const v1 = vertices[i]
        const v2 = vertices[i + 1]

        const dx = v2.x - v1.x
        const dy = v2.y - v1.y
        const segmentLength = Math.sqrt(dx * dx + dy * dy)

        newVertices.push(v1)

        if (segmentLength > maxSegmentLength) {
          const divisions = Math.ceil(segmentLength / maxSegmentLength)

          for (let j = 1; j < divisions; j++) {
            const t = j / divisions
            const midX = v1.x + dx * t
            const midY = v1.y + dy * t
            const midZ = (v1.z !== null && v2.z !== null)
              ? v1.z + (v2.z - v1.z) * t
              : null

            newVertices.push({ x: midX, y: midY, z: midZ })
            totalInserted++
          }
        }
      }

      newVertices.push(vertices[vertices.length - 1])

      if (newVertices.length === vertices.length) {
        return pipe
      }

      return { ...pipe, vertices: newVertices }
    })

    if (totalInserted > 0) {
      set({ pipes: updatedPipes })

      // Supabaseに同期（頂点が更新された管路のみ）
      const pipesWithUpdatedVertices = updatedPipes.filter((pipe, index) => {
        const original = state.pipes[index]
        return original && pipe.vertices.length !== original.vertices.length
      })

      if (pipesWithUpdatedVertices.length > 0) {
        ;(async () => {
          try {
            for (const pipe of pipesWithUpdatedVertices) {
              const { error } = await supabase
                .from('design_pipes')
                .update({ vertices: pipe.vertices } as never)
                .eq('id', pipe.id)

              if (error) {
                console.error('管路更新エラー:', error)
                set({ error: error.message })
              }
            }
          } catch (err) {
            console.error('中間点挿入の同期エラー:', err)
            set({ error: err instanceof Error ? err.message : '中間点挿入の同期に失敗しました' })
          }
        })()
      }
    }

    return totalInserted
  },

  previewMidpoints: (maxSegmentLength, pipeTypes) => {
    const state = get()
    const previewPoints: PipeVertex[] = []

    const targetPipes = state.pipes.filter(p =>
      p.pipeType !== null && pipeTypes.includes(p.pipeType)
    )

    for (const pipe of targetPipes) {
      const vertices = pipe.vertices
      if (vertices.length < 2) continue

      for (let i = 0; i < vertices.length - 1; i++) {
        const v1 = vertices[i]
        const v2 = vertices[i + 1]

        const dx = v2.x - v1.x
        const dy = v2.y - v1.y
        const segmentLength = Math.sqrt(dx * dx + dy * dy)

        if (segmentLength > maxSegmentLength) {
          const divisions = Math.ceil(segmentLength / maxSegmentLength)

          for (let j = 1; j < divisions; j++) {
            const t = j / divisions
            const midX = v1.x + dx * t
            const midY = v1.y + dy * t
            const midZ = (v1.z !== null && v2.z !== null)
              ? v1.z + (v2.z - v1.z) * t
              : null

            previewPoints.push({ x: midX, y: midY, z: midZ })
          }
        }
      }
    }

    return previewPoints
  },

  // 選択状態
  selectedPipeId: null,
  setSelectedPipeId: (id) => set({ selectedPipeId: id }),

  // 複数選択状態
  selectedPipeIds: new Set<string>(),
  togglePipeSelection: (id) => {
    set((state) => {
      const newSet = new Set(state.selectedPipeIds)
      if (newSet.has(id)) {
        newSet.delete(id)
      } else {
        newSet.add(id)
      }
      return { selectedPipeIds: newSet }
    })
  },
  clearPipeSelection: () => set({ selectedPipeIds: new Set() }),
  addToPipeSelection: (id) => {
    set((state) => {
      const newSet = new Set(state.selectedPipeIds)
      newSet.add(id)
      return { selectedPipeIds: newSet }
    })
  },

  // インポート履歴
  lastImportFile: null,
  setLastImportFile: (filename) => set({ lastImportFile: filename }),

  // 手動保存モード用
  pendingPipeChanges: new Map(),

  saveAllPipes: async () => {
    const state = get()
    const farmId = getCurrentFarmId()
    if (!farmId) return

    // 圃場ガード: state.pipes が 現圃場向けで なければ pendingPipeChanges も 別圃場の
    // 管路を 更新しようとしている 可能性が 高い → 保存中止
    if (state.loadedForFarmId && state.loadedForFarmId !== farmId) {
      const msg =
        `管路の 保存を 中止: 表示中の 管路は 別圃場のもの です ` +
        `(表示 farm=${state.loadedForFarmId.slice(0, 8)}, 現圃場=${farmId.slice(0, 8)})。`
      console.warn('[underdrainStore] saveAllPipes aborted:', msg)
      set({ error: msg })
      return
    }

    try {
      for (const [id, pipe] of state.pendingPipeChanges) {
        const { error } = await supabase
          .from('design_pipes')
          .update({
            number: pipe.number,
            layer_name: pipe.layerName,
            pipe_type: pipe.pipeType,
            diameter: pipe.diameter,
            design_length: pipe.designLength,
            measured_length: pipe.measuredLength,
            vertices: pipe.vertices,
            connection_to: pipe.connectionTo,
            notes: pipe.notes,
          } as never)
          .eq('id', id)

        if (error) throw error
      }

      // 変更をクリア
      set({ pendingPipeChanges: new Map() })
      useSettingsStore.getState().setHasUnsavedChanges(false)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '保存に失敗しました' })
    }
  },

  resetPipeChanges: () => {
    const farmId = getCurrentFarmId()
    if (!farmId) return

    // Supabaseから再読み込み
    get().fetchPipes(farmId)

    // 変更をクリア
    set({ pendingPipeChanges: new Map() })
    useSettingsStore.getState().setHasUnsavedChanges(false)
  },
}))
