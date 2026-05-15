// スマホ用: 測点一覧画面
// 起工測量ページの「ターゲット一覧」を独立画面化したもの。
// 測設済マーク（記録なし）の切替もこちらから可能。
//
// URL: /mobile/points?farmId=:id

import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Check, Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useFarmStore, type Farm } from '@/stores/farmStore'
import { useCoordinateStore, type CoordinateRow } from '@/stores/coordinateStore'
import { useUnderdrainStore, type PipeRow, PIPE_TYPE_NAMES } from '@/stores/underdrainStore'
import { useStakingStore } from '@/stores/stakingStore'
import {
  useCoordinatePointTypeStore,
  getCoordinateTypeLabel,
} from '@/stores/coordinatePointTypeStore'
import { CoordinateConverter } from '@/lib/coordinates'
import type { Project } from '@/types/database'

interface PointItem {
  id: string
  kind: 'coordinate' | 'pipe_vertex'
  refId: string
  vertexIndex: number | null
  name: string
  x: number
  y: number
  z: number | null
  subType: string
  subTypeLabel: string
}

const STAKE_TOLERANCE_M = 0.2

export function MobilePointListPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const farmId = params.get('farmId')

  const { setCurrentFarm } = useFarmStore()
  const {
    byProject: pointTypesByProject,
    fetchForProject: fetchPointTypes,
  } = useCoordinatePointTypeStore()
  const { setZone, fetchCoordinates, coordinates } = useCoordinateStore()
  const { fetchPipes, pipes } = useUnderdrainStore()
  const { records, fetchRecords, addRecord, deleteRecord, saving } = useStakingStore()

  const [farm, setFarm] = useState<Farm | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hiddenSubTypes, setHiddenSubTypes] = useState<Set<string>>(new Set())
  const [kindFilter, setKindFilter] = useState<'all' | 'coordinate' | 'pipe_vertex'>('all')

  const projectId = farm?.project_id ?? null
  useEffect(() => {
    if (projectId) fetchPointTypes(projectId)
  }, [projectId, fetchPointTypes])

  useEffect(() => {
    if (!farmId) {
      setError('URL に farmId が指定されていません')
      setLoading(false)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const { data: farmData, error: farmErr } = await supabase
          .from('farms')
          .select('*')
          .eq('id', farmId)
          .single()
        if (farmErr) throw farmErr
        if (cancelled) return
        const typedFarm = farmData as Farm
        setFarm(typedFarm)
        setCurrentFarm(typedFarm)
        if (typedFarm.project_id) {
          const { data: projData } = await supabase
            .from('projects')
            .select('*')
            .eq('id', typedFarm.project_id)
            .single()
          if (!cancelled && projData) {
            const typedProj = projData as Project
            setProject(typedProj)
            setZone(typedProj.coordinate_zone)
          }
        }
        await Promise.all([
          fetchCoordinates(farmId),
          fetchPipes(farmId),
          fetchRecords(farmId),
        ])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '読み込み失敗')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [farmId, setCurrentFarm, setZone, fetchCoordinates, fetchPipes, fetchRecords])

  const converter = useMemo(() => {
    if (!project) return null
    return new CoordinateConverter(project.coordinate_zone)
  }, [project])

  const points = useMemo<PointItem[]>(() => {
    const out: PointItem[] = []
    for (const c of coordinates as CoordinateRow[]) {
      const sub = (c.type ?? 'other') as string
      out.push({
        id: `c-${c.id}`,
        kind: 'coordinate',
        refId: c.id,
        vertexIndex: null,
        name: c.pointNumber,
        x: c.x,
        y: c.y,
        z: c.z,
        subType: sub,
        subTypeLabel: getCoordinateTypeLabel(sub, projectId, pointTypesByProject),
      })
    }
    for (const pipe of pipes as PipeRow[]) {
      const pType = pipe.pipeType ?? 'unknown'
      const pLabel = pipe.pipeType ? PIPE_TYPE_NAMES[pipe.pipeType] : '管種未設定'
      for (let i = 0; i < pipe.vertices.length; i++) {
        const v = pipe.vertices[i]
        const total = pipe.vertices.length
        let suffix: string
        if (i === 0) suffix = 'C'
        else if (i === total - 1) suffix = 'A'
        else suffix = `B${total - 1 - i}`
        out.push({
          id: `v-${pipe.id}-${i}`,
          kind: 'pipe_vertex',
          refId: pipe.id,
          vertexIndex: i,
          name: `${pipe.number}${suffix}`,
          x: v.x,
          y: v.y,
          z: v.z,
          subType: pType,
          subTypeLabel: pLabel,
        })
      }
    }
    return out
  }, [coordinates, pipes, projectId, pointTypesByProject])

  const stakedIds = useMemo(() => {
    const set = new Set<string>()
    for (const t of points) {
      const hit = records.some((r) => {
        if (r.targetType === 'free') return false
        if (r.targetType !== t.kind) return false
        if (r.targetRefId !== t.refId) return false
        if (t.kind === 'pipe_vertex' && r.targetVertexIndex !== t.vertexIndex) return false
        if (r.targetX == null || r.targetY == null) return false
        const dx = r.measuredX - r.targetX
        const dy = r.measuredY - r.targetY
        return Math.hypot(dx, dy) <= STAKE_TOLERANCE_M
      })
      if (hit) set.add(t.id)
    }
    return set
  }, [points, records])

  const filtered = useMemo(() => {
    let base = points
    if (kindFilter !== 'all') base = base.filter((p) => p.kind === kindFilter)
    if (hiddenSubTypes.size > 0) base = base.filter((p) => !hiddenSubTypes.has(p.subType))
    return base
  }, [points, kindFilter, hiddenSubTypes])

  const subTypeStats = useMemo(() => {
    const base = kindFilter === 'all' ? points : points.filter((p) => p.kind === kindFilter)
    const map = new Map<string, { label: string; count: number; kind: 'coordinate' | 'pipe_vertex' }>()
    for (const p of base) {
      const cur = map.get(p.subType)
      if (cur) cur.count++
      else map.set(p.subType, { label: p.subTypeLabel, count: 1, kind: p.kind })
    }
    return Array.from(map.entries()).map(([code, v]) => ({ code, ...v }))
  }, [points, kindFilter])

  const handleToggleStaked = async (p: PointItem) => {
    if (!farmId) return
    const existing = records.find(
      (r) =>
        r.notes === 'manual_mark' &&
        r.farmId === farmId &&
        r.targetType === p.kind &&
        r.targetRefId === p.refId &&
        r.targetVertexIndex === p.vertexIndex,
    )
    if (existing) {
      if (!confirm(`${p.name} の測設済マークを解除しますか？`)) return
      await deleteRecord(existing.id)
      return
    }
    if (stakedIds.has(p.id)) {
      alert(`${p.name} は既に測設済みです。`)
      return
    }
    if (!confirm(`${p.name} を測設済としてマークしますか？`)) return
    await addRecord({
      farmId,
      surveyCategory: 'initial',
      targetType: p.kind,
      targetRefId: p.refId,
      targetVertexIndex: p.vertexIndex,
      targetName: `G${p.name}`,
      targetX: p.x,
      targetY: p.y,
      targetZ: p.z,
      measuredX: p.x,
      measuredY: p.y,
      measuredZ: p.z,
      accuracy: null,
      sampleCount: 0,
      durationSeconds: null,
      notes: 'manual_mark',
    })
  }

  const handleOpenStaking = (p: PointItem) => {
    // この点をターゲットにして起工測量画面を開く
    navigate(`/mobile/staking?farmId=${farmId}&target=${encodeURIComponent(p.id)}`)
  }

  if (loading) {
    return (
      <div className="mobile-min-screen flex items-center justify-center bg-slate-100">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (error || !farm) {
    return (
      <div className="mobile-min-screen flex flex-col bg-slate-100">
        <div className="px-3 py-2 bg-slate-800 text-white text-sm flex items-center">
          <button onClick={() => navigate(-1)} className="flex items-center gap-1">
            <ArrowLeft className="h-4 w-4" />
            戻る
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="p-4 bg-white rounded shadow text-red-600 text-sm">
            {error ?? '圃場が見つかりませんでした'}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mobile-screen flex flex-col bg-slate-100">
      {/* ヘッダ */}
      <div className="px-3 py-2 bg-slate-800 text-white text-sm flex items-center gap-2">
        <button onClick={() => navigate(-1)} className="p-1 hover:bg-slate-700 rounded">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="font-medium truncate flex-1">
          測点一覧 — {farm.name}
        </span>
        <span className="text-[11px] text-emerald-300 font-medium">
          測設済 {filtered.filter((p) => stakedIds.has(p.id)).length}/{filtered.length}
        </span>
      </div>

      {/* 種別フィルタ */}
      <div className="px-3 py-1.5 bg-white border-b flex items-center gap-1 text-xs">
        <button
          onClick={() => setKindFilter('all')}
          className={`px-2 py-0.5 rounded border ${
            kindFilter === 'all' ? 'bg-slate-800 text-white border-slate-800' : ''
          }`}
        >
          全て
        </button>
        <button
          onClick={() => setKindFilter('coordinate')}
          className={`px-2 py-0.5 rounded border ${
            kindFilter === 'coordinate' ? 'bg-blue-600 text-white border-blue-600' : ''
          }`}
        >
          座標
        </button>
        <button
          onClick={() => setKindFilter('pipe_vertex')}
          className={`px-2 py-0.5 rounded border ${
            kindFilter === 'pipe_vertex' ? 'bg-emerald-600 text-white border-emerald-600' : ''
          }`}
        >
          暗渠頂点
        </button>
      </div>

      {/* 点種チップ */}
      {subTypeStats.length > 1 && (
        <div className="px-3 py-1.5 bg-slate-50 border-b flex items-center gap-1 flex-wrap text-[11px]">
          <span className="text-slate-500 mr-1">点種:</span>
          {subTypeStats.map((s) => {
            const hidden = hiddenSubTypes.has(s.code)
            const onCls =
              s.kind === 'coordinate'
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-emerald-600 text-white border-emerald-600'
            const offCls = 'bg-white text-slate-400 border-slate-300 line-through'
            return (
              <button
                key={s.code}
                onClick={() =>
                  setHiddenSubTypes((prev) => {
                    const next = new Set(prev)
                    if (next.has(s.code)) next.delete(s.code)
                    else next.add(s.code)
                    return next
                  })
                }
                className={`px-1.5 py-0.5 rounded border font-medium ${hidden ? offCls : onCls}`}
              >
                {s.label}
                <span className="ml-1 text-[10px] opacity-80">({s.count})</span>
              </button>
            )
          })}
        </div>
      )}

      {/* 一覧 */}
      <div className="flex-1 overflow-auto bg-white">
        {filtered.length === 0 ? (
          <div className="p-4 text-center text-xs text-slate-400">該当なし</div>
        ) : (
          <ul className="divide-y text-sm">
            {filtered.map((p) => {
              const isStaked = stakedIds.has(p.id)
              return (
                <li
                  key={p.id}
                  className={`flex items-center gap-2 px-3 py-2 ${
                    isStaked ? 'bg-emerald-50/60' : ''
                  }`}
                >
                  <button
                    onClick={() => handleToggleStaked(p)}
                    disabled={saving}
                    className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
                      isStaked
                        ? 'bg-emerald-600 text-white'
                        : 'border border-slate-300 hover:bg-slate-100'
                    }`}
                    title={isStaked ? '測設済マークを解除' : '測設済としてマーク'}
                  >
                    {isStaked && <Check className="h-4 w-4" />}
                  </button>
                  <button
                    onClick={() => handleOpenStaking(p)}
                    className="flex-1 min-w-0 text-left flex items-center gap-2"
                  >
                    <span
                      className={`flex-1 font-medium truncate ${
                        isStaked ? 'text-emerald-700 line-through decoration-emerald-400' : ''
                      }`}
                    >
                      {p.name}
                    </span>
                    <span className="text-[11px] text-slate-500 truncate max-w-[5rem]">
                      {p.subTypeLabel}
                    </span>
                    <span className="text-[10px] font-mono text-slate-500 w-20 text-right">
                      <div>X: {p.x.toFixed(2)}</div>
                      <div>Y: {p.y.toFixed(2)}</div>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* フッタ */}
      <div className="px-3 py-2 bg-slate-50 border-t text-[11px] text-slate-500">
        タップで起工測量画面を開く / 左の○をタップで測設済マークを切り替え
        {converter ? null : '（座標変換不可）'}
      </div>
    </div>
  )
}
