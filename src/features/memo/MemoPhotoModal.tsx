// 工区メモに紐づく写真モーダル。座標写真と同じパイプライン
// (PhotoEditModal + attachmentStore) を流用するが、entity_type は
// 'farm_memo' / entity_id は memo.id を使う。
// 写真種別は「現場」「補足」「その他」の 3 カテゴリ既定で、必要なら
// 任意ラベルでも追加できる。

import { useEffect, useMemo, useRef, useState } from 'react'
import { Camera, Loader2, Plus, X, Image as ImageIcon } from 'lucide-react'
import { useAttachmentStore, type Attachment } from '@/stores/attachmentStore'
import { PhotoEditModal, type PhotoEditMeta } from '@/features/coordinates/PhotoEditModal'
import { PhotoTileWithMeta } from '@/features/coordinates/PhotoTileWithMeta'

const DEFAULT_CATEGORIES = ['現場', '補足'] as const

export function MemoPhotoModal({
  open,
  onClose,
  projectId,
  memoId,
}: {
  open: boolean
  onClose: () => void
  projectId: string
  memoId: string
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
  const [customMode, setCustomMode] = useState(false)
  const [customName, setCustomName] = useState('')
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const pickerInputRef = useRef<HTMLInputElement>(null)
  const pendingCategoryRef = useRef<string | null>(null)
  const pendingReplaceIdRef = useRef<string | null>(null)
  const [editingQueue, setEditingQueue] = useState<
    { file: File; category: string; replacingId?: string }[]
  >([])
  const editingFile = editingQueue[0] ?? null
  const remainingCount = editingQueue.length

  useEffect(() => {
    if (open && memoId) {
      void fetchByEntity('farm_memo', memoId)
    }
  }, [open, memoId, fetchByEntity])

  const photos = byEntity.get(`farm_memo:${memoId}`) ?? []

  const grouped = useMemo(() => {
    const map = new Map<string, Attachment[]>()
    for (const cat of DEFAULT_CATEGORIES) map.set(cat, [])
    for (const p of photos) {
      const k = p.category ?? '（未分類）'
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(p)
    }
    return map
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
    const target = replacingId ? files.slice(0, 1) : files
    setEditingQueue((prev) => [...prev, ...target.map((f) => ({ file: f, category: cat, replacingId }))])
    pendingCategoryRef.current = null
    pendingReplaceIdRef.current = null
  }

  const handleEditConfirmed = async (
    blob: Blob,
    _fileName: string,
    meta: PhotoEditMeta,
  ) => {
    const cur = editingQueue[0]
    if (!cur) return
    const cat = cur.category
    const replacingId = cur.replacingId
    setEditingQueue((prev) => prev.slice(1))
    setUploadingFor(cat)
    setError(null)
    try {
      const saved = await uploadPhoto({
        projectId,
        entityType: 'farm_memo',
        entityId: memoId,
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

  if (!open) return null

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center gap-2">
          <Camera className="h-5 w-5 text-blue-600" />
          <div className="flex-1">
            <h3 className="text-base font-semibold">メモの写真</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-700 rounded"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <div className="px-3 py-2 bg-red-50 text-xs text-red-600 border-b">{error}</div>
        )}
        {uploadingFor && (
          <div className="px-3 py-2 bg-blue-50 text-xs text-blue-700 border-b flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {uploadingFor} の写真をアップロード中…
          </div>
        )}

        <div className="flex-1 overflow-auto p-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {DEFAULT_CATEGORIES.map((category) => {
              const list = grouped.get(category) ?? []
              const isUploading = uploadingFor === category
              const hasPhoto = list.length > 0
              return (
                <section key={category} className="border rounded-lg p-2 flex flex-col">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-semibold">
                      {category}
                      <span className="ml-1 text-xs text-slate-400">{list.length}</span>
                    </h4>
                  </div>
                  <div className="space-y-2">
                    {list.map((p) => (
                      <PhotoTileWithMeta
                        key={p.id}
                        attachment={p}
                        getSignedUrl={getSignedUrl}
                        onDelete={() => {
                          if (confirm('この写真を削除しますか？')) void removeAttachment(p.id)
                        }}
                        onReplace={() => handleReplaceClick(category, p.id)}
                        onUpdate={(patch) => updateAttachment(p.id, patch)}
                      />
                    ))}
                    {!hasPhoto && (
                      <AddPhotoTile
                        isUploading={isUploading}
                        onCapture={() => handleCaptureClick(category)}
                        onPick={() => handlePickClick(category)}
                      />
                    )}
                  </div>
                </section>
              )
            })}
          </div>

          {Array.from(grouped.entries())
            .filter(([category]) => !(DEFAULT_CATEGORIES as readonly string[]).includes(category))
            .map(([category, list]) => {
              const isUploading = uploadingFor === category
              return (
                <section key={category} className="border rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-semibold">
                      {category}
                      <span className="ml-2 text-xs text-slate-400">{list.length} 枚</span>
                    </h4>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {list.map((p) => (
                      <PhotoTileWithMeta
                        key={p.id}
                        attachment={p}
                        getSignedUrl={getSignedUrl}
                        onDelete={() => {
                          if (confirm('この写真を削除しますか？')) void removeAttachment(p.id)
                        }}
                        onUpdate={(patch) => updateAttachment(p.id, patch)}
                      />
                    ))}
                    <div className="col-span-2">
                      <AddPhotoTile
                        isUploading={isUploading}
                        onCapture={() => handleCaptureClick(category)}
                        onPick={() => handlePickClick(category)}
                      />
                    </div>
                  </div>
                </section>
              )
            })}

          <section className="border border-dashed rounded-lg p-3">
            {customMode ? (
              <div className="flex gap-2">
                <input
                  type="text"
                  autoFocus
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="ラベル名（例: 施工状況）"
                  className="flex-1 px-2 py-1 border rounded text-sm"
                />
                <button
                  onClick={() => handleAddCustom('capture')}
                  disabled={!customName.trim()}
                  className="flex items-center gap-1 px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  <Camera className="h-3.5 w-3.5" />
                  撮影
                </button>
                <button
                  onClick={() => handleAddCustom('pick')}
                  disabled={!customName.trim()}
                  className="flex items-center gap-1 px-3 py-1 text-sm border border-blue-600 text-blue-700 rounded hover:bg-blue-50 disabled:opacity-50"
                >
                  <ImageIcon className="h-3.5 w-3.5" />
                  画像から選択
                </button>
                <button
                  onClick={() => {
                    setCustomMode(false)
                    setCustomName('')
                  }}
                  className="px-3 py-1 text-sm border rounded hover:bg-slate-50"
                >
                  キャンセル
                </button>
              </div>
            ) : (
              <button
                onClick={() => setCustomMode(true)}
                className="w-full text-sm text-blue-600 hover:text-blue-800 flex items-center justify-center gap-1"
              >
                <Plus className="h-4 w-4" />
                任意ラベルで写真を追加
              </button>
            )}
          </section>
        </div>

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
    </div>
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
        <Loader2 className="h-10 w-10 animate-spin" />
      </div>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      <button
        onClick={onCapture}
        className="aspect-square border-2 border-dashed border-blue-300 rounded bg-blue-50/40 hover:bg-blue-50 active:bg-blue-100 flex flex-col items-center justify-center gap-1 text-blue-600 hover:text-blue-700 transition-colors"
      >
        <Camera className="h-7 w-7 stroke-[1.5]" />
        <span className="text-xs font-medium">撮影</span>
      </button>
      <button
        onClick={onPick}
        className="aspect-square border-2 border-dashed border-blue-300 rounded bg-blue-50/40 hover:bg-blue-50 active:bg-blue-100 flex flex-col items-center justify-center gap-1 text-blue-600 hover:text-blue-700 transition-colors"
      >
        <ImageIcon className="h-7 w-7 stroke-[1.5]" />
        <span className="text-xs font-medium">画像から選択</span>
      </button>
    </div>
  )
}
