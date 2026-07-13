// 座標管理（PC）: 地図右下に折りたたみ表示される写真パネル。
// 開くと地図の下半分（右半分の縦半分）に展開し、選択行の写真を表示する。
// 既定カテゴリ「遠景」「近景」「その他」を横並びで表示し、その場で追加・差し替え・削除できる。

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Camera,
  ChevronDown,
  ChevronUp,
  Image as ImageIcon,
  Loader2,
  Plus,
  X,
} from 'lucide-react'
import { useAttachmentStore, type Attachment } from '@/stores/attachmentStore'
import { PhotoEditModal, type PhotoEditMeta } from './PhotoEditModal'
import { PhotoTileWithMeta } from './PhotoTileWithMeta'
import {
  useCoordinateStore,
  type CoordinateRow,
} from '@/stores/coordinateStore'
import {
  STAKE_STATUS_LABEL,
  STAKE_STATUS_BADGE,
  STAKE_STATUS_OPTIONS,
  type StakeStatus,
  type CoordinateType,
} from '@/types/database'
import { STAKE_TYPE_OPTIONS } from '@/lib/stakeTypes'

// 「その他」は DB 上の category 値ではなく、遠景/近景以外をまとめて表示する論理カテゴリ。
const PRIMARY_CATEGORIES = ['遠景', '近景'] as const
const OTHER_CATEGORY_LABEL = 'その他'

