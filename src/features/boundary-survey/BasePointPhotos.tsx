// 09 基本三角点等 / 補助基準点 / 恒久的地物 の 行に紐づく 写真サムネイル。
//   * coordinateId が null なら 何も表示しない
//   * attachments (entity_type='coordinate', entity_id=coordinateId) を取得
//   * 各写真は 40x40 のサムネイルで表示、クリックで 別タブに 拡大表示
//   * Excel 転記は 後続タスク

import { useEffect, useMemo, useState } from 'react'
import { Image as ImageIcon, Loader2 } from 'lucide-react'
import { useAttachmentStore, type Attachment } from '@/stores/attachmentStore'

const entityKey = (entityType: string, entityId: string) => `${entityType}:${entityId}`

interface Props {
  coordinateId: string | null
}

export function BasePointPhotos({ coordinateId }: Props) {
  const byEntity = useAttachmentStore((s) => s.byEntity)
  const fetchByEntity = useAttachmentStore((s) => s.fetchByEntity)
  const getSignedUrl = useAttachmentStore((s) => s.getSignedUrl)
  const [urls, setUrls] = useState<Map<string, string>>(new Map())
  const [loadingUrls, setLoadingUrls] = useState(false)

  const attachments: Attachment[] = useMemo(() => {
    if (!coordinateId) return []
    return byEntity.get(entityKey('coordinate', coordinateId)) ?? []
  }, [byEntity, coordinateId])

  // 未取得なら fetch
  useEffect(() => {
    if (!coordinateId) return
    const key = entityKey('coordinate', coordinateId)
    if (!byEntity.has(key)) {
      void fetchByEntity('coordinate', coordinateId)
    }
  }, [coordinateId, byEntity, fetchByEntity])

  // signed URL を取得
  useEffect(() => {
    if (attachments.length === 0) return
    let cancelled = false
    ;(async () => {
      setLoadingUrls(true)
      const next = new Map(urls)
      for (const a of attachments) {
        if (!next.has(a.filePath)) {
          const url = await getSignedUrl(a.filePath)
          if (cancelled) return
          if (url) next.set(a.filePath, url)
        }
      }
      if (!cancelled) {
        setUrls(next)
        setLoadingUrls(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachments])

  if (!coordinateId) return <span className="text-[10px] text-slate-400">—</span>
  if (attachments.length === 0) {
    return <span className="text-[10px] text-slate-400">写真なし</span>
  }

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {attachments.map((a) => {
        const url = urls.get(a.filePath)
        return (
          <a
            key={a.id}
            href={url ?? '#'}
            target="_blank"
            rel="noopener noreferrer"
            title={a.category || a.caption || ''}
            className="block w-8 h-8 border rounded overflow-hidden bg-slate-100 hover:opacity-80"
            onClick={(e) => {
              if (!url) e.preventDefault()
            }}
          >
            {url ? (
              <img
                src={url}
                alt={a.category ?? ''}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                {loadingUrls ? (
                  <Loader2 className="h-3 w-3 animate-spin text-slate-400" />
                ) : (
                  <ImageIcon className="h-3 w-3 text-slate-400" />
                )}
              </div>
            )}
          </a>
        )
      })}
    </div>
  )
}
