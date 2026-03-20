// 三角形分割ユーティリティ

import type { Point3D, Face, TINSurface } from './types'
import { distance2D, offsetLine, adjustOffsetLinesAtCorner, normalizedDirection, rotateLeft90 } from './geometry'

// 合流情報
export interface MergeConnection {
  absorptionPipeId: string
  collectorPipeId: string
  mergePoint: Point3D // 合流点（集水管中心線上）
  absorptionDirection: { dx: number; dy: number } // 吸水管の方向（終端に向かう）
  collectorDirection: { dx: number; dy: number } // 集水管の方向（下流に向かう）
  mergeFromLeft: boolean // 集水管の左側から合流するか
}

// 配管の線形から三角形メッシュを生成
export function generatePipeMesh(
  vertices: Point3D[],
  offsetDistance: number, // 片側のオフセット距離（例: 0.3m）
  idPrefix: string
): { points: Point3D[]; faces: Face[] } {
  if (vertices.length < 2) {
    return { points: [], faces: [] }
  }

  // 線形を左右にオフセット
  const offsetPoints = offsetLine(vertices, offsetDistance)

  // 折れ点でのオフセット線の交点を調整
  for (let i = 1; i < offsetPoints.length - 1; i++) {
    adjustOffsetLinesAtCorner(offsetPoints, i)
  }

  // 点を収集（IDを割り当て）
  const points: Point3D[] = []
  const leftIds: string[] = []
  const rightIds: string[] = []

  for (let i = 0; i < offsetPoints.length; i++) {
    const leftId = `${idPrefix}_L${i}`
    const rightId = `${idPrefix}_R${i}`

    points.push({
      id: leftId,
      x: offsetPoints[i].left.x,
      y: offsetPoints[i].left.y,
      z: offsetPoints[i].left.z,
    })
    points.push({
      id: rightId,
      x: offsetPoints[i].right.x,
      y: offsetPoints[i].right.y,
      z: offsetPoints[i].right.z,
    })

    leftIds.push(leftId)
    rightIds.push(rightId)
  }

  // 三角形を生成（各セグメントに2つの三角形）
  const faces: Face[] = []

  for (let i = 0; i < offsetPoints.length - 1; i++) {
    // 三角形1: 左i, 右i, 左i+1
    faces.push({
      p1: leftIds[i],
      p2: rightIds[i],
      p3: leftIds[i + 1],
    })

    // 三角形2: 右i, 右i+1, 左i+1
    faces.push({
      p1: rightIds[i],
      p2: rightIds[i + 1],
      p3: leftIds[i + 1],
    })
  }

  return { points, faces }
}

// 複数の配管メッシュをTINサーフェスに統合
export function mergeMeshes(
  meshes: { points: Point3D[]; faces: Face[] }[]
): TINSurface {
  const pointMap = new Map<string, Point3D>()
  const allFaces: Face[] = []

  for (const mesh of meshes) {
    for (const point of mesh.points) {
      pointMap.set(point.id, point)
    }
    allFaces.push(...mesh.faces)
  }

  return {
    name: 'Construction Plan Surface',
    points: pointMap,
    faces: allFaces,
  }
}

// 合流点での擦り付け処理
// 高い方の配管の終端を低い方の高さに擦り付ける
export function applyTransition(
  vertices: Point3D[],
  mergePointZ: number,
  transitionDistance: number = 5.0
): Point3D[] {
  if (vertices.length < 2) return vertices

  // 終端点（最下流）
  const endPoint = vertices[vertices.length - 1]
  const heightDiff = endPoint.z - mergePointZ

  // 高さの差がない場合は変更なし
  if (Math.abs(heightDiff) < 0.001) return vertices

  // 擦り付け区間の累積距離を計算
  let cumulativeDistance = 0
  const distances: number[] = [0]

  for (let i = vertices.length - 1; i > 0; i--) {
    cumulativeDistance += distance2D(vertices[i], vertices[i - 1])
    distances.unshift(cumulativeDistance)
  }

  // 擦り付けを適用
  const result: Point3D[] = []

  for (let i = 0; i < vertices.length; i++) {
    const distFromEnd = distances[i]
    let newZ = vertices[i].z

    if (distFromEnd <= transitionDistance) {
      // 擦り付け区間内
      // 距離0（終端）でmergePointZ、距離transitionDistanceで元の高さ
      const t = distFromEnd / transitionDistance
      const targetZ = mergePointZ + (vertices[i].z - mergePointZ) * t
      newZ = targetZ
    }

    result.push({
      ...vertices[i],
      z: newZ,
    })
  }

  // 終端点のZ値を合流点の高さに設定
  result[result.length - 1].z = mergePointZ

  return result
}