export function CoordinatePhotoPanel({
  open,
  onToggle,
  projectId,
  coordinateId,
  pointNumber,
  coordinate,
  typeOptions,
}: {
  open: boolean
  onToggle: () => void
  projectId: string | null
  coordinateId: string | null
  pointNumber: string | null
  /** 選択中の座標行 (存在すれば X/Y/Z / 点種 / 設置 / 備考 をパネル上部に表示) */
  coordinate?: CoordinateRow | null
  /** 点種の選択肢 (code + label)。編集用 select のオプションに使う */
  typeOptions?: { code: string; label: string }[]
}) {
  const {
    byEntity,
    fetchByEntity,
    uploadPhoto,
    removeAttachment,
    updateAttachment,
    getSignedUrl,
  } = useAttachmentStore()
  const [uploadingFor, setUploadingFor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const pickerInputRef = useRef<HTMLInputElement>(null)
  const pendingCategoryRef = useRef<string | null>(null)
  const pendingReplaceIdRef = useRef<string | null>(null)
  const [editingQueue, setEditingQueue] = useState<
    { file: File; category: string; replacingId?: string }[]
  >([])
  const editingFile = editingQueue[0] ?? null
  const remainingCount = editingQueue.length
  const [customMode, setCustomMode] = useState(false)
  const [customName, setCustomName] = useState('')

  useEffect(() => {
    if (open && coordinateId) {
      void fetchByEntity('coordinate', coordinateId)
    }
  }, [open, coordinateId, fetchByEntity])

  const photos = coordinateId
    ? byEntity.get(`coordinate:${coordinateId}`) ?? []
    : []

  // 遠景 / 近景 と「それ以外」に振り分ける。
  const grouped = useMemo(() => {
    const farView: Attachment[] = []
    const nearView: Attachment[] = []
    const others: Attachment[] = []
    for (const p of photos) {
      const cat = p.category ?? ''
      if (cat === '遠景') farView.push(p)
      else if (cat === '近景') nearView.push(p)
      else others.push(p)
    }
    return { 遠景: farView, 近景: nearView, [OTHER_CATEGORY_LABEL]: others } as Record<
      string,
      Attachment[]
    >
  }, [photos])

  const handleCaptureClick = (category: string) => {
    pendingCategoryRef.current = category
    pendingReplaceIdRef.current = null
    cameraInputRef.current?.click()
  }

  const handlePickClick = (category: string) => {
    pendingCategoryRef.current = category
    pendingReplaceIdRef.current = null
    pickerInputRef.current?.click()
  }

  const handleReplaceClick = (category: string, attachmentId: string) => {
    pendingCategoryRef.current = category
    pendingReplaceIdRef.current = attachmentId
    cameraInputRef.current?.click()
  }

  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    const cat = pendingCategoryRef.current
    if (files.length === 0 || !cat) return
    const replacingId = pendingReplaceIdRef.current ?? undefined
    const targetFiles = replacingId ? files.slice(0, 1) : files
    const items = targetFiles.map((f) => ({
      file: f,
      category: cat,
      replacingId,
    }))
    setEditingQueue((prev) => [...prev, ...items])
    pendingCategoryRef.current = null
    pendingReplaceIdRef.current = null
  }

  const handleEditConfirmed = async (
    blob: Blob,
    _fileName: string,
    meta: PhotoEditMeta,
  ) => {
    const cur = editingQueue[0]
    if (!cur || !projectId || !coordinateId) return
    const cat = cur.category
    const replacingId = cur.replacingId
    setEditingQueue((prev) => prev.slice(1))
    setUploadingFor(cat)
    setError(null)
    try {
      const saved = await uploadPhoto({
        projectId,
        entityType: 'coordinate',
        entityId: coordinateId,
        file: blob,
        category: cat,
        caption: meta.caption,
        takenAt: meta.takenAt ?? new Date(),
        skipResize: true,
      })
      if (!saved) {
        setError('写真の登録に失敗しました')
      } else if (replacingId) {
        await removeAttachment(replacingId)
      }
    } finally {
      setUploadingFor(null)
    }
  }

  const handleEditCancelled = () => {
    setEditingQueue((prev) => prev.slice(1))
  }

  const handleAddCustom = (mode: 'capture' | 'pick') => {
    const name = customName.trim()
    if (!name) return
    if (mode === 'capture') handleCaptureClick(name)
    else handlePickClick(name)
    setCustomMode(false)
    setCustomName('')
  }

  // 折りたたみ時: 右下にコンパクトなタブだけ表示。
  if (!open) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="absolute bottom-2 left-2 z-[1100] flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-300 rounded shadow text-xs font-medium text-slate-700 hover:bg-slate-50"
        title="写真パネルを開く"
      >
        <Camera className="h-3.5 w-3.5 text-blue-600" />
        写真
        {coordinateId && photos.length > 0 && (
          <span className="text-[10px] text-slate-500">({photos.length})</span>
        )}
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
    )
  }

  // 展開時: 地図の下半分を覆う。
  return (
    <>
      <div className="absolute left-0 right-0 bottom-0 h-1/2 z-[1100] bg-white border-t border-slate-300 shadow-lg flex flex-col">
        <div className="px-3 py-1.5 border-b bg-slate-50 flex items-center gap-2">
          <Camera className="h-4 w-4 text-blue-600" />
          <span className="text-sm font-semibold">写真</span>
          {pointNumber ? (
            <span className="text-xs text-slate-500">点 {pointNumber}</span>
          ) : (
            <span className="text-xs text-slate-400">行を選択してください</span>
          )}
          {uploadingFor && (
            <span className="ml-2 text-xs text-blue-700 flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              {uploadingFor} アップロード中…
            </span>
          )}
          {error && (
            <span className="ml-2 text-xs text-red-600">{error}</span>
          )}
          <button
            type="button"
            onClick={onToggle}
            className="ml-auto p-1 text-slate-500 hover:text-slate-800 rounded"
            title="閉じる"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>

        {!coordinateId ? (
          <div className="flex-1 flex items-center justify-center text-sm text-slate-400">
            表または地図で測点を選択すると、ここに写真が表示されます
          </div>
        ) : (
          <div className="flex-1 overflow-auto p-3 flex flex-col gap-2">
            {/* 点の詳細情報 (座標 X/Y/Z / 点種 / 設置 / 備考)。
                X/Y/Z 以外は編集可能で store 経由で保存 (点種は pendingChanges、
                設置は即時 DB 反映)。 */}
            {coordinate && (
              <CoordinateInfoStrip
                coordinate={coordinate}
                typeOptions={typeOptions ?? []}
              />
            )}
            {/* 遠景 / 近景 / その他 を横並びで表示。各カラムは縦方向にスクロールする。 */}
            <div className="grid grid-cols-3 gap-3 flex-1 min-h-0">
              {PRIMARY_CATEGORIES.map((category) => (
                <PrimaryColumn
                  key={category}
                  category={category}
                  list={grouped[category] ?? []}
                  isUploading={uploadingFor === category}
                  getSignedUrl={getSignedUrl}
                  onCapture={() => handleCaptureClick(category)}
                  onPick={() => handlePickClick(category)}
                  onReplace={(id) => handleReplaceClick(category, id)}
                  onDelete={(id) => {
                    if (confirm('この写真を削除しますか？')) {
                      void removeAttachment(id)
                    }
                  }}
                  onUpdate={(id, patch) => updateAttachment(id, patch)}
                />
              ))}
              <OtherColumn
                photos={grouped[OTHER_CATEGORY_LABEL] ?? []}
                uploadingFor={uploadingFor}
                getSignedUrl={getSignedUrl}
                customMode={customMode}
                customName={customName}
                onCustomModeChange={setCustomMode}
                onCustomNameChange={setCustomName}
                onAddCustom={handleAddCustom}
                onDelete={(id) => {
                  if (confirm('この写真を削除しますか？')) {
                    void removeAttachment(id)
                  }
                }}
                onUpdate={(id, patch) => updateAttachment(id, patch)}
              />
            </div>
          </div>
        )}

        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleFileSelected}
          className="hidden"
        />
        <input
          ref={pickerInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleFileSelected}
          className="hidden"
        />
      </div>

      {editingFile && (
        <PhotoEditModal
          file={editingFile.file}
          onCancel={handleEditCancelled}
          onConfirm={handleEditConfirmed}
          headerNote={
            remainingCount > 1
              ? `残り ${remainingCount} 枚 — ${editingFile.category}`
              : editingFile.category
          }
        />
      )}
    </>
  )
}

