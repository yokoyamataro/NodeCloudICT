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
  Replace,
  Trash2,
  X,
} from 'lucide-react'
import { useAttachmentStore, type Attachment } from '@/stores/attachmentStore'
import { PhotoEditModal } from './PhotoEditModal'

// 「その他」は DB 上の category 値ではなく、遠景/近景以外をまとめて表示する論理カテゴリ。
const PRIMARY_CATEGORIES = ['遠景', '近景'] as const
const OTHER_CATEGORY_LABEL = 'その他'

export function CoordinatePhotoPanel({
  open,
  onToggle,
  projectId,
  coordinateId,
  pointNumber,
}: {
  open: boolean
  onToggle: () => void
  projectId: string | null
  coordinateId: string | null
  pointNumber: string | null
}) {
  const {
    byEntity,
    fetchByEntity,
    uploadPhoto,
    removeAttachment,
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

  const handleEditConfirmed = async (blob: Blob, _fileName: string) => {
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
        takenAt: new Date(),
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
        className="absolute bottom-2 right-2 z-[1100] flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-300 rounded shadow text-xs font-medium text-slate-700 hover:bg-slate-50"
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
          <div className="flex-1 overflow-auto p-3">
            {/* 遠景 / 近景 / その他 を横並びで表示。各カラムは縦方向にスクロールする。 */}
            <div className="grid grid-cols-3 gap-3 h-full">
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

function PrimaryColumn({
  category,
  list,
  isUploading,
  getSignedUrl,
  onCapture,
  onPick,
  onReplace,
  onDelete,
}: {
  category: string
  list: Attachment[]
  isUploading: boolean
  getSignedUrl: (path: string) => Promise<string | null>
  onCapture: () => void
  onPick: () => void
  onReplace: (id: string) => void
  onDelete: (id: string) => void
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
          <PhotoTile
            key={p.id}
            attachment={p}
            getSignedUrl={getSignedUrl}
            onDelete={() => onDelete(p.id)}
            onReplace={() => onReplace(p.id)}
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
                <PhotoTile
                  key={p.id}
                  attachment={p}
                  getSignedUrl={getSignedUrl}
                  onDelete={() => onDelete(p.id)}
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

function PhotoTile({
  attachment,
  getSignedUrl,
  onDelete,
  onReplace,
}: {
  attachment: Attachment
  getSignedUrl: (path: string) => Promise<string | null>
  onDelete: () => void
  onReplace?: () => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    getSignedUrl(attachment.filePath).then((u) => {
      if (!cancelled) setUrl(u)
    })
    return () => {
      cancelled = true
    }
  }, [attachment.filePath, getSignedUrl])
  return (
    <div className="relative group">
      <a href={url ?? '#'} target="_blank" rel="noreferrer">
        {url ? (
          <img
            src={url}
            alt={attachment.caption ?? attachment.category ?? ''}
            className="w-full aspect-square object-cover rounded border"
          />
        ) : (
          <div className="w-full aspect-square bg-slate-100 rounded border flex items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
          </div>
        )}
      </a>
      <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition">
        {onReplace && (
          <button
            onClick={onReplace}
            className="p-1 bg-white/90 text-blue-600 rounded shadow hover:bg-white"
            title="差し替え"
          >
            <Replace className="h-3 w-3" />
          </button>
        )}
        <button
          onClick={onDelete}
          className="p-1 bg-white/90 text-red-600 rounded shadow hover:bg-white"
          title="削除"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  )
}
