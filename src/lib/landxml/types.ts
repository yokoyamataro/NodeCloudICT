// LandXML 中心線形（Alignment）関連の型定義
//
// LandXML の Point / Start / End / Center 要素の座標は `Northing Easting [Elevation]` の順。
// 日本の測量系で北 = X, 東 = Y なので、本プロジェクトの (x, y) へのマッピング:
//   first  value → x（北）
//   second value → y（東）

export type AlignmentSegmentType = 'line' | 'curve' | 'spiral'
export type CurveRotation = 'cw' | 'ccw'

export interface AlignmentSegment {
  type: AlignmentSegmentType
  /** 始点の X（北方向） */
  startX: number
  /** 始点の Y（東方向） */
  startY: number
  /** 終点の X */
  endX: number
  /** 終点の Y */
  endY: number
  /** 区間長（m） */
  length: number
  // 曲線（Curve）用
  centerX?: number
  centerY?: number
  /** 半径（m） */
  radius?: number
  /** 回転方向 */
  rotation?: CurveRotation
  // スパイラル（Spiral）用
  /** spiralType（例: clothoid） */
  spiralType?: string
  startRadius?: number | null
  endRadius?: number | null
  /** クロソイドパラメータ A */
  spiralA?: number | null
}

export interface Alignment {
  /** DB 保存済みなら UUID、未保存なら一時 ID */
  id: string
  name: string
  /** 測点起点（m） */
  staStart: number
  /** 全長（m） */
  totalLength: number
  /** 取り込み元ファイル名（任意） */
  sourceFile?: string | null
  segments: AlignmentSegment[]
}
