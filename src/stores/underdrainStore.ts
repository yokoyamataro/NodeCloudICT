import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { PipeType, PipeVertex } from '@/types/database'

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

interface UnderdrainState {
  // 管路データ
  pipes: PipeRow[]
  addPipe: (pipe: Omit<PipeRow, 'id'>) => string
  addPipes: (pipes: Omit<PipeRow, 'id'>[]) => void
  updatePipe: (id: string, updates: Partial<PipeRow>) => void
  deletePipe: (id: string) => void
  clearPipes: () => void
  getPipeById: (id: string) => PipeRow | undefined
  reversePipeDirection: (id: string) => void // 上流/下流反転
  mergePipes: (ids: string[]) => string | null // 管路の結合（返り値は新しい管路ID）
  splitPipe: (id: string, vertexIndex: number) => [string, string] | null // 管路の分割
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
}

export const useUnderdrainStore = create<UnderdrainState>()(
  persist(
    (set, get) => ({
      // 管路データ
      pipes: [],

      addPipe: (pipe) => {
        const id = crypto.randomUUID()
        set((state) => ({
          pipes: [...state.pipes, { ...pipe, id }],
        }))
        return id
      },

      addPipes: (pipes) => {
        const newPipes = pipes.map((pipe) => ({
          ...pipe,
          id: crypto.randomUUID(),
        }))
        set((state) => ({
          pipes: [...state.pipes, ...newPipes],
        }))
      },

      updatePipe: (id, updates) => {
        set((state) => ({
          pipes: state.pipes.map((pipe) =>
            pipe.id === id ? { ...pipe, ...updates } : pipe
          ),
        }))
      },

      deletePipe: (id) => {
        set((state) => ({
          pipes: state.pipes.filter((p) => p.id !== id),
          selectedPipeId: state.selectedPipeId === id ? null : state.selectedPipeId,
        }))
      },

      clearPipes: () => {
        set({ pipes: [], selectedPipeId: null })
      },

      getPipeById: (id) => {
        return get().pipes.find((p) => p.id === id)
      },

      reversePipeDirection: (id) => {
        set((state) => ({
          pipes: state.pipes.map((pipe) =>
            pipe.id === id
              ? { ...pipe, vertices: [...pipe.vertices].reverse() }
              : pipe
          ),
        }))
      },

      mergePipes: (ids) => {
        const state = get()
        if (ids.length < 2) return null

        const pipesToMerge = ids.map(id => state.pipes.find(p => p.id === id)).filter((p): p is PipeRow => p !== undefined)
        if (pipesToMerge.length < 2) return null

        const threshold = 0.1 // 10cm

        // 距離計算ヘルパー
        const dist = (p1: PipeVertex, p2: PipeVertex) =>
          Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2))

        // 隣接する管路を順番に結合
        // 双方向に探索できるようにする
        const orderedPipes: PipeRow[] = [pipesToMerge[0]]
        const remaining = pipesToMerge.slice(1)

        // 繰り返し探索（前後両方向に拡張）
        let changed = true
        while (changed && remaining.length > 0) {
          changed = false

          // 現在の列の先頭と末尾の端点を取得
          const firstPipe = orderedPipes[0]
          const lastPipe = orderedPipes[orderedPipes.length - 1]
          const firstStart = firstPipe.vertices[0]
          const lastEnd = lastPipe.vertices[lastPipe.vertices.length - 1]

          for (let i = 0; i < remaining.length; i++) {
            const candidate = remaining[i]
            const candidateStart = candidate.vertices[0]
            const candidateEnd = candidate.vertices[candidate.vertices.length - 1]

            // 末尾の終点に接続できるか
            if (dist(lastEnd, candidateStart) <= threshold) {
              // 末尾に追加（そのまま）
              orderedPipes.push(candidate)
              remaining.splice(i, 1)
              changed = true
              break
            } else if (dist(lastEnd, candidateEnd) <= threshold) {
              // 末尾に追加（反転）
              orderedPipes.push({ ...candidate, vertices: [...candidate.vertices].reverse() })
              remaining.splice(i, 1)
              changed = true
              break
            }

            // 先頭の始点に接続できるか
            if (dist(firstStart, candidateEnd) <= threshold) {
              // 先頭に追加（そのまま）
              orderedPipes.unshift(candidate)
              remaining.splice(i, 1)
              changed = true
              break
            } else if (dist(firstStart, candidateStart) <= threshold) {
              // 先頭に追加（反転）
              orderedPipes.unshift({ ...candidate, vertices: [...candidate.vertices].reverse() })
              remaining.splice(i, 1)
              changed = true
              break
            }
          }
        }

        // すべての管路が接続できなかった場合
        if (remaining.length > 0) {
          return null
        }

        // 頂点を結合（重複する端点を除去）
        const mergedVertices: PipeVertex[] = [...orderedPipes[0].vertices]
        for (let i = 1; i < orderedPipes.length; i++) {
          // 最初の頂点は前の管路の終点と同じなのでスキップ
          mergedVertices.push(...orderedPipes[i].vertices.slice(1))
        }

        // 延長を再計算
        let totalLength = 0
        for (let i = 0; i < mergedVertices.length - 1; i++) {
          const dx = mergedVertices[i + 1].x - mergedVertices[i].x
          const dy = mergedVertices[i + 1].y - mergedVertices[i].y
          totalLength += Math.sqrt(dx * dx + dy * dy)
        }

        // 新しい管路を作成（最初の管路の属性を継承）
        const firstPipe = orderedPipes[0]
        const newId = crypto.randomUUID()
        const newPipe: PipeRow = {
          id: newId,
          number: firstPipe.number,
          layerName: firstPipe.layerName,
          pipeType: firstPipe.pipeType,
          diameter: firstPipe.diameter,
          designLength: firstPipe.designLength,
          measuredLength: totalLength,
          vertices: mergedVertices,
          connectionTo: firstPipe.connectionTo,
          notes: firstPipe.notes,
        }

        // 古い管路を削除し、新しい管路を追加
        // 他の管路の接続先も更新（結合された管路に接続していた場合、新しい管路に変更）
        set((state) => ({
          pipes: [
            ...state.pipes
              .filter(p => !ids.includes(p.id))
              .map(p => {
                // 結合された管路のいずれかに接続していた場合、新しい管路IDに更新
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

        return newId
      },

      splitPipe: (id, vertexIndex) => {
        const state = get()
        const pipe = state.pipes.find(p => p.id === id)
        if (!pipe) return null
        if (vertexIndex <= 0 || vertexIndex >= pipe.vertices.length - 1) return null

        // 前半の頂点（0 ~ vertexIndex）
        const firstVertices = pipe.vertices.slice(0, vertexIndex + 1)
        // 後半の頂点（vertexIndex ~ 最後）
        const secondVertices = pipe.vertices.slice(vertexIndex)

        // 延長を再計算
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
          connectionTo: id2, // 後半に接続
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

        // 他の管路の接続先も更新（分割された管路に接続していた場合、上流側の管路に変更）
        // 分割前の管路に接続 → 分割後の上流側（pipe1）に接続
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

        return [id1, id2]
      },

      autoInsertMidpoints: (maxSegmentLength, pipeTypes) => {
        const state = get()
        let totalInserted = 0

        // 対象の管路を取得（指定された管種のみ）
        const targetPipes = state.pipes.filter(p =>
          p.pipeType !== null && pipeTypes.includes(p.pipeType)
        )

        const updatedPipes = state.pipes.map(pipe => {
          // 対象外の管路はそのまま
          if (!targetPipes.find(p => p.id === pipe.id)) {
            return pipe
          }

          const vertices = pipe.vertices
          if (vertices.length < 2) return pipe

          // 新しい頂点リストを構築
          const newVertices: PipeVertex[] = []

          for (let i = 0; i < vertices.length - 1; i++) {
            const v1 = vertices[i]
            const v2 = vertices[i + 1]

            // 区間距離を計算
            const dx = v2.x - v1.x
            const dy = v2.y - v1.y
            const segmentLength = Math.sqrt(dx * dx + dy * dy)

            newVertices.push(v1)

            // 区間が最大長を超える場合、中間点を追加
            if (segmentLength > maxSegmentLength) {
              // 必要な分割数を計算（全ての区間が maxSegmentLength 以下になるように）
              const divisions = Math.ceil(segmentLength / maxSegmentLength)

              // 中間点を追加
              for (let j = 1; j < divisions; j++) {
                const t = j / divisions
                const midX = v1.x + dx * t
                const midY = v1.y + dy * t
                // Z座標は線形補間（両方nullならnull）
                const midZ = (v1.z !== null && v2.z !== null)
                  ? v1.z + (v2.z - v1.z) * t
                  : null

                newVertices.push({ x: midX, y: midY, z: midZ })
                totalInserted++
              }
            }
          }

          // 最後の頂点を追加
          newVertices.push(vertices[vertices.length - 1])

          // 頂点が変更されていなければそのまま返す
          if (newVertices.length === vertices.length) {
            return pipe
          }

          return { ...pipe, vertices: newVertices }
        })

        // 変更があった場合のみ更新
        if (totalInserted > 0) {
          set({ pipes: updatedPipes })
        }

        return totalInserted
      },

      previewMidpoints: (maxSegmentLength, pipeTypes) => {
        const state = get()
        const previewPoints: PipeVertex[] = []

        // 対象の管路を取得（指定された管種のみ）
        const targetPipes = state.pipes.filter(p =>
          p.pipeType !== null && pipeTypes.includes(p.pipeType)
        )

        for (const pipe of targetPipes) {
          const vertices = pipe.vertices
          if (vertices.length < 2) continue

          for (let i = 0; i < vertices.length - 1; i++) {
            const v1 = vertices[i]
            const v2 = vertices[i + 1]

            // 区間距離を計算
            const dx = v2.x - v1.x
            const dy = v2.y - v1.y
            const segmentLength = Math.sqrt(dx * dx + dy * dy)

            // 区間が最大長を超える場合、中間点を計算
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
    }),
    {
      name: 'underdrain-storage',
      partialize: (state) => ({
        pipes: state.pipes,
        lastImportFile: state.lastImportFile,
      }),
    }
  )
)
