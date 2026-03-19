// 三角形分割ユーティリティ

import type { Point3D, Face, TINSurface } from './types'
import { distance2D, offsetLine, adjustOffsetLinesAtCorner } from './geometry'

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
