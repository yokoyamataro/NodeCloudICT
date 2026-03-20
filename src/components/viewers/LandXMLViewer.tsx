import { useRef, useEffect, useMemo, useState } from 'react'
import type { Point3D, Face } from '@/utils/landxml/types'

interface LandXMLViewerProps {
  points: Map<string, Point3D>
  faces: Face[]
  width?: number
  height?: number
}

// 2Dキャンバスで3D風に描画するシンプルなビューアー
export function LandXMLViewer({
  points,
  faces,
  width = 800,
  height = 600,
}: LandXMLViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [rotation, setRotation] = useState({ x: 30, z: 45 })
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [dragMode, setDragMode] = useState<'rotate' | 'pan'>('rotate')

  // 点の配列に変換
  const pointArray = useMemo(() => Array.from(points.values()), [points])

  // バウンディングボックスを計算
  const bounds = useMemo(() => {
    if (pointArray.length === 0) {
      return { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1, centerX: 0.5, centerY: 0.5, centerZ: 0.5 }
    }

    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity
    let minZ = Infinity, maxZ = -Infinity

    for (const p of pointArray) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
      minZ = Math.min(minZ, p.z)
      maxZ = Math.max(maxZ, p.z)
    }

    return {
      minX, maxX, minY, maxY, minZ, maxZ,
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
      centerZ: (minZ + maxZ) / 2,
    }
  }, [pointArray])

  // 3D→2D変換
  const project = useMemo(() => {
    const radX = (rotation.x * Math.PI) / 180
    const radZ = (rotation.z * Math.PI) / 180

    const cosX = Math.cos(radX)
    const sinX = Math.sin(radX)
    const cosZ = Math.cos(radZ)
    const sinZ = Math.sin(radZ)

    const rangeX = bounds.maxX - bounds.minX || 1
    const rangeY = bounds.maxY - bounds.minY || 1
    const rangeZ = bounds.maxZ - bounds.minZ || 1
    const maxRange = Math.max(rangeX, rangeY, rangeZ)
    const scale = (Math.min(width, height) * 0.7 * zoom) / maxRange

    return (x: number, y: number, z: number) => {
      // 中心を原点に移動
      const dx = x - bounds.centerX
      const dy = y - bounds.centerY
      const dz = z - bounds.centerZ

      // Z軸回転
      const x1 = dx * cosZ - dy * sinZ
      const y1 = dx * sinZ + dy * cosZ

      // X軸回転
      const y2 = y1 * cosX - dz * sinX
      const z2 = y1 * sinX + dz * cosX

      // 投影
      const screenX = width / 2 + x1 * scale + pan.x
      const screenY = height / 2 - y2 * scale + pan.y

      return { screenX, screenY, depth: z2 }
    }
  }, [rotation, zoom, pan, bounds, width, height])

  // 面を深度でソート
  const sortedFaces = useMemo(() => {
    return faces
      .map(face => {
        const p1 = points.get(face.p1)
        const p2 = points.get(face.p2)
        const p3 = points.get(face.p3)

        if (!p1 || !p2 || !p3) return null

        const proj1 = project(p1.x, p1.y, p1.z)
        const proj2 = project(p2.x, p2.y, p2.z)
        const proj3 = project(p3.x, p3.y, p3.z)

        const avgDepth = (proj1.depth + proj2.depth + proj3.depth) / 3

        return {
          face,
          points: [p1, p2, p3],
          projected: [proj1, proj2, proj3],
          avgDepth,
        }
      })
      .filter(f => f !== null)
      .sort((a, b) => a!.avgDepth - b!.avgDepth)
  }, [faces, points, project])

  // 描画
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // クリア
    ctx.fillStyle = '#f8fafc'
    ctx.fillRect(0, 0, width, height)

    // 軸を描画
    const origin = project(bounds.centerX, bounds.centerY, bounds.centerZ)

    // X軸（赤）
    const xEnd = project(bounds.centerX + (bounds.maxX - bounds.minX) * 0.3, bounds.centerY, bounds.centerZ)
    ctx.beginPath()
    ctx.moveTo(origin.screenX, origin.screenY)
    ctx.lineTo(xEnd.screenX, xEnd.screenY)
    ctx.strokeStyle = '#ef4444'
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.fillStyle = '#ef4444'
    ctx.font = '12px sans-serif'
    ctx.fillText('X', xEnd.screenX + 5, xEnd.screenY)

    // Y軸（緑）
    const yEnd = project(bounds.centerX, bounds.centerY + (bounds.maxY - bounds.minY) * 0.3, bounds.centerZ)
    ctx.beginPath()
    ctx.moveTo(origin.screenX, origin.screenY)
    ctx.lineTo(yEnd.screenX, yEnd.screenY)
    ctx.strokeStyle = '#22c55e'
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.fillStyle = '#22c55e'
    ctx.fillText('Y', yEnd.screenX + 5, yEnd.screenY)

    // Z軸（青）
    const zEnd = project(bounds.centerX, bounds.centerY, bounds.centerZ + (bounds.maxZ - bounds.minZ) * 0.5)
    ctx.beginPath()
    ctx.moveTo(origin.screenX, origin.screenY)
    ctx.lineTo(zEnd.screenX, zEnd.screenY)
    ctx.strokeStyle = '#3b82f6'
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.fillStyle = '#3b82f6'
    ctx.fillText('Z', zEnd.screenX + 5, zEnd.screenY)

    // 高さに応じた色を計算する関数（赤→黄→青のグラデーション）
    const getColorForHeight = (zNorm: number): { r: number; g: number; b: number } => {
      // zNorm: 0（最低）→ 1（最高）
      // 赤(255,0,0) → 黄(255,255,0) → 青(0,0,255)
      let r: number, g: number, b: number

      if (zNorm < 0.5) {
        // 赤 → 黄（0～0.5）
        const t = zNorm * 2 // 0～1
        r = 255
        g = Math.floor(255 * t)
        b = 0
      } else {
        // 黄 → 青（0.5～1）
        const t = (zNorm - 0.5) * 2 // 0～1
        r = Math.floor(255 * (1 - t))
        g = Math.floor(255 * (1 - t))
        b = Math.floor(255 * t)
      }

      return { r, g, b }
    }

    // 面を描画
    for (const item of sortedFaces) {
      if (!item) continue

      const [proj1, proj2, proj3] = item.projected

      // 法線を計算して表裏を判定
      const v1x = proj2.screenX - proj1.screenX
      const v1y = proj2.screenY - proj1.screenY
      const v2x = proj3.screenX - proj1.screenX
      const v2y = proj3.screenY - proj1.screenY
      const cross = v1x * v2y - v1y * v2x

      // 高さに応じた色（赤→黄→青）
      const avgZ = (item.points[0].z + item.points[1].z + item.points[2].z) / 3
      const zRange = bounds.maxZ - bounds.minZ || 1
      const zNorm = (avgZ - bounds.minZ) / zRange

      const { r, g, b } = getColorForHeight(zNorm)

      // 表面
      ctx.beginPath()
      ctx.moveTo(proj1.screenX, proj1.screenY)
      ctx.lineTo(proj2.screenX, proj2.screenY)
      ctx.lineTo(proj3.screenX, proj3.screenY)
      ctx.closePath()

      // 表裏で明るさを変える
      const brightness = cross > 0 ? 1.0 : 0.7
      ctx.fillStyle = `rgba(${Math.floor(r * brightness)}, ${Math.floor(g * brightness)}, ${Math.floor(b * brightness)}, 0.85)`
      ctx.fill()

      // エッジ（拡大時のみ表示、白線）
      if (zoom >= 2.0) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)'
        ctx.lineWidth = 0.5
        ctx.stroke()
      }
    }

    // 情報表示
    ctx.fillStyle = '#334155'
    ctx.font = '12px sans-serif'
    ctx.fillText(`面数: ${faces.length}`, 10, 20)
    ctx.fillText(`点数: ${pointArray.length}`, 10, 36)
    ctx.fillText(`X: ${bounds.minX.toFixed(1)} ~ ${bounds.maxX.toFixed(1)}`, 10, 52)
    ctx.fillText(`Y: ${bounds.minY.toFixed(1)} ~ ${bounds.maxY.toFixed(1)}`, 10, 68)
    ctx.fillText(`Z: ${bounds.minZ.toFixed(3)} ~ ${bounds.maxZ.toFixed(3)}`, 10, 84)

    // カラースケール凡例を描画
    const legendX = width - 30
    const legendY = 20
    const legendHeight = 100
    const legendWidth = 15

    // グラデーション
    for (let i = 0; i < legendHeight; i++) {
      const zNorm = 1 - i / legendHeight // 上が高い、下が低い
      const { r, g, b } = getColorForHeight(zNorm)
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
      ctx.fillRect(legendX, legendY + i, legendWidth, 1)
    }

    // 枠線
    ctx.strokeStyle = '#64748b'
    ctx.lineWidth = 1
    ctx.strokeRect(legendX, legendY, legendWidth, legendHeight)

    // ラベル
    ctx.fillStyle = '#334155'
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(`${bounds.maxZ.toFixed(2)}m`, legendX - 3, legendY + 10)
    ctx.fillText(`${((bounds.maxZ + bounds.minZ) / 2).toFixed(2)}m`, legendX - 3, legendY + legendHeight / 2 + 3)
    ctx.fillText(`${bounds.minZ.toFixed(2)}m`, legendX - 3, legendY + legendHeight - 2)
    ctx.textAlign = 'left'

    // 凡例タイトル
    ctx.fillText('標高', legendX, legendY - 5)

  }, [sortedFaces, width, height, bounds, project, faces.length, pointArray.length])

  // マウスイベント
  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true)
    setDragStart({ x: e.clientX, y: e.clientY })
    setDragMode(e.shiftKey ? 'pan' : 'rotate')
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return

    const dx = e.clientX - dragStart.x
    const dy = e.clientY - dragStart.y

    if (dragMode === 'rotate') {
      setRotation(prev => ({
        x: Math.max(-90, Math.min(90, prev.x - dy * 0.5)),
        z: prev.z + dx * 0.5,
      }))
    } else {
      setPan(prev => ({
        x: prev.x + dx,
        y: prev.y + dy,
      }))
    }

    setDragStart({ x: e.clientX, y: e.clientY })
  }

  const handleMouseUp = () => {
    setIsDragging(false)
  }

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    setZoom(prev => Math.max(0.1, Math.min(50, prev * delta)))
  }

  const resetView = () => {
    setRotation({ x: 30, z: 45 })
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="border rounded-lg cursor-grab active:cursor-grabbing"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      />
      <div className="absolute bottom-2 right-2 flex gap-2">
        <button
          onClick={resetView}
          className="px-2 py-1 text-xs bg-white border rounded shadow hover:bg-slate-50"
        >
          リセット
        </button>
      </div>
      <div className="absolute top-2 right-2 text-xs text-slate-500 bg-white/80 px-2 py-1 rounded">
        ドラッグ: 回転 | Shift+ドラッグ: 移動 | ホイール: ズーム
      </div>
    </div>
  )
}
