// 三角形分割ユーティリティ

import type { Point3D, Face, TINSurface } from './types'
import { distance2D, offsetLine, adjustOffsetLinesAtCorner, normalizedDirection, rotateLeft90, lineIntersection } from './geometry'

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
  // 座標をキーとしたマップ（座標の重複排除用）
  const coordToIdMap = new Map<string, string>()
  // 古いIDから新しいIDへのマッピング
  const idRemap = new Map<string, string>()
  const allFaces: Face[] = []

  for (const mesh of meshes) {
    for (const point of mesh.points) {
      // 座標を文字列キーに変換（小数点以下6桁で丸める）
      const coordKey = `${point.x.toFixed(6)},${point.y.toFixed(6)},${point.z.toFixed(6)}`

      const existingId = coordToIdMap.get(coordKey)
      if (existingId) {
        // 同じ座標の点が既に存在する場合、IDをリマップ
        idRemap.set(point.id, existingId)
      } else {
        // 新しい点として登録
        coordToIdMap.set(coordKey, point.id)
        pointMap.set(point.id, point)
        idRemap.set(point.id, point.id)
      }
    }
  }

  // FaceのIDをリマップ
  for (const mesh of meshes) {
    for (const face of mesh.faces) {
      const remappedFace: Face = {
        p1: idRemap.get(face.p1) ?? face.p1,
        p2: idRemap.get(face.p2) ?? face.p2,
        p3: idRemap.get(face.p3) ?? face.p3,
      }
      allFaces.push(remappedFace)
    }
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
// 吸水管の幅分オフセットした位置に2点の合流点を挿入する
export function insertMergePointsIntoCollector(
  collectorVertices: Point3D[],
  mergeConnections: MergeConnection[],
  offsetDistance: number,
  collectorPipeId: string,
  absorptionWidth: number = 0.6 // 吸水管の幅
): {
  vertices: Point3D[]
  mergeOffsetPoints: Map<string, {
    left: Point3D
    right: Point3D
    // 合流部の凹み点（集水管中心線上、吸水管幅分オフセット）
    mergePoint1: Point3D // 上流側の合流点
    mergePoint2: Point3D // 下流側の合流点
    insertIndex1: number
    insertIndex2: number
  }>
} {
  if (collectorVertices.length < 2) {
    return { vertices: collectorVertices, mergeOffsetPoints: new Map() }
  }

  // この集水管に関連する合流点を収集
  const relevantConnections = mergeConnections.filter(c => c.collectorPipeId === collectorPipeId)
  if (relevantConnections.length === 0) {
    return { vertices: collectorVertices, mergeOffsetPoints: new Map() }
  }

  const absorptionHalfWidth = absorptionWidth / 2

  // 各セグメントに挿入する点を計算
  interface InsertInfo {
    segmentIndex: number
    t: number // セグメント上の位置（0-1）
    connection: MergeConnection
    // 合流点から上流・下流にオフセットした位置のt値
    t1: number // 上流側（吸水管幅の半分手前）
    t2: number // 下流側（吸水管幅の半分先）
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
          // 吸水管幅の半分だけ上流・下流にオフセットしたt値を計算
          const tOffset = absorptionHalfWidth / segLen
          const t1 = Math.max(0, t - tOffset) // 上流側
          const t2 = Math.min(1, t + tOffset) // 下流側

          insertInfos.push({
            segmentIndex: i,
            t: Math.max(0, Math.min(1, t)),
            connection: conn,
            t1,
            t2,
          })
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
  const mergeOffsetPoints = new Map<string, {
    left: Point3D
    right: Point3D
    mergePoint1: Point3D
    mergePoint2: Point3D
    insertIndex1: number
    insertIndex2: number
  }>()
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
      const colDir = normalizedDirection(segStart, segEnd)
      const colNormal = rotateLeft90(colDir)

      // 合流点1（上流側）の位置を計算
      const merge1X = segStart.x + info.t1 * (segEnd.x - segStart.x)
      const merge1Y = segStart.y + info.t1 * (segEnd.y - segStart.y)
      const merge1Z = segStart.z + info.t1 * (segEnd.z - segStart.z)

      const mergeVertex1: Point3D = {
        id: `col_merge_${info.connection.absorptionPipeId}_1`,
        x: merge1X,
        y: merge1Y,
        z: merge1Z,
      }

      const insertIndex1 = newVertices.length
      newVertices.push(mergeVertex1)

      // 合流点2（下流側）の位置を計算
      const merge2X = segStart.x + info.t2 * (segEnd.x - segStart.x)
      const merge2Y = segStart.y + info.t2 * (segEnd.y - segStart.y)
      const merge2Z = segStart.z + info.t2 * (segEnd.z - segStart.z)

      const mergeVertex2: Point3D = {
        id: `col_merge_${info.connection.absorptionPipeId}_2`,
        x: merge2X,
        y: merge2Y,
        z: merge2Z,
      }

      const insertIndex2 = newVertices.length
      newVertices.push(mergeVertex2)

      // 合流点での左右オフセット点を計算（中心点の位置）
      const mergeX = segStart.x + info.t * (segEnd.x - segStart.x)
      const mergeY = segStart.y + info.t * (segEnd.y - segStart.y)
      const mergeZ = segStart.z + info.t * (segEnd.z - segStart.z)

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
        mergePoint1: mergeVertex1,
        mergePoint2: mergeVertex2,
        insertIndex1,
        insertIndex2,
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

// 合流部の三角形メッシュを生成（旧方式 - 互換性のため残す）
// 吸水管の5m手前の左右点と、集水管上の合流点（2点）を接続
export function generateMergeTriangles(
  absorptionPipeId: string,
  transitionPoint: Point3D,
  edgePoint: Point3D,
  collectorMergePoints: {
    left: Point3D
    right: Point3D
    mergePoint1: Point3D // 上流側の合流点
    mergePoint2: Point3D // 下流側の合流点
  },
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

  // 吸水管端での左右オフセット点（集水管のmergePoint1とmergePoint2の位置に合わせる）
  // 吸水管端は集水管の合流点1と合流点2に接続される
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
  points.push(collectorMergePoints.mergePoint1, collectorMergePoints.mergePoint2)

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

  // 合流部の三角形（吸水管端と集水管の合流点1・2を接続）
  // 吸水管の端の2点を、集水管の2つの合流点に接続
  if (mergeFromLeft) {
    // 左側から合流：
    // edgeLeft（吸水管の左端）→ mergePoint1（上流側）
    // edgeRight（吸水管の右端）→ mergePoint2（下流側）
    faces.push({
      p1: edgeLeft.id,
      p2: edgeRight.id,
      p3: collectorMergePoints.mergePoint1.id,
    })
    faces.push({
      p1: edgeRight.id,
      p2: collectorMergePoints.mergePoint2.id,
      p3: collectorMergePoints.mergePoint1.id,
    })
  } else {
    // 右側から合流：
    // edgeLeft（吸水管の左端）→ mergePoint2（下流側）
    // edgeRight（吸水管の右端）→ mergePoint1（上流側）
    faces.push({
      p1: edgeLeft.id,
      p2: edgeRight.id,
      p3: collectorMergePoints.mergePoint2.id,
    })
    faces.push({
      p1: edgeRight.id,
      p2: collectorMergePoints.mergePoint1.id,
      p3: collectorMergePoints.mergePoint2.id,
    })
  }

  return { points, faces }
}

// ========================================
// 新アルゴリズム: 交点計算方式による合流部処理
// ========================================

// 中間合流部の情報
export interface MidMergeInfo {
  absorptionPipeId: string
  collectorPipeId: string
  // 集水管の中心線上の点（1A→1B→1C）
  col1A: Point3D // 下流側
  col1B: Point3D // 合流点
  col1C: Point3D // 上流側
  // 吸水管の中心線上の点（2A→2B）
  abs2A: Point3D // 下流（集水管に近い側）
  abs2B: Point3D // 上流側
  // 合流方向
  mergeFromLeft: boolean
  // 合流点のZ座標
  mergeZ: number
}

// 中間合流部の交点を計算
export function calculateMidMergeIntersections(
  info: MidMergeInfo,
  offsetDistance: number,
  transitionDistance: number
): {
  // 交点
  point2AL: Point3D // 吸水管左オフセットと集水管オフセットの交点
  point2AR: Point3D // 吸水管右オフセットと集水管オフセットの交点
  // 集水管側の折点（合流の反対側）
  point1BOpposite: Point3D // 1BL または 1BR
  // 吸水管の擦り付け点
  point2LS: Point3D // 吸水管左側の擦り付け点
  point2RS: Point3D // 吸水管右側の擦り付け点
} {
  const { col1A, col1B, col1C, abs2A, abs2B, mergeFromLeft, mergeZ } = info

  // 集水管の方向ベクトル
  const colDir1A1B = normalizedDirection(col1A, col1B)
  const colDir1B1C = normalizedDirection(col1B, col1C)
  const colNormal1A1B = rotateLeft90(colDir1A1B)
  const colNormal1B1C = rotateLeft90(colDir1B1C)

  // 吸水管の方向ベクトル
  const absDir2A2B = normalizedDirection(abs2A, abs2B)
  const absNormal = rotateLeft90(absDir2A2B)

  // 吸水管の左右オフセット点（2A位置）
  const abs2A_L = {
    x: abs2A.x + absNormal.dx * offsetDistance,
    y: abs2A.y + absNormal.dy * offsetDistance,
  }
  const abs2A_R = {
    x: abs2A.x - absNormal.dx * offsetDistance,
    y: abs2A.y - absNormal.dy * offsetDistance,
  }

  let point2AL: Point3D
  let point2AR: Point3D
  let point1BOpposite: Point3D

  if (mergeFromLeft) {
    // 左側から合流する場合
    // 1A→1Bから左にオフセットした線と、2A→2Bから左にオフセットした線との交点(2AL)
    const col1A_L = {
      x: col1A.x + colNormal1A1B.dx * offsetDistance,
      y: col1A.y + colNormal1A1B.dy * offsetDistance,
    }
    const intersection2AL = lineIntersection(
      col1A_L,
      colDir1A1B,
      abs2A_L,
      absDir2A2B
    )

    // 1B→1Cから左にオフセットした線と、2A→2Bから右にオフセットした線との交点(2AR)
    const col1B_L = {
      x: col1B.x + colNormal1B1C.dx * offsetDistance,
      y: col1B.y + colNormal1B1C.dy * offsetDistance,
    }
    const intersection2AR = lineIntersection(
      col1B_L,
      colDir1B1C,
      abs2A_R,
      absDir2A2B
    )

    point2AL = {
      id: `${info.absorptionPipeId}_2AL`,
      x: intersection2AL?.x ?? abs2A_L.x,
      y: intersection2AL?.y ?? abs2A_L.y,
      z: mergeZ,
    }
    point2AR = {
      id: `${info.absorptionPipeId}_2AR`,
      x: intersection2AR?.x ?? abs2A_R.x,
      y: intersection2AR?.y ?? abs2A_R.y,
      z: mergeZ,
    }

    // 合流の反対側（右側）に折点を追加
    // 単独折点と同様に、1Bの右オフセット位置
    const avgNormalDx = (colNormal1A1B.dx + colNormal1B1C.dx) / 2
    const avgNormalDy = (colNormal1A1B.dy + colNormal1B1C.dy) / 2
    const avgLen = Math.sqrt(avgNormalDx ** 2 + avgNormalDy ** 2) || 1
    point1BOpposite = {
      id: `${info.collectorPipeId}_${info.absorptionPipeId}_1BR`,
      x: col1B.x - (avgNormalDx / avgLen) * offsetDistance,
      y: col1B.y - (avgNormalDy / avgLen) * offsetDistance,
      z: mergeZ,
    }
  } else {
    // 右側から合流する場合
    // 1A→1Bから右にオフセットした線と、2A→2Bから左にオフセットした線との交点(2AL)
    const col1A_R = {
      x: col1A.x - colNormal1A1B.dx * offsetDistance,
      y: col1A.y - colNormal1A1B.dy * offsetDistance,
    }
    const intersection2AL = lineIntersection(
      col1A_R,
      colDir1A1B,
      abs2A_L,
      absDir2A2B
    )

    // 1B→1Cから右にオフセットした線と、2A→2Bから右にオフセットした線との交点(2AR)
    const col1B_R = {
      x: col1B.x - colNormal1B1C.dx * offsetDistance,
      y: col1B.y - colNormal1B1C.dy * offsetDistance,
    }
    const intersection2AR = lineIntersection(
      col1B_R,
      colDir1B1C,
      abs2A_R,
      absDir2A2B
    )

    point2AL = {
      id: `${info.absorptionPipeId}_2AL`,
      x: intersection2AL?.x ?? abs2A_L.x,
      y: intersection2AL?.y ?? abs2A_L.y,
      z: mergeZ,
    }
    point2AR = {
      id: `${info.absorptionPipeId}_2AR`,
      x: intersection2AR?.x ?? abs2A_R.x,
      y: intersection2AR?.y ?? abs2A_R.y,
      z: mergeZ,
    }

    // 合流の反対側（左側）に折点を追加
    const avgNormalDx = (colNormal1A1B.dx + colNormal1B1C.dx) / 2
    const avgNormalDy = (colNormal1A1B.dy + colNormal1B1C.dy) / 2
    const avgLen = Math.sqrt(avgNormalDx ** 2 + avgNormalDy ** 2) || 1
    point1BOpposite = {
      id: `${info.collectorPipeId}_${info.absorptionPipeId}_1BL`,
      x: col1B.x + (avgNormalDx / avgLen) * offsetDistance,
      y: col1B.y + (avgNormalDy / avgLen) * offsetDistance,
      z: mergeZ,
    }
  }

  // 擦り付け点を計算（2Aから上流方向にtransitionDistance進んだ位置）
  const totalDist = distance2D(abs2A, abs2B)
  const t = Math.min(transitionDistance / totalDist, 1)
  const transX = abs2A.x + (abs2B.x - abs2A.x) * t
  const transY = abs2A.y + (abs2B.y - abs2A.y) * t
  const transZ = abs2A.z + (abs2B.z - abs2A.z) * t

  const point2LS: Point3D = {
    id: `${info.absorptionPipeId}_2LS`,
    x: transX + absNormal.dx * offsetDistance,
    y: transY + absNormal.dy * offsetDistance,
    z: transZ,
  }
  const point2RS: Point3D = {
    id: `${info.absorptionPipeId}_2RS`,
    x: transX - absNormal.dx * offsetDistance,
    y: transY - absNormal.dy * offsetDistance,
    z: transZ,
  }

  return { point2AL, point2AR, point1BOpposite, point2LS, point2RS }
}

// 中間合流部の三角形メッシュを生成（新アルゴリズム）
// 注意: この関数は単独では使用せず、generateCollectorWithMergesと組み合わせて使用
export function generateMidMergeTrianglesNew(
  info: MidMergeInfo,
  offsetDistance: number,
  transitionDistance: number
): { points: Point3D[]; faces: Face[] } {
  const { point2AL, point2AR, point1BOpposite, point2LS, point2RS } =
    calculateMidMergeIntersections(info, offsetDistance, transitionDistance)

  const points: Point3D[] = [point2AL, point2AR, point1BOpposite, point2LS, point2RS]
  const faces: Face[] = []

  // 吸水管部分の三角形（2AL, 2LS, 2AR, 2RS）
  // 三角形1: 2AL, 2LS, 2AR
  faces.push({
    p1: point2AL.id,
    p2: point2LS.id,
    p3: point2AR.id,
  })
  // 三角形2: 2AR, 2LS, 2RS
  faces.push({
    p1: point2AR.id,
    p2: point2LS.id,
    p3: point2RS.id,
  })

  // 合流部集水の三角形: 1BOpposite, 2AL, 2AR
  faces.push({
    p1: point1BOpposite.id,
    p2: point2AL.id,
    p3: point2AR.id,
  })

  return { points, faces }
}

// 中間合流部の情報を拡張（集水管のセグメントインデックスを含む）
export interface MidMergeInfoWithSegment extends MidMergeInfo {
  segmentIndex: number // 合流点が存在する集水管セグメントのインデックス
  t: number // セグメント上の位置（0-1）
}

// 集水管メッシュを合流点対応で生成
// 合流点でメッシュを分割し、合流部の頂点と共有する
export function generateCollectorWithMerges(
  collectorVertices: Point3D[],
  collectorPipeId: string,
  merges: MidMergeInfoWithSegment[],
  offsetDistance: number
): {
  collectorMesh: { points: Point3D[]; faces: Face[] }
  // 各合流点での集水管オフセット頂点（合流部三角形との共有用）
  mergeVertices: Map<string, {
    // 合流点の上流側オフセット頂点
    upstreamLeft: Point3D
    upstreamRight: Point3D
    // 合流点の下流側オフセット頂点
    downstreamLeft: Point3D
    downstreamRight: Point3D
  }>
} {
  if (collectorVertices.length < 2) {
    return { collectorMesh: { points: [], faces: [] }, mergeVertices: new Map() }
  }

  // 合流点をセグメントとt値でソート
  const sortedMerges = [...merges].sort((a, b) => {
    if (a.segmentIndex !== b.segmentIndex) return a.segmentIndex - b.segmentIndex
    return a.t - b.t
  })

  // 集水管の各セグメントで合流点を処理
  const points: Point3D[] = []
  const faces: Face[] = []
  const mergeVertices = new Map<string, {
    upstreamLeft: Point3D
    upstreamRight: Point3D
    downstreamLeft: Point3D
    downstreamRight: Point3D
  }>()

  // オフセット線を計算
  const offsetPoints = offsetLine(collectorVertices, offsetDistance)

  // 折れ点でのオフセット線の交点を調整
  for (let i = 1; i < offsetPoints.length - 1; i++) {
    adjustOffsetLinesAtCorner(offsetPoints, i)
  }

  // 各セグメントを処理
  let currentMergeIdx = 0

  // 前のセグメントの終了点を追跡（合流があった場合はその上流端点）
  let prevSegmentEndLeftId: string | null = null
  let prevSegmentEndRightId: string | null = null
  let prevSegmentEndLeft: Point3D | null = null
  let prevSegmentEndRight: Point3D | null = null

  for (let segIdx = 0; segIdx < collectorVertices.length - 1; segIdx++) {
    const segStart = collectorVertices[segIdx]
    const segEnd = collectorVertices[segIdx + 1]

    // このセグメントの合流点を収集
    const segmentMerges: MidMergeInfoWithSegment[] = []
    while (currentMergeIdx < sortedMerges.length && sortedMerges[currentMergeIdx].segmentIndex === segIdx) {
      segmentMerges.push(sortedMerges[currentMergeIdx])
      currentMergeIdx++
    }

    if (segmentMerges.length === 0) {
      // 合流点がないセグメント - 通常の三角形を生成
      // 前のセグメントで合流があった場合は、その上流端点を開始点として使用
      let actualStartLeftId: string
      let actualStartRightId: string

      if (prevSegmentEndLeftId && prevSegmentEndRightId && prevSegmentEndLeft && prevSegmentEndRight) {
        // 前のセグメントの合流上流端点を使用
        actualStartLeftId = prevSegmentEndLeftId
        actualStartRightId = prevSegmentEndRightId
        // 点は既に追加済み
      } else {
        // 通常の開始点を使用
        actualStartLeftId = `${collectorPipeId}_L${segIdx}`
        actualStartRightId = `${collectorPipeId}_R${segIdx}`
        // 点を追加（重複チェック）
        if (!points.find(p => p.id === actualStartLeftId)) {
          points.push({ id: actualStartLeftId, x: offsetPoints[segIdx].left.x, y: offsetPoints[segIdx].left.y, z: offsetPoints[segIdx].left.z })
        }
        if (!points.find(p => p.id === actualStartRightId)) {
          points.push({ id: actualStartRightId, x: offsetPoints[segIdx].right.x, y: offsetPoints[segIdx].right.y, z: offsetPoints[segIdx].right.z })
        }
      }

      const leftIdEnd = `${collectorPipeId}_L${segIdx + 1}`
      const rightIdEnd = `${collectorPipeId}_R${segIdx + 1}`

      if (!points.find(p => p.id === leftIdEnd)) {
        points.push({ id: leftIdEnd, x: offsetPoints[segIdx + 1].left.x, y: offsetPoints[segIdx + 1].left.y, z: offsetPoints[segIdx + 1].left.z })
      }
      if (!points.find(p => p.id === rightIdEnd)) {
        points.push({ id: rightIdEnd, x: offsetPoints[segIdx + 1].right.x, y: offsetPoints[segIdx + 1].right.y, z: offsetPoints[segIdx + 1].right.z })
      }

      // 三角形を生成
      faces.push({
        p1: actualStartLeftId,
        p2: actualStartRightId,
        p3: leftIdEnd,
      })
      faces.push({
        p1: actualStartRightId,
        p2: rightIdEnd,
        p3: leftIdEnd,
      })

      // このセグメントには合流がないので、次のセグメントは通常の折れ点から開始
      prevSegmentEndLeftId = null
      prevSegmentEndRightId = null
      prevSegmentEndLeft = null
      prevSegmentEndRight = null
    } else {
      // 合流点があるセグメント - 合流点で分割して三角形を生成
      // セグメントの方向と法線
      const colDir = normalizedDirection(segStart, segEnd)
      const colNormal = rotateLeft90(colDir)

      // 前の位置（セグメント開始点）
      // 前のセグメントで合流があった場合は、その上流端点を開始点として使用
      let prevT = 0
      let prevLeftId: string
      let prevRightId: string

      if (prevSegmentEndLeftId && prevSegmentEndRightId && prevSegmentEndLeft && prevSegmentEndRight) {
        // 前のセグメントの合流上流端点を使用
        prevLeftId = prevSegmentEndLeftId
        prevRightId = prevSegmentEndRightId
        // 点は既に追加済み
      } else {
        // 通常の開始点を使用
        prevLeftId = `${collectorPipeId}_L${segIdx}`
        prevRightId = `${collectorPipeId}_R${segIdx}`
        // 開始点を追加
        if (!points.find(p => p.id === prevLeftId)) {
          points.push({ id: prevLeftId, x: offsetPoints[segIdx].left.x, y: offsetPoints[segIdx].left.y, z: offsetPoints[segIdx].left.z })
        }
        if (!points.find(p => p.id === prevRightId)) {
          points.push({ id: prevRightId, x: offsetPoints[segIdx].right.x, y: offsetPoints[segIdx].right.y, z: offsetPoints[segIdx].right.z })
        }
      }

      for (const merge of segmentMerges) {
        // 合流点の位置から上流・下流にオフセット距離だけずらした2点を作成
        // これにより合流部の幅が60cm（30cm×2）となる

        // 合流点の座標を計算
        const mergeX = segStart.x + merge.t * (segEnd.x - segStart.x)
        const mergeY = segStart.y + merge.t * (segEnd.y - segStart.y)
        const mergeZ = segStart.z + merge.t * (segEnd.z - segStart.z)

        // セグメントの長さ
        const segLen = distance2D(segStart, segEnd)

        // 合流点から上流・下流にオフセット距離分ずらす
        // colDirは正規化済みの方向ベクトル
        // 上流側: 合流点 + colDir * offsetDistance
        // 下流側: 合流点 - colDir * offsetDistance
        const upX = mergeX + colDir.dx * offsetDistance
        const upY = mergeY + colDir.dy * offsetDistance
        const upZ = mergeZ + (segLen > 0.001 ? (segEnd.z - segStart.z) / segLen * offsetDistance : 0)

        const downX = mergeX - colDir.dx * offsetDistance
        const downY = mergeY - colDir.dy * offsetDistance
        const downZ = mergeZ - (segLen > 0.001 ? (segEnd.z - segStart.z) / segLen * offsetDistance : 0)

        // 上流側の点
        const upstreamLeft: Point3D = {
          id: `${collectorPipeId}_merge_${merge.absorptionPipeId}_upL`,
          x: upX + colNormal.dx * offsetDistance,
          y: upY + colNormal.dy * offsetDistance,
          z: upZ,
        }
        const upstreamRight: Point3D = {
          id: `${collectorPipeId}_merge_${merge.absorptionPipeId}_upR`,
          x: upX - colNormal.dx * offsetDistance,
          y: upY - colNormal.dy * offsetDistance,
          z: upZ,
        }

        // 下流側の点
        const downstreamLeft: Point3D = {
          id: `${collectorPipeId}_merge_${merge.absorptionPipeId}_downL`,
          x: downX + colNormal.dx * offsetDistance,
          y: downY + colNormal.dy * offsetDistance,
          z: downZ,
        }
        const downstreamRight: Point3D = {
          id: `${collectorPipeId}_merge_${merge.absorptionPipeId}_downR`,
          x: downX - colNormal.dx * offsetDistance,
          y: downY - colNormal.dy * offsetDistance,
          z: downZ,
        }

        points.push(upstreamLeft, upstreamRight, downstreamLeft, downstreamRight)

        // 合流頂点を保存
        mergeVertices.set(merge.absorptionPipeId, {
          upstreamLeft,
          upstreamRight,
          downstreamLeft,
          downstreamRight,
        })

        // 下流側のt値を計算（合流点からoffsetDistanceだけ下流）
        const tDownstream = segLen > 0.001 ? merge.t - offsetDistance / segLen : merge.t
        // 上流側のt値を計算（合流点からoffsetDistanceだけ上流）
        const tUpstream = segLen > 0.001 ? merge.t + offsetDistance / segLen : merge.t

        // 前の位置から合流点の下流側までの三角形を生成
        // tDownstreamがprevTより大きい場合のみ三角形が必要
        if (tDownstream > prevT + 0.001) {
          faces.push({
            p1: prevLeftId,
            p2: prevRightId,
            p3: downstreamLeft.id,
          })
          faces.push({
            p1: prevRightId,
            p2: downstreamRight.id,
            p3: downstreamLeft.id,
          })
        }

        // 合流部分: 60cm×60cmの正方形を2つの三角形で構成
        // 集水管側で正方形全体（2三角形）を生成
        // 三角形1: upL → downL → downR
        faces.push({
          p1: upstreamLeft.id,
          p2: downstreamLeft.id,
          p3: downstreamRight.id,
        })
        // 三角形2: upL → downR → upR
        faces.push({
          p1: upstreamLeft.id,
          p2: downstreamRight.id,
          p3: upstreamRight.id,
        })

        // 次のセクションのために更新
        // 上流側の点から継続
        prevT = tUpstream
        prevLeftId = upstreamLeft.id
        prevRightId = upstreamRight.id

        // 次のセグメント用に最後の合流の上流端点を保存
        prevSegmentEndLeftId = upstreamLeft.id
        prevSegmentEndRightId = upstreamRight.id
        prevSegmentEndLeft = upstreamLeft
        prevSegmentEndRight = upstreamRight
      }

      // 最後の合流点からセグメント終了までの三角形
      if (prevT < 1 - 0.001) {
        const endLeftId = `${collectorPipeId}_L${segIdx + 1}`
        const endRightId = `${collectorPipeId}_R${segIdx + 1}`

        if (!points.find(p => p.id === endLeftId)) {
          points.push({ id: endLeftId, x: offsetPoints[segIdx + 1].left.x, y: offsetPoints[segIdx + 1].left.y, z: offsetPoints[segIdx + 1].left.z })
        }
        if (!points.find(p => p.id === endRightId)) {
          points.push({ id: endRightId, x: offsetPoints[segIdx + 1].right.x, y: offsetPoints[segIdx + 1].right.y, z: offsetPoints[segIdx + 1].right.z })
        }

        faces.push({
          p1: prevLeftId,
          p2: prevRightId,
          p3: endLeftId,
        })
        faces.push({
          p1: prevRightId,
          p2: endRightId,
          p3: endLeftId,
        })

        // 通常の終了点まで三角形を生成したので、次のセグメントは通常の開始点から
        prevSegmentEndLeftId = null
        prevSegmentEndRightId = null
        prevSegmentEndLeft = null
        prevSegmentEndRight = null
      }
      // else: 合流がセグメント終端付近にある場合、次のセグメントはprevSegmentEnd*を使用
    }
  }

  return { collectorMesh: { points, faces }, mergeVertices }
}

// 吸水管の合流部三角形を生成（集水管の頂点と共有）
export function generateAbsorptionMergeTriangles(
  absorptionVertices: Point3D[],
  absorptionPipeId: string,
  collectorMergeVertices: {
    upstreamLeft: Point3D
    upstreamRight: Point3D
    downstreamLeft: Point3D
    downstreamRight: Point3D
  },
  mergeFromLeft: boolean,
  offsetDistance: number,
  transitionDistance: number
): {
  mergeTriangles: { points: Point3D[]; faces: Face[] }
  upperVertices: Point3D[] // 擦り付け点より上流の頂点（通常メッシュ用）
  transitionPointLeft: Point3D // 擦り付け点の左オフセット
  transitionPointRight: Point3D // 擦り付け点の右オフセット
} {
  const points: Point3D[] = []
  const faces: Face[] = []

  // 吸水管の下流端と上流方向
  const absEnd = absorptionVertices[absorptionVertices.length - 1]
  const absPrev = absorptionVertices[absorptionVertices.length - 2]
  const absDir = normalizedDirection(absPrev, absEnd)

  // 擦り付け点を計算（下流端からtransitionDistance上流）
  let cumDist = 0
  let transitionIdx = absorptionVertices.length - 1
  let transitionPoint: Point3D = absEnd

  for (let i = absorptionVertices.length - 1; i > 0; i--) {
    const segDist = distance2D(absorptionVertices[i], absorptionVertices[i - 1])
    if (cumDist + segDist >= transitionDistance) {
      const remainingDist = transitionDistance - cumDist
      const t = remainingDist / segDist
      transitionPoint = {
        id: `${absorptionPipeId}_trans`,
        x: absorptionVertices[i].x + (absorptionVertices[i - 1].x - absorptionVertices[i].x) * t,
        y: absorptionVertices[i].y + (absorptionVertices[i - 1].y - absorptionVertices[i].y) * t,
        z: absorptionVertices[i].z + (absorptionVertices[i - 1].z - absorptionVertices[i].z) * t,
      }
      transitionIdx = i
      break
    }
    cumDist += segDist
  }

  // 擦り付け点がなければ（吸水管が5m未満）最初の点を使用
  if (transitionIdx === absorptionVertices.length - 1) {
    transitionPoint = { ...absorptionVertices[0], id: `${absorptionPipeId}_trans` }
    transitionIdx = 0
  }

  // 擦り付け点での左右オフセット
  // 方向は擦り付け点前後のセグメントから計算
  let transDir = absDir
  if (transitionIdx > 0 && transitionIdx < absorptionVertices.length - 1) {
    const dirBefore = normalizedDirection(absorptionVertices[transitionIdx - 1], absorptionVertices[transitionIdx])
    const dirAfter = normalizedDirection(absorptionVertices[transitionIdx], absorptionVertices[transitionIdx + 1])
    transDir = {
      dx: (dirBefore.dx + dirAfter.dx) / 2,
      dy: (dirBefore.dy + dirAfter.dy) / 2,
    }
    const len = Math.sqrt(transDir.dx ** 2 + transDir.dy ** 2)
    if (len > 0.001) {
      transDir = { dx: transDir.dx / len, dy: transDir.dy / len }
    }
  }
  const transNormal = rotateLeft90(transDir)

  const transitionPointLeft: Point3D = {
    id: `${absorptionPipeId}_transL`,
    x: transitionPoint.x + transNormal.dx * offsetDistance,
    y: transitionPoint.y + transNormal.dy * offsetDistance,
    z: transitionPoint.z,
  }
  const transitionPointRight: Point3D = {
    id: `${absorptionPipeId}_transR`,
    x: transitionPoint.x - transNormal.dx * offsetDistance,
    y: transitionPoint.y - transNormal.dy * offsetDistance,
    z: transitionPoint.z,
  }

  points.push(transitionPointLeft, transitionPointRight)

  // 集水管の合流頂点を取得
  const { upstreamLeft, upstreamRight, downstreamLeft, downstreamRight } = collectorMergeVertices

  // 合流三角形を生成
  // 集水管側で60cm×60cmの正方形（2三角形）を生成済み
  // 吸水管側は擦り付け点から集水管の合流点（2点）への接続三角形を生成
  if (mergeFromLeft) {
    // 左から合流
    // 吸水管の右側（transR）を集水管の左側（upstreamLeft, downstreamLeft）に接続
    // transL → transR → downstreamLeft
    faces.push({
      p1: transitionPointLeft.id,
      p2: transitionPointRight.id,
      p3: downstreamLeft.id,
    })
    // transL → downstreamLeft → upstreamLeft
    faces.push({
      p1: transitionPointLeft.id,
      p2: downstreamLeft.id,
      p3: upstreamLeft.id,
    })
  } else {
    // 右から合流
    // 吸水管の左側（transL）を集水管の右側（upstreamRight, downstreamRight）に接続
    // transR → transL → downstreamRight
    faces.push({
      p1: transitionPointRight.id,
      p2: transitionPointLeft.id,
      p3: downstreamRight.id,
    })
    // transR → downstreamRight → upstreamRight
    faces.push({
      p1: transitionPointRight.id,
      p2: downstreamRight.id,
      p3: upstreamRight.id,
    })
  }

  // 擦り付け点より上流の頂点を収集
  const upperVertices: Point3D[] = []
  for (let i = 0; i < transitionIdx; i++) {
    upperVertices.push(absorptionVertices[i])
  }
  if (transitionIdx > 0) {
    upperVertices.push(transitionPoint)
  }

  return {
    mergeTriangles: { points, faces },
    upperVertices,
    transitionPointLeft,
    transitionPointRight,
  }
}

// 最上流部合流（3管合流）の情報
export interface UpstreamMergeInfo {
  collectorPipeId: string
  // 集水管（1）の中心線上の点
  col1A: Point3D // 下流
  col1B: Point3D // 上流（合流点）
  // 左側の吸水管（2）
  abs2PipeId: string
  abs2A: Point3D // 下流（集水管に近い側）
  abs2B: Point3D // 上流
  // 右側の吸水管（3）
  abs3PipeId: string
  abs3A: Point3D // 下流（集水管に近い側）
  abs3B: Point3D // 上流
  // 合流点のZ座標
  mergeZ: number
}

// 最上流部合流（3管合流）の交点を計算
export function calculateUpstreamMergeIntersections(
  info: UpstreamMergeInfo,
  offsetDistance: number,
  transitionDistance: number
): {
  // 交点
  point2AL: Point3D // 集水管左オフセットと吸水管2左オフセットの交点
  point3AR: Point3D // 集水管右オフセットと吸水管3右オフセットの交点
  point2AR3AL: Point3D // 吸水管2右オフセットと吸水管3左オフセットの交点
  // 吸水管2の擦り付け点
  point2LS: Point3D
  point2RS: Point3D
  // 吸水管3の擦り付け点
  point3LS: Point3D
  point3RS: Point3D
} {
  const { col1A, col1B, abs2A, abs2B, abs3A, abs3B, mergeZ } = info

  // 集水管の方向ベクトル
  const colDir = normalizedDirection(col1A, col1B)
  const colNormal = rotateLeft90(colDir)

  // 吸水管2の方向ベクトル
  const abs2Dir = normalizedDirection(abs2A, abs2B)
  const abs2Normal = rotateLeft90(abs2Dir)

  // 吸水管3の方向ベクトル
  const abs3Dir = normalizedDirection(abs3A, abs3B)
  const abs3Normal = rotateLeft90(abs3Dir)

  // 集水管の左右オフセット点（1A位置）
  const col1A_L = {
    x: col1A.x + colNormal.dx * offsetDistance,
    y: col1A.y + colNormal.dy * offsetDistance,
  }
  const col1A_R = {
    x: col1A.x - colNormal.dx * offsetDistance,
    y: col1A.y - colNormal.dy * offsetDistance,
  }

  // 吸水管2の左右オフセット点（2A位置）
  const abs2A_L = {
    x: abs2A.x + abs2Normal.dx * offsetDistance,
    y: abs2A.y + abs2Normal.dy * offsetDistance,
  }
  const abs2A_R = {
    x: abs2A.x - abs2Normal.dx * offsetDistance,
    y: abs2A.y - abs2Normal.dy * offsetDistance,
  }

  // 吸水管3の左右オフセット点（3A位置）
  const abs3A_L = {
    x: abs3A.x + abs3Normal.dx * offsetDistance,
    y: abs3A.y + abs3Normal.dy * offsetDistance,
  }
  const abs3A_R = {
    x: abs3A.x - abs3Normal.dx * offsetDistance,
    y: abs3A.y - abs3Normal.dy * offsetDistance,
  }

  // 1A→1Bから左にオフセットした線と、2A→2Bから左にオフセットした線の交点(2AL)
  const intersection2AL = lineIntersection(col1A_L, colDir, abs2A_L, abs2Dir)
  const point2AL: Point3D = {
    id: `${info.abs2PipeId}_2AL`,
    x: intersection2AL?.x ?? abs2A_L.x,
    y: intersection2AL?.y ?? abs2A_L.y,
    z: mergeZ,
  }

  // 1A→1Bから右にオフセットした線と、3A→3Bから右にオフセットした線の交点(3AR)
  const intersection3AR = lineIntersection(col1A_R, colDir, abs3A_R, abs3Dir)
  const point3AR: Point3D = {
    id: `${info.abs3PipeId}_3AR`,
    x: intersection3AR?.x ?? abs3A_R.x,
    y: intersection3AR?.y ?? abs3A_R.y,
    z: mergeZ,
  }

  // 2A→2Bから右にオフセットした線と、3A→3Bから左にオフセットした線の交点(2AR3AL)
  const intersection2AR3AL = lineIntersection(abs2A_R, abs2Dir, abs3A_L, abs3Dir)
  const point2AR3AL: Point3D = {
    id: `${info.abs2PipeId}_2AR3AL`,
    x: intersection2AR3AL?.x ?? (abs2A_R.x + abs3A_L.x) / 2,
    y: intersection2AR3AL?.y ?? (abs2A_R.y + abs3A_L.y) / 2,
    z: mergeZ,
  }

  // 吸水管2の擦り付け点
  const totalDist2 = distance2D(abs2A, abs2B)
  const t2 = Math.min(transitionDistance / totalDist2, 1)
  const trans2X = abs2A.x + (abs2B.x - abs2A.x) * t2
  const trans2Y = abs2A.y + (abs2B.y - abs2A.y) * t2
  const trans2Z = abs2A.z + (abs2B.z - abs2A.z) * t2

  const point2LS: Point3D = {
    id: `${info.abs2PipeId}_2LS`,
    x: trans2X + abs2Normal.dx * offsetDistance,
    y: trans2Y + abs2Normal.dy * offsetDistance,
    z: trans2Z,
  }
  const point2RS: Point3D = {
    id: `${info.abs2PipeId}_2RS`,
    x: trans2X - abs2Normal.dx * offsetDistance,
    y: trans2Y - abs2Normal.dy * offsetDistance,
    z: trans2Z,
  }

  // 吸水管3の擦り付け点
  const totalDist3 = distance2D(abs3A, abs3B)
  const t3 = Math.min(transitionDistance / totalDist3, 1)
  const trans3X = abs3A.x + (abs3B.x - abs3A.x) * t3
  const trans3Y = abs3A.y + (abs3B.y - abs3A.y) * t3
  const trans3Z = abs3A.z + (abs3B.z - abs3A.z) * t3

  const point3LS: Point3D = {
    id: `${info.abs3PipeId}_3LS`,
    x: trans3X + abs3Normal.dx * offsetDistance,
    y: trans3Y + abs3Normal.dy * offsetDistance,
    z: trans3Z,
  }
  const point3RS: Point3D = {
    id: `${info.abs3PipeId}_3RS`,
    x: trans3X - abs3Normal.dx * offsetDistance,
    y: trans3Y - abs3Normal.dy * offsetDistance,
    z: trans3Z,
  }

  return { point2AL, point3AR, point2AR3AL, point2LS, point2RS, point3LS, point3RS }
}

// 最上流部合流（3管合流）の三角形メッシュを生成
export function generateUpstreamMergeTriangles(
  info: UpstreamMergeInfo,
  offsetDistance: number,
  transitionDistance: number
): { points: Point3D[]; faces: Face[] } {
  const { point2AL, point3AR, point2AR3AL, point2LS, point2RS, point3LS, point3RS } =
    calculateUpstreamMergeIntersections(info, offsetDistance, transitionDistance)

  const points: Point3D[] = [point2AL, point3AR, point2AR3AL, point2LS, point2RS, point3LS, point3RS]
  const faces: Face[] = []

  // 吸水管2部分の三角形（2AL, 2AR3AL, 2RS, 2LS）
  // 三角形1: 2AL, 2LS, 2AR3AL
  faces.push({
    p1: point2AL.id,
    p2: point2LS.id,
    p3: point2AR3AL.id,
  })
  // 三角形2: 2AR3AL, 2LS, 2RS
  faces.push({
    p1: point2AR3AL.id,
    p2: point2LS.id,
    p3: point2RS.id,
  })

  // 吸水管3部分の三角形（2AR3AL, 3AR, 3RS, 3LS）
  // 三角形3: 2AR3AL, 3LS, 3AR
  faces.push({
    p1: point2AR3AL.id,
    p2: point3LS.id,
    p3: point3AR.id,
  })
  // 三角形4: 3AR, 3LS, 3RS
  faces.push({
    p1: point3AR.id,
    p2: point3LS.id,
    p3: point3RS.id,
  })

  // 中央の三角形: 2AL, 3AR, 2AR3AL
  faces.push({
    p1: point2AL.id,
    p2: point3AR.id,
    p3: point2AR3AL.id,
  })

  return { points, faces }
}
