// analyze-underdrain-cad Edge Function を叩くためのクライアント。
// 事前パース (pipePreprocess + infoParse) の結果を渡して、AI が推定した
// 管径・長さを構造化 JSON で受け取る。

import { supabase } from '@/lib/supabase'
import type { PipeRun } from './pipePreprocess'
import type { InfoLabel } from './infoParse'
import type { DxfCircleEntity } from './parse'

export interface AiExtractedPipe {
  pipe_id: string
  diameter_mm: number | null
  length_m: number | null
  length_source: 'label' | 'computed'
  confidence: number
  warnings: string[]
}

export interface AiExtracted {
  pipes: AiExtractedPipe[]
  unmatched_pipe_ids: string[]
  unmatched_labels: Array<{ content: string; x: number; y: number }>
  confidence: number
  warnings: string[]
}

interface CallOpts {
  projectId: string
  farmId?: string | null
  pipeRuns: PipeRun[]
  labels: InfoLabel[]
  splitCircles: DxfCircleEntity[]
  /** 事前パースで管径確定済みの run の tentative_diameter_mm 対応 map */
  tentativeByRunId: Map<
    string,
    { diameterMm: number | null; lengthM: number | null; source: 'label' | 'computed' | null }
  >
  /** 任意: レンダリング済み PNG (base64、prefix なし) */
  imageBase64?: string | null
}

export async function analyzeUnderdrainCad(opts: CallOpts): Promise<AiExtracted> {
  const pipe_runs = opts.pipeRuns.map((r) => {
    const t = opts.tentativeByRunId.get(r.id)
    return {
      id: r.id,
      vertices: r.vertices.map((v) => ({ x: v.x, y: v.y })),
      length_mm: r.lengthMm,
      tentative_diameter_mm: t?.diameterMm ?? null,
      tentative_length_m: t?.lengthM ?? null,
      tentative_length_source: t?.source ?? null,
    }
  })
  const info_labels = opts.labels
    .filter((l) => l.kind !== 'noise')
    .map((l) => ({
      x: l.entity.x,
      y: l.entity.y,
      content: l.entity.content,
      diameter_mm: l.diameterMm,
      length_m: l.lengthM,
    }))
  const diameter_change_circles = opts.splitCircles.map((c) => ({
    cx: c.cx,
    cy: c.cy,
    radius: c.radius,
  }))

  const { data, error } = await supabase.functions.invoke<{
    ok: boolean
    extracted?: AiExtracted
    error?: string
  }>('analyze-underdrain-cad', {
    body: {
      project_id: opts.projectId,
      farm_id: opts.farmId ?? null,
      pipe_runs,
      info_labels,
      diameter_change_circles,
      image_base64: opts.imageBase64 ?? null,
    },
  })
  if (error) {
    let detail = error.message
    try {
      const ctx = (error as { context?: Response }).context
      if (ctx) {
        const body = await ctx.json()
        if (body?.error) detail = body.error
      }
    } catch {
      /* ignore */
    }
    throw new Error(`analyze_edge_function_error: ${detail}`)
  }
  if (!data?.ok || !data.extracted) {
    throw new Error(data?.error ?? 'analyze_no_extracted')
  }
  return data.extracted
}