// 2つの配管が合流する点で、隣接三角形の頂点を一致させる
export function alignMergePoints(
  mesh1: { points: Point3D[]; faces: Face[] },
  mesh2: { points: Point3D[]; faces: Face[] },
  mergePoint: { x: number; y: number; z: number },
  tolerance: number = 0.5
): void {
  // mesh1の点で合流点に近いものを探す
  for (const point of mesh1.points) {
    const dist = distance2D(point, mergePoint)
    if (dist < tolerance) {
      point.z = mergePoint.z
    }
  }

  // mesh2の点で合流点に近いものを探す
  for (const point of mesh2.points) {
    const dist = distance2D(point, mergePoint)
    if (dist < tolerance) {
      point.z = mergePoint.z
    }
  }
}

// 合流接続情報を検出
export function detectMergeConnections(
  absorptionPipes: { pipeId: string; vertices: Point3D[] }[],
  collectorPipes: { pipeId: string; vertices: Point3D[] }[],
  tolerance: number = 0.5
): MergeConnection[] {
  const connections: MergeConnection[] = []

  for (const absorption of absorptionPipes) {
    if (absorption.vertices.length < 2) continue

    const absEnd = absorption.vertices[absorption.vertices.length - 1]
    const absPrev = absorption.vertices[absorption.vertices.length - 2]
    const absDir = normalizedDirection(absPrev, absEnd)

    // 最も近い集水管のセグメントを探す
    for (const collector of collectorPipes) {
      if (collector.vertices.length < 2) continue

      for (let i = 0; i < collector.vertices.length - 1; i++) {
        const colStart = collector.vertices[i]
        const colEnd = collector.vertices[i + 1]
        const segLen = distance2D(colStart, colEnd)
        if (segLen < 0.001) continue

        // 吸水管終端から集水管セグメントへの最短距離を計算
        const colDir = normalizedDirection(colStart, colEnd)

        // 吸水管終端が集水管セグメントに近いか
        const dx = absEnd.x - colStart.x
        const dy = absEnd.y - colStart.y
        const t = (dx * colDir.dx + dy * colDir.dy) / segLen

        if (t < -0.1 || t > 1.1) continue // セグメント外

        const projX = colStart.x + t * (colEnd.x - colStart.x)
        const projY = colStart.y + t * (colEnd.y - colStart.y)
        const projZ = colStart.z + t * (colEnd.z - colStart.z)
        const dist = Math.sqrt((absEnd.x - projX) ** 2 + (absEnd.y - projY) ** 2)

        if (dist < tolerance) {
          // 吸水管が集水管の左側から来るか右側から来るか判定
          const colNormal = rotateLeft90(colDir)
          const cross = (absEnd.x - projX) * colNormal.dx + (absEnd.y - projY) * colNormal.dy
          const mergeFromLeft = cross > 0

          connections.push({
            absorptionPipeId: absorption.pipeId,
            collectorPipeId: collector.pipeId,
            mergePoint: {
              id: `merge_${absorption.pipeId}_${collector.pipeId}`,
              x: projX,
              y: projY,
              z: projZ,
            },
            absorptionDirection: absDir,
            collectorDirection: colDir,
            mergeFromLeft,
          })
          break
        }
      }
    }
  }

  return connections
}

