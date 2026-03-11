/**
 * DXFファイルパーサー
 * LINE と POLYLINE エンティティを解析し、管路データとして抽出
 *
 * 注意: 日本の測量座標系では、DXFのX/Y座標と平面直角座標系のX/Yが逆になる
 * - DXFのX（コード10）→ 平面直角座標のY（東方向）
 * - DXFのY（コード20）→ 平面直角座標のX（北方向）
 */

import type { PipeVertex } from '@/types/database'

// DXFから抽出した線形データ
export interface DxfEntity {
  type: 'LINE' | 'POLYLINE'
  layer: string
  vertices: PipeVertex[]
}

// パース結果
export interface DxfParseResult {
  entities: DxfEntity[]
  layers: string[]
  bounds: {
    minX: number
    maxX: number
    minY: number
    maxY: number
  }
}

/**
 * DXFファイルをパースして線形データを抽出
 */
export function parseDxf(content: string): DxfParseResult {
  const lines = content.split('\n').map(line => line.trim())
  const entities: DxfEntity[] = []
  const layerSet = new Set<string>()

  let i = 0

  // ENTITIESセクションを探す
  while (i < lines.length) {
    if (lines[i] === 'ENTITIES') {
      i++
      break
    }
    i++
  }

  // エンティティを解析
  while (i < lines.length) {
    const line = lines[i]

    if (line === 'ENDSEC' || line === 'EOF') {
      break
    }

    if (line === 'LINE') {
      const result = parseLine(lines, i)
      if (result) {
        entities.push(result.entity)
        layerSet.add(result.entity.layer)
        i = result.nextIndex
      } else {
        i++
      }
    } else if (line === 'POLYLINE') {
      const result = parsePolyline(lines, i)
      if (result) {
        entities.push(result.entity)
        layerSet.add(result.entity.layer)
        i = result.nextIndex
      } else {
        i++
      }
    } else {
      i++
    }
  }

  // 境界を計算
  const bounds = calculateBounds(entities)

  return {
    entities,
    layers: Array.from(layerSet).sort(),
    bounds,
  }
}

/**
 * LINEエンティティをパース
 */
function parseLine(
  lines: string[],
  startIndex: number
): { entity: DxfEntity; nextIndex: number } | null {
  let i = startIndex + 1
  let layer = '0'
  let x1 = 0, y1 = 0, z1: number | null = null
  let x2 = 0, y2 = 0, z2: number | null = null

  while (i < lines.length) {
    const code = lines[i]
    const value = lines[i + 1]

    if (code === '0') {
      // 次のエンティティに到達
      break
    }

    switch (code) {
      case '8': // レイヤ名
        layer = value
        break
      case '10': // 始点X
        x1 = parseFloat(value)
        break
      case '20': // 始点Y
        y1 = parseFloat(value)
        break
      case '30': // 始点Z
        z1 = parseFloat(value.replace('"', ''))
        break
      case '11': // 終点X
        x2 = parseFloat(value)
        break
      case '21': // 終点Y
        y2 = parseFloat(value)
        break
      case '31': // 終点Z
        z2 = parseFloat(value.replace('"', ''))
        break
    }

    i += 2
  }

  // 日本測量座標系: DXFのX→平面直角Y、DXFのY→平面直角X
  return {
    entity: {
      type: 'LINE',
      layer,
      vertices: [
        { x: y1, y: x1, z: z1 },
        { x: y2, y: x2, z: z2 },
      ],
    },
    nextIndex: i,
  }
}

/**
 * POLYLINEエンティティをパース
 */
function parsePolyline(
  lines: string[],
  startIndex: number
): { entity: DxfEntity; nextIndex: number } | null {
  let i = startIndex + 1
  let layer = '0'
  const vertices: PipeVertex[] = []

  // POLYLINEヘッダーを読む
  while (i < lines.length) {
    const code = lines[i]
    const value = lines[i + 1]

    if (code === '0') {
      break
    }

    if (code === '8') {
      layer = value
    }

    i += 2
  }

  // VERTEXを読む
  while (i < lines.length) {
    const entityType = lines[i]

    if (entityType === 'SEQEND') {
      i += 2 // SEQENDとその後の0をスキップ
      break
    }

    if (entityType === 'VERTEX') {
      i++
      let x = 0, y = 0, z: number | null = null

      while (i < lines.length) {
        const code = lines[i]
        const value = lines[i + 1]

        if (code === '0') {
          break
        }

        switch (code) {
          case '10':
            x = parseFloat(value)
            break
          case '20':
            y = parseFloat(value.trim())
            break
          case '30':
            z = parseFloat(value.replace('"', ''))
            break
        }

        i += 2
      }

      // 日本測量座標系: DXFのX→平面直角Y、DXFのY→平面直角X
      vertices.push({ x: y, y: x, z })
    } else {
      i++
    }
  }

  // 空のPOLYLINEはスキップ
  if (vertices.length === 0) {
    return null
  }

  return {
    entity: {
      type: 'POLYLINE',
      layer,
      vertices,
    },
    nextIndex: i,
  }
}

/**
 * エンティティの境界を計算
 */
function calculateBounds(entities: DxfEntity[]): DxfParseResult['bounds'] {
  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity

  for (const entity of entities) {
    for (const vertex of entity.vertices) {
      if (vertex.x < minX) minX = vertex.x
      if (vertex.x > maxX) maxX = vertex.x
      if (vertex.y < minY) minY = vertex.y
      if (vertex.y > maxY) maxY = vertex.y
    }
  }

  return { minX, maxX, minY, maxY }
}

/**
 * 線形の長さを計算
 */
export function calculateLineLength(vertices: PipeVertex[]): number {
  let length = 0
  for (let i = 0; i < vertices.length - 1; i++) {
    const v1 = vertices[i]
    const v2 = vertices[i + 1]
    const dx = v2.x - v1.x
    const dy = v2.y - v1.y
    const dz = (v2.z ?? 0) - (v1.z ?? 0)
    length += Math.sqrt(dx * dx + dy * dy + dz * dz)
  }
  return length
}

/**
 * DXFエンティティを管路データに変換
 */
export function entitiesToPipes(
  entities: DxfEntity[],
  projectId: string
): Array<{
  id: string
  project_id: string
  number: string
  layer_name: string
  pipe_type: null
  diameter: null
  design_length: number
  measured_length: null
  vertices: PipeVertex[]
  connection_to: null
  notes: null
}> {
  return entities.map((entity, index) => ({
    id: crypto.randomUUID(),
    project_id: projectId,
    number: `P${String(index + 1).padStart(3, '0')}`,
    layer_name: entity.layer,
    pipe_type: null,
    diameter: null,
    design_length: calculateLineLength(entity.vertices),
    measured_length: null,
    vertices: entity.vertices,
    connection_to: null,
    notes: null,
  }))
}
