// オルソ画像上の作図（点・線・面・文字・コメント）データ。
// 当面はブラウザの localStorage に工区IDごとに保存する（DBは将来対応）。

export type AnnotationKind =
  | 'point'
  | 'line'
  | 'polygon'
  | 'circle'
  | 'arc'
  | 'text'
  | 'comment'
  | 'dimension'

export interface BaseAnnotation {
  id: string
  kind: AnnotationKind
  color: string
  /** 任意のレイヤ名（DXF 出力時にも反映） */
  layer?: string
}
export interface PointAnnotation extends BaseAnnotation {
  kind: 'point'
  pos: [number, number] // [lat, lng]
}
export interface LineAnnotation extends BaseAnnotation {
  kind: 'line'
  vertices: [number, number][]
}
export interface PolygonAnnotation extends BaseAnnotation {
  kind: 'polygon'
  vertices: [number, number][]
}
export interface CircleAnnotation extends BaseAnnotation {
  kind: 'circle'
  center: [number, number] // [lat, lng]
  radius: number // 平面距離(m)
}
export interface ArcAnnotation extends BaseAnnotation {
  kind: 'arc'
  center: [number, number]
  radius: number
  /** DXF互換: 東+X軸からCCWで何度から何度（度） */
  startDeg: number
  endDeg: number
}
export interface TextAnnotation extends BaseAnnotation {
  kind: 'text'
  pos: [number, number]
  text: string
  size?: number // px（既定 14）
}
export interface CommentAnnotation extends BaseAnnotation {
  kind: 'comment'
  pos: [number, number]
  text: string
  size?: number // px（既定 12）
  /** メンション対象（メールアドレスまたは表示名） */
  mentions?: string[]
}
export interface DimensionAnnotation extends BaseAnnotation {
  kind: 'dimension'
  subKind: 'dist' | 'area' | 'perp'
  vertices: [number, number][] // dist/perp: A,B(,P) ; area: polygon vertices
  value: number // m or m²
  size?: number // ラベル文字サイズ(px)
}
export type Annotation =
  | PointAnnotation
  | LineAnnotation
  | PolygonAnnotation
  | CircleAnnotation
  | ArcAnnotation
  | TextAnnotation
  | CommentAnnotation
  | DimensionAnnotation

const key = (farmId: string) => `orthoAnnotations:${farmId}`

export function loadAnnotations(farmId: string): Annotation[] {
  try {
    const raw = localStorage.getItem(key(farmId))
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr as Annotation[]
  } catch {
    return []
  }
}

export function saveAnnotations(farmId: string, list: Annotation[]): void {
  try {
    localStorage.setItem(key(farmId), JSON.stringify(list))
  } catch {
    /* ignore */
  }
}

export function newAnnotationId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