/** パネル上部の座標情報ストリップ。
 *  スマホ版 (MobileStakingPage) の「点情報モーダル」相当を PC 用に横並びで表示。
 *  X / Y / Z は編集不可 (テーブル側で編集)。それ以外 (点種 / 杭種 / 設置 / 備考)
 *  は座標ストア経由で編集可。 */
function CoordinateInfoStrip({
  coordinate,
  typeOptions,
}: {
  coordinate: CoordinateRow
  typeOptions: { code: string; label: string }[]
}) {
  const setCoordinateType = useCoordinateStore((s) => s.setCoordinateType)
  const setStakeStatus = useCoordinateStore((s) => s.setStakeStatus)
  const updateCoordinate = useCoordinateStore((s) => s.updateCoordinate)

  // 備考 / 杭種はローカル編集して blur で確定 (テーブル側と同じ挙動)
  const [notesDraft, setNotesDraft] = useState<string>(coordinate.notes ?? '')
  const [stakeTypeDraft, setStakeTypeDraft] = useState<string>(
    coordinate.stakeType ?? '',
  )
  // 座標行が変わったら draft をリセット
  useEffect(() => {
    setNotesDraft(coordinate.notes ?? '')
    setStakeTypeDraft(coordinate.stakeType ?? '')
  }, [coordinate.id, coordinate.notes, coordinate.stakeType])

  const stakeTypeListId = `stake-type-options-info-strip-${coordinate.id}`
  const statusBadge = STAKE_STATUS_BADGE[coordinate.stakeStatus]

  return (
    <div className="flex-shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5 bg-slate-50 border border-slate-200 rounded text-xs">
      {/* X / Y / Z (読取専用) */}
      <div className="font-mono">
        <span className="text-[10px] text-slate-500 mr-1">X</span>
        <span className="text-slate-800">{coordinate.x.toFixed(3)}</span>
      </div>
      <div className="font-mono">
        <span className="text-[10px] text-slate-500 mr-1">Y</span>
        <span className="text-slate-800">{coordinate.y.toFixed(3)}</span>
      </div>
      <div className="font-mono">
        <span className="text-[10px] text-slate-500 mr-1">Z</span>
        <span className="text-slate-800">
          {coordinate.z != null ? coordinate.z.toFixed(3) : '-'}
        </span>
      </div>
      {/* 点種 (select、選択直後に即時保存) */}
      <label className="flex items-center gap-1">
        <span className="text-[10px] text-slate-500">点種</span>
        <select
          value={coordinate.type}
          onChange={(e) =>
            void setCoordinateType(
              coordinate.id,
              e.target.value as CoordinateType,
            )
          }
          className="px-1.5 py-0.5 text-xs border rounded bg-white"
        >
          {typeOptions.length === 0 && (
            <option value={coordinate.type}>{coordinate.type}</option>
          )}
          {typeOptions.map((o) => (
            <option key={o.code} value={o.code}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {/* 杭種 (自由入力 + プリセット候補、blur で保存) */}
      <label className="flex items-center gap-1">
        <span className="text-[10px] text-slate-500">杭種</span>
        <input
          type="text"
          list={stakeTypeListId}
          value={stakeTypeDraft}
          onChange={(e) => setStakeTypeDraft(e.target.value)}
          onBlur={() => {
            const v = stakeTypeDraft.trim()
            if (v !== (coordinate.stakeType ?? '')) {
              updateCoordinate(
                coordinate.id,
                'stakeType',
                v === '' ? null : v,
              )
            }
          }}
          placeholder="(任意)"
          className="px-1.5 py-0.5 text-xs border rounded bg-white w-24"
        />
        <datalist id={stakeTypeListId}>
          {STAKE_TYPE_OPTIONS.map((o) => (
            <option key={o.label} value={o.label} />
          ))}
        </datalist>
      </label>
      {/* 設置状態 (即時 DB 反映)。バッジ色を select 背景に反映 */}
      <label className="flex items-center gap-1">
        <span className="text-[10px] text-slate-500">設置</span>
        <select
          value={coordinate.stakeStatus}
          onChange={(e) =>
            void setStakeStatus(coordinate.id, e.target.value as StakeStatus)
          }
          className={`px-1.5 py-0.5 text-xs border rounded font-medium ${statusBadge}`}
        >
          {STAKE_STATUS_OPTIONS.map((s) => (
            <option key={s} value={s} className="bg-white text-slate-900">
              {STAKE_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      {/* 備考 (blur で pendingChanges に積む → 保存ボタン待ち) */}
      <label className="flex items-center gap-1 flex-1 min-w-[160px]">
        <span className="text-[10px] text-slate-500 flex-shrink-0">備考</span>
        <input
          type="text"
          value={notesDraft}
          onChange={(e) => setNotesDraft(e.target.value)}
          onBlur={() => {
            if (notesDraft !== (coordinate.notes ?? '')) {
              updateCoordinate(
                coordinate.id,
                'notes',
                notesDraft === '' ? null : notesDraft,
              )
            }
          }}
          placeholder="(任意)"
          className="flex-1 px-1.5 py-0.5 text-xs border rounded bg-white"
        />
      </label>
    </div>
  )
}

function PrimaryColumn({
  category,
  list,
  isUploading,
  getSignedUrl,
  onCapture,
  onPick,
  onReplace,
  onDelete,
  onUpdate,
}: {
  category: string
  list: Attachment[]
  isUploading: boolean
  getSignedUrl: (path: string) => Promise<string | null>
  onCapture: () => void
  onPick: () => void
  onReplace: (id: string) => void
  onDelete: (id: string) => void
  onUpdate: (id: string, patch: { takenAt: Date | null; caption: string | null }) => void
}) {
  const hasPhoto = list.length > 0
  return (
    <section className="border rounded-lg p-2 flex flex-col min-h-0 bg-white">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold">
          {category}
          <span className="ml-1 text-xs text-slate-400">{list.length}</span>
        </h4>
      </div>
      <div className="flex-1 overflow-auto space-y-2">
        {list.map((p) => (
          <PhotoTileWithMeta
            key={p.id}
            attachment={p}
            getSignedUrl={getSignedUrl}
            onDelete={() => onDelete(p.id)}
            onReplace={() => onReplace(p.id)}
            onUpdate={(patch) => onUpdate(p.id, patch)}
          />
        ))}
        {!hasPhoto && (
          <AddPhotoTile
            isUploading={isUploading}
            onCapture={onCapture}
            onPick={onPick}
          />
        )}
      </div>
    </section>
  )
}

function OtherColumn({
  photos,
  uploadingFor,
  getSignedUrl,
  customMode,
  customName,
  onCustomModeChange,
  onCustomNameChange,
  onAddCustom,
  onDelete,
  onUpdate,
}: {
  photos: Attachment[]
  uploadingFor: string | null
  getSignedUrl: (path: string) => Promise<string | null>
  customMode: boolean
  customName: string
  onCustomModeChange: (v: boolean) => void
  onCustomNameChange: (v: string) => void
  onAddCustom: (mode: 'capture' | 'pick') => void
  onDelete: (id: string) => void
  onUpdate: (id: string, patch: { takenAt: Date | null; caption: string | null }) => void
}) {
  // 「その他」配下のカテゴリ別グルーピング（未分類は「（未分類）」表記）
  const subGroups = useMemo(() => {
    const m = new Map<string, Attachment[]>()
    for (const p of photos) {
      const key = p.category ?? '（未分類）'
      if (!m.has(key)) m.set(key, [])
      m.get(key)!.push(p)
    }
    return m
  }, [photos])

  return (
    <section className="border rounded-lg p-2 flex flex-col min-h-0 bg-white">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold">
          {OTHER_CATEGORY_LABEL}
          <span className="ml-1 text-xs text-slate-400">{photos.length}</span>
        </h4>
      </div>
      <div className="flex-1 overflow-auto space-y-3">
        {Array.from(subGroups.entries()).map(([cat, list]) => (
          <div key={cat}>
            <div className="text-xs font-medium text-slate-600 mb-1">
              {cat}
              <span className="ml-1 text-slate-400">{list.length}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {list.map((p) => (
                <PhotoTileWithMeta
                  key={p.id}
                  attachment={p}
                  getSignedUrl={getSignedUrl}
                  onDelete={() => onDelete(p.id)}
                  onUpdate={(patch) => onUpdate(p.id, patch)}
                />
              ))}
            </div>
          </div>
        ))}
        {/* 任意ラベル追加フォーム */}
        <div className="border border-dashed rounded p-2">
          {customMode ? (
            <div className="space-y-1.5">
              <input
                type="text"
                autoFocus
                value={customName}
                onChange={(e) => onCustomNameChange(e.target.value)}
                placeholder="ラベル名（例: 施工状況）"
                className="w-full px-2 py-1 border rounded text-xs"
              />
              <div className="flex gap-1">
                <button
                  onClick={() => onAddCustom('capture')}
                  disabled={!customName.trim() || !!uploadingFor}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  <Camera className="h-3 w-3" />
                  撮影
                </button>
                <button
                  onClick={() => onAddCustom('pick')}
                  disabled={!customName.trim() || !!uploadingFor}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs border border-blue-600 text-blue-700 rounded hover:bg-blue-50 disabled:opacity-50"
                >
                  <ImageIcon className="h-3 w-3" />
                  選択
                </button>
                <button
                  onClick={() => {
                    onCustomModeChange(false)
                    onCustomNameChange('')
                  }}
                  className="px-2 py-1 text-xs border rounded hover:bg-slate-50"
                  title="キャンセル"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => onCustomModeChange(true)}
              className="w-full text-xs text-blue-600 hover:text-blue-800 flex items-center justify-center gap-1 py-1"
            >
              <Plus className="h-3.5 w-3.5" />
              ラベルを指定して追加
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

function AddPhotoTile({
  onCapture,
  onPick,
  isUploading,
}: {
  onCapture: () => void
  onPick: () => void
  isUploading: boolean
}) {
  if (isUploading) {
    return (
      <div className="w-full aspect-square border-2 border-dashed border-blue-300 rounded bg-blue-50/40 flex items-center justify-center text-blue-500">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      <button
        onClick={onCapture}
        className="aspect-square border-2 border-dashed border-blue-300 rounded bg-blue-50/40 hover:bg-blue-50 active:bg-blue-100 flex flex-col items-center justify-center gap-1 text-blue-600 hover:text-blue-700 transition-colors"
        title="撮影"
      >
        <Camera className="h-6 w-6 stroke-[1.5]" />
        <span className="text-[10px] font-medium">撮影</span>
      </button>
      <button
        onClick={onPick}
        className="aspect-square border-2 border-dashed border-blue-300 rounded bg-blue-50/40 hover:bg-blue-50 active:bg-blue-100 flex flex-col items-center justify-center gap-1 text-blue-600 hover:text-blue-700 transition-colors"
        title="画像から選択"
      >
        <ImageIcon className="h-6 w-6 stroke-[1.5]" />
        <span className="text-[10px] font-medium">選択</span>
      </button>
    </div>
  )
}