// 集水管に合流点を挿入し、その位置での左右オフセット点を返す
export function insertMergePointsIntoCollector(
  collectorVertices: Point3D[],
  mergeConnections: MergeConnection[],
  offsetDistance: number,
  collectorPipeId: string
): {
  vertices: Point3D[]
  mergeOffsetPoints: Map<string, { left: Point3D; right: Point3D; insertIndex: number }>
} {
  if (collectorVertices.length < 2) {
    return { vertices: collectorVertices, mergeOffsetPoints: new Map() }
  }

  // この集水管に関連する合流点を収集
  const relevantConnections = mergeConnections.filter(c => c.collectorPipeId === collectorPipeId)
  if (relevantConnections.length === 0) {
    return { vertices: collectorVertices, mergeOffsetPoints: new Map() }
  }

  // 各セグメントに挿入する点を計算
  interface InsertInfo {
    segmentIndex: number
    t: number // セグメント上の位置（0-1）
    connection: MergeConnection
  }
  const insertInfos: InsertInfo[] = []

  for (const conn of relevantConnections) {
    // どのセグメントに合流点があるか探す
    for (let i = 0; i < collectorVertices.length - 1; i++) {
      const segStart = collectorVertices[i]
      const segEnd = collectorVertices[i + 1]
      const segLen = distance2D(segStart, segEnd)
      if (segLen < 0.001) continue

      const dx = conn.mergePoint.x - segStart.x
      const dy = conn.mergePoint.y - segStart.y
      const segDir = normalizedDirection(segStart, segEnd)
      const t = (dx * segDir.dx + dy * segDir.dy) / segLen

      if (t >= -0.01 && t <= 1.01) {
        const projX = segStart.x + t * (segEnd.x - segStart.x)
        const projY = segStart.y + t * (segEnd.y - segStart.y)
        const dist = Math.sqrt((conn.mergePoint.x - projX) ** 2 + (conn.mergePoint.y - projY) ** 2)

        if (dist < 0.5) {
          insertInfos.push({ segmentIndex: i, t: Math.max(0, Math.min(1, t)), connection: conn })
          break
        }
      }
    }
  }

  // セグメントインデックスとt値でソート
  insertInfos.sort((a, b) => {
    if (a.segmentIndex !== b.segmentIndex) return a.segmentIndex - b.segmentIndex
    return a.t - b.t
  })

  // 新しい頂点リストを構築
  const newVertices: Point3D[] = []
  const mergeOffsetPoints = new Map<string, { left: Point3D; right: Point3D; insertIndex: number }>()
  let currentInsertIdx = 0

  for (let i = 0; i < collectorVertices.length; i++) {
    newVertices.push(collectorVertices[i])

    // このセグメント後に挿入する合流点があるか
    while (
      currentInsertIdx < insertInfos.length &&
      insertInfos[currentInsertIdx].segmentIndex === i
    ) {
      const info = insertInfos[currentInsertIdx]
      const segStart = collectorVertices[i]
      const segEnd = collectorVertices[i + 1]

      // 合流点の位置を計算
      const mergeX = segStart.x + info.t * (segEnd.x - segStart.x)
      const mergeY = segStart.y + info.t * (segEnd.y - segStart.y)
      const mergeZ = segStart.z + info.t * (segEnd.z - segStart.z)

      const mergeVertex: Point3D = {
        id: `col_merge_${info.connection.absorptionPipeId}`,
        x: mergeX,
        y: mergeY,
        z: mergeZ,
      }

      const insertIndex = newVertices.length
      newVertices.push(mergeVertex)

      // 合流点での左右オフセット点を計算
      const colDir = normalizedDirection(segStart, segEnd)
      const colNormal = rotateLeft90(colDir)

      const leftPoint: Point3D = {
        id: `col_merge_${info.connection.absorptionPipeId}_L`,
        x: mergeX + colNormal.dx * offsetDistance,
        y: mergeY + colNormal.dy * offsetDistance,
        z: mergeZ,
      }
      const rightPoint: Point3D = {
        id: `col_merge_${info.connection.absorptionPipeId}_R`,
        x: mergeX - colNormal.dx * offsetDistance,
        y: mergeY - colNormal.dy * offsetDistance,
        z: mergeZ,
      }

      mergeOffsetPoints.set(info.connection.absorptionPipeId, {
        left: leftPoint,
        right: rightPoint,
        insertIndex,
      })

      currentInsertIdx++
    }
  }

  return { vertices: newVertices, mergeOffsetPoints }
}

