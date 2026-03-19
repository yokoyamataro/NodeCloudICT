// LandXML出力用の型定義

// 3D座標点
export interface Point3D {
  id: string
  x: number
  y: number
  z: number
}

// 三角形面
export interface Face {
  p1: string // 点ID
  p2: string // 点ID
  p3: string // 点ID
}

// 配管の線形データ
export interface PipeLine {
  pipeId: string
  pipeNumber: string
  pipeType: 'absorption' | 'collector'
  vertices: Point3D[] // 上流から下流への頂点リスト（計画高を含む）
  width: number // 幅（左右のオフセット量の合計、例: 0.6m）
}

// オフセットされた点（左右）
export interface OffsetPoint {
  original: Point3D
  left: Point3D
  right: Point3D
}

// TINサーフェスデータ
export interface TINSurface {
  name: string
  points: Map<string, Point3D>
  faces: Face[]
}

// 合流点情報
export interface MergePoint {
  x: number
  y: number
  z: number // 計画高（低い方に合わせる）
  pipes: string[] // 合流する配管ID
}

// 擦り付け区間
export interface TransitionSegment {
  pipeId: string
  startPoint: Point3D
  endPoint: Point3D
  startZ: number // 元の高さ
  endZ: number // 擦り付け後の高さ
  distance: number // 擦り付け距離（5m）
}
