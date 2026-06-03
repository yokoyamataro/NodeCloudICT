// 座標管理: 各測点の写真一覧モーダル
// PC から写真の追加・閲覧・削除ができる。
// 既定で「遠景」「近景」のスロットがあり、任意のラベルでも追加可能。

import { useEffect, useMemo, useRef, useState } from 'react'
import { Camera, Loader2, Trash2, Plus, X, Replace } from 'lucide-react'
import { useAttachmentStore, type Attachment } from '@/stores/attachmentStore'
import { PhotoEditModal } from './PhotoEditModal'

const DEFAULT_CATEGORIES = ['遠景', '近景'] as const

export function CoordinatePhotoModal({
  open,
  onClose,
  projectId,
  coordinateId,
  pointNumber,
}: {
  open: boolean
  onClose: () => void
  projectId: string
  coordinateId: string
  pointNumber: string
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
  const [customMode, setCustomMode] = useState(false)
  const [customName, setCustomName] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingCategoryRef = useRef<string | null>(null)
  // 差し替え対象の attachment.id（アップロード成功後に削除する）
  const pendingReplaceIdRef = useRef<string | null>(null)
  // 編集対象（選択直後にここに入れて、編集モーダルで回転/トリミングしてからアップロードする）
  const [editingFile, setEditingFile] = useState<
    { file: File; category: string; replacingId?: string } | null
  >(null)

  useEffect(() => {
    if (open && coordinateId) {
      fetchByEntity('coordinate', coordinateId)
    }
  }, [open, coordinateId, fetchByEntity])

  const photos = byEntity.get(`coordinate:${coordinateId}`) ?? []

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

  const handleUploadClick = (category: string) => {
    pendingCategoryRef.current = category
    pendingReplaceIdRef.current = null
    fileInputRef.current?.click()
  }

  const handleReplaceClick = (category: string, attachmentId: string) => {
    pendingCategoryRef.current = category
    pendingReplaceIdRef.current = attachmentId
    fileInputRef.current?.click()
  }

  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    const cat = pendingCategoryRef.current
    if (!file || !cat) return
    // 回転 / トリミング編集モーダルを開く
    setEditingFile({
      file,
      category: cat,
      replacingId: pendingReplaceIdRef.current ?? undefined,
    })
    pendingCategoryRef.current = null
    pendingReplaceIdRef.current = null
  }

  // 編集モーダル確定後にアップロード（編集時点で 1600px / JPEG80% に縮小済みなので再エンコードしない）
  const handleEditConfirmed = async (blob: Blob, _fileName: string) => {
    if (!editingFile) return
    const cat = editingFile.category
    const replacingId = editingFile.replacingId
    setEditingFile(null)
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
        // 新規アップロード成功後に旧写真を削除（失敗してもユーザーは新規分は確認できる）
        await removeAttachment(replacingId)
      }
    } finally {
      setUploadingFor(null)
    }
  }

  const handleAddCustom = () => {
    const name = customName.trim()
    if (!name) return
    handleUploadClick(name)
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
            <h3 className="text-base font-semibold">写真</h3>
            <div className="text-xs text-slate-500">点 {pointNumber}</div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-700 rounded"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <div className="px-3 py-2 bg-red-50 text-xs text-red-600 border-b">
            {error}
          </div>
        )}
        {uploadingFor && (
          <div className="px-3 py-2 bg-blue-50 text-xs text-blue-700 border-b flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {uploadingFor} の写真をアップロード中…（しばらくお待ちください）
          </div>
        )}

        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* 既定カテゴリ（遠景・近景）は 2 列で横並び表示 */}
          <div className="grid grid-cols-2 gap-3">
            {DEFAULT_CATEGORIES.map((category) => {
              const list = grouped.get(category) ?? []
              const isUploading = uploadingFor === category
              // 遠景・近景は通常 1 枚なので、すでに登録済みなら追加ボタンは出さず
              // タイル側の「差し替え」ボタンで置き換える運用にする。
              const hasPhoto = list.length > 0
              return (
                <section key={category} className="border rounded-lg p-2 flex flex-col">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-semibold">
                      {category}
                      <span className="ml-1 text-xs text-slate-400">
                        {list.length}
                      </span>
                    </h4>
                  </div>
                  <div className="space-y-2">
                    {list.map((p) => (
                      <PhotoTile
                        key={p.id}
                        attachment={p}
                        getSignedUrl={getSignedUrl}
                        onDelete={() => {
                          if (confirm('この写真を削除しますか？')) {
                            removeAttachment(p.id)
                          }
                        }}
                        onReplace={() => handleReplaceClick(category, p.id)}
                      />
                    ))}
                    {!hasPhoto && (
                      <AddPhotoTile
                        isUploading={isUploading}
                        onClick={() => handleUploadClick(category)}
                      />
                    )}
                  </div>
                </section>
              )
            })}
          </div>

          {/* カスタムカテゴリ（任意ラベル）は全幅で 2 列グリッド表示 */}
          {Array.from(grouped.entries())
            .filter(([category]) => !(DEFAULT_CATEGORIES as readonly string[]).includes(category))
            .map(([category, list]) => {
              const isUploading = uploadingFor === category
              return (
                <section key={category} className="border rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-semibold">
                      {category}
                      <span className="ml-2 text-xs text-slate-400">
                        {list.length} 枚
                      </span>
                    </h4>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {list.map((p) => (
                      <PhotoTile
                        key={p.id}
                        attachment={p}
                        getSignedUrl={getSignedUrl}
                        onDelete={() => {
                          if (confirm('この写真を削除しますか？')) {
                            removeAttachment(p.id)
                          }
                        }}
                      />
                    ))}
                    <AddPhotoTile
                      isUploading={isUploading}
                      onClick={() => handleUploadClick(category)}
                    />
                  </div>
                </section>
              )
            })}

          {/* 任意カテゴリ追加 */}
          <section className="border border-dashed rounded-lg p-3">
            {customMode ? (
              <div className="flex gap-2">
                <input
                  type="text"
                  autoFocus
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="カテゴリ名（例: 施工状況）"
                  className="flex-1 px-2 py-1 border rounded text-sm"
                />
                <button
                  onClick={handleAddCustom}
                  disabled={!customName.trim()}
                  className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  撮影 / 選択
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
                任意カテゴリで写真を追加
              </button>
            )}
          </section>
        </div>

        {/*
          capture="environment" を付けると Android Chrome/WebView は
          ファイル選択ではなく直接背面カメラを起動する（iOS Safari も同様）。
          PC ブラウザはこの属性を無視するので従来通りファイル選択が出る。
        */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleFileSelected}
          className="hidden"
        />
      </div>

      {/* 写真編集（回転・トリミング）モーダル */}
      {editingFile && (
        <PhotoEditModal
          file={editingFile.file}
          onCancel={() => setEditingFile(null)}
          onConfirm={handleEditConfirmed}
        />
      )}
    </div>
  )
}

// サムネイル枠と同サイズの「写真追加」ボタン
function AddPhotoTile({
  onClick,
  isUploading,
}: {
  onClick: () => void
  isUploading: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={isUploading}
      className="w-full aspect-square border-2 border-dashed border-blue-300 rounded bg-blue-50/40 hover:bg-blue-50 active:bg-blue-100 disabled:opacity-50 flex items-center justify-center text-blue-500 hover:text-blue-700 transition-colors"
      title="写真を追加"
    >
      {isUploading ? (
        <Loader2 className="h-10 w-10 animate-spin" />
      ) : (
        <Plus className="h-12 w-12 stroke-[1.5]" />
      )}
    </button>
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