// 吸水管の終端を集水管のオフセット線に合わせてトリミング
export function trimAbsorptionToCollectorEdge(
  absorptionVertices: Point3D[],
  mergeConnection: MergeConnection,
  collectorOffsetPoint: { left: Point3D; right: Point3D },
  _offsetDistance: number,
  transitionDistance: number
): {
  trimmedVertices: Point3D[]
  transitionPoint: Point3D // 5m手前の点
  edgePoint: Point3D // 集水管端との交点
} {
  if (absorptionVertices.length < 2) {
    return {
      trimmedVertices: absorptionVertices,
      transitionPoint: absorptionVertices[0] || { id: '', x: 0, y: 0, z: 0 },
      edgePoint: absorptionVertices[0] || { id: '', x: 0, y: 0, z: 0 },
    }
  }

  // 集水管の端（左または右）を決定
  const targetEdge = mergeConnection.mergeFromLeft
    ? collectorOffsetPoint.left
    : collectorOffsetPoint.right

  // 吸水管の終端を集水管端の位置に調整
  // 終端から吸水管方向に遡って、集水管端に達する位置を計算
  const edgePoint: Point3D = {
    id: `${absorptionVertices[absorptionVertices.length - 1].id}_edge`,
    x: targetEdge.x,
    y: targetEdge.y,
    z: mergeConnection.mergePoint.z, // 合流点の高さを使用
  }

  // 5m手前の点を計算
  let transitionPoint: Point3D
  let cumulativeDist = 0
  let transitionIdx = absorptionVertices.length - 1

  // 終端から遡って5mの位置を探す
  for (let i = absorptionVertices.length - 1; i > 0; i--) {
    const segDist = distance2D(absorptionVertices[i], absorptionVertices[i - 1])
    if (cumulativeDist + segDist >= transitionDistance) {
      // このセグメント上に5m地点がある
      const remainingDist = transitionDistance - cumulativeDist
      const t = remainingDist / segDist
      transitionPoint = {
        id: `${absorptionVertices[i].id}_trans`,
        x: absorptionVertices[i].x + (absorptionVertices[i - 1].x - absorptionVertices[i].x) * t,
        y: absorptionVertices[i].y + (absorptionVertices[i - 1].y - absorptionVertices[i].y) * t,
        z: absorptionVertices[i].z + (absorptionVertices[i - 1].z - absorptionVertices[i].z) * t,
      }
      transitionIdx = i
      break
    }
    cumulativeDist += segDist
  }

  // 5m区間がない場合は最初の点を使用
  if (!transitionPoint!) {
    transitionPoint = { ...absorptionVertices[0], id: `${absorptionVertices[0].id}_trans` }
    transitionIdx = 0
  }

  // トリミングされた頂点リスト（5m地点から終端まで削除し、新しい終端点を追加）
  const trimmedVertices = [
    ...absorptionVertices.slice(0, transitionIdx),
    transitionPoint,
    edgePoint,
  ]

  return { trimmedVertices, transitionPoint, edgePoint }
}

// 合流部の三角形メッシュを生成
// 吸水管の5m手前の左右点と、集水管上の合流点の左右点を接続
export function generateMergeTriangles(
  absorptionPipeId: string,
  transitionPoint: Point3D,
  edgePoint: Point3D,
  collectorMergePoints: { left: Point3D; right: Point3D },
  absorptionDirection: { dx: number; dy: number },
  offsetDistance: number,
  mergeFromLeft: boolean
): { points: Point3D[]; faces: Face[] } {
  const points: Point3D[] = []
  const faces: Face[] = []

  // 吸水管の5m地点での左右オフセット点
  const absNormal = rotateLeft90(absorptionDirection)
  const transLeft: Point3D = {
    id: `${absorptionPipeId}_trans_L`,
    x: transitionPoint.x + absNormal.dx * offsetDistance,
    y: transitionPoint.y + absNormal.dy * offsetDistance,
    z: transitionPoint.z,
  }
  const transRight: Point3D = {
    id: `${absorptionPipeId}_trans_R`,
    x: transitionPoint.x - absNormal.dx * offsetDistance,
    y: transitionPoint.y - absNormal.dy * offsetDistance,
    z: transitionPoint.z,
  }

  // 吸水管端での左右オフセット点
  const edgeLeft: Point3D = {
    id: `${absorptionPipeId}_edge_L`,
    x: edgePoint.x + absNormal.dx * offsetDistance,
    y: edgePoint.y + absNormal.dy * offsetDistance,
    z: edgePoint.z,
  }
  const edgeRight: Point3D = {
    id: `${absorptionPipeId}_edge_R`,
    x: edgePoint.x - absNormal.dx * offsetDistance,
    y: edgePoint.y - absNormal.dy * offsetDistance,
    z: edgePoint.z,
  }

  points.push(transLeft, transRight, edgeLeft, edgeRight)
  points.push(collectorMergePoints.left, collectorMergePoints.right)

  // 三角形を生成
  // 吸水管のメッシュ部分（5m地点から端まで）
  faces.push({
    p1: transLeft.id,
    p2: transRight.id,
    p3: edgeLeft.id,
  })
  faces.push({
    p1: transRight.id,
    p2: edgeRight.id,
    p3: edgeLeft.id,
  })

  // 合流部の三角形（吸水管端と集水管のオフセット点を接続）
  if (mergeFromLeft) {
    // 左側から合流：吸水管の右端が集水管の左端に接続
    faces.push({
      p1: edgeLeft.id,
      p2: edgeRight.id,
      p3: collectorMergePoints.left.id,
    })
  } else {
    // 右側から合流：吸水管の左端が集水管の右端に接続
    faces.push({
      p1: edgeLeft.id,
      p2: edgeRight.id,
      p3: collectorMergePoints.right.id,
    })
  }

  return { points, faces }
}
