// ヘッダーから運営者にメールで意見・要望を送るボタン + モーダル。
// PC（AppLayout）とモバイル各ページのヘッダー両方から共通で使う想定。
//
// - 添付画像は送信前に長辺 1600px / JPEG80% にリサイズしてから base64 化（Edge Function 側で 25MB まで）。
// - 認証必須。supabase.functions.invoke が JWT を自動付与する。
//
// バックエンド: supabase/functions/send-feedback

import { useRef, useState } from 'react'
import { Mail, Loader2, X, Image as ImageIcon, Trash2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { resizeImage } from '@/lib/imageResize'

interface PreparedAttachment {
  id: string
  filename: string
  mime: string
  // 表示用の data URL（送信時に base64 部だけ抜く）
  dataUrl: string
}

type Variant = 'pc' | 'mobile'

// 一時的に UI から隠す（モーダル本体・Edge Function はそのまま残しているので
// このフラグを true に戻すだけで全ヘッダーに復活する）。
const FEEDBACK_BUTTON_VISIBLE = false

export function FeedbackButton({ variant = 'pc' }: { variant?: Variant }) {
  const [open, setOpen] = useState(false)
  if (!FEEDBACK_BUTTON_VISIBLE) return null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="意見・要望を送る"
        className={
          variant === 'pc'
            ? 'flex items-center gap-2 px-3 py-1.5 text-sm text-slate-300 hover:text-white hover:bg-slate-800 rounded transition-colors'
            : 'flex items-center gap-1 px-2 py-1 text-xs rounded border border-slate-500 hover:bg-slate-700'
        }
      >
        <Mail className={variant === 'pc' ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
        {variant === 'pc' && '意見・要望'}
      </button>
      {open && <FeedbackModal onClose={() => setOpen(false)} />}
    </>
  )
}

function FeedbackModal({ onClose }: { onClose: () => void }) {
  const [message, setMessage] = useState('')
  const [attachments, setAttachments] = useState<PreparedAttachment[]>([])
  const [preparing, setPreparing] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handlePickFiles = () => fileInputRef.current?.click()

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return
    setError(null)
    setPreparing(true)
    try {
      const next: PreparedAttachment[] = []
      for (const f of files) {
        if (!f.type.startsWith('image/')) {
          // 画像以外はスキップ（複数選択時に1つだけ非画像が混ざっても他は処理する）
          continue
        }
        const { blob, mime } = await resizeImage(f, { maxSize: 1600, quality: 0.8 })
        const dataUrl = await blobToDataUrl(blob)
        next.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          filename: f.name.replace(/\.[^.]+$/, '') + '.jpg',
          mime,
          dataUrl,
        })
      }
      setAttachments((prev) => [...prev, ...next])
    } catch (err) {
      setError(err instanceof Error ? err.message : '画像の準備に失敗しました')
    } finally {
      setPreparing(false)
    }
  }

  const handleRemoveAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  const handleSend = async () => {
    const text = message.trim()
    if (!text) {
      setError('本文を入力してください')
      return
    }
    setError(null)
    setSending(true)
    try {
      const { error: invokeError } = await supabase.functions.invoke('send-feedback', {
        body: {
          message: text,
          attachments: attachments.map((a) => ({
            filename: a.filename,
            content: a.dataUrl, // data URL のまま渡し、関数側で base64 部を抽出
            mime: a.mime,
          })),
          userAgent: navigator.userAgent,
          pageUrl: window.location.href,
        },
      })
      if (invokeError) throw invokeError
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信に失敗しました')
    } finally {
      setSending(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[10000] p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center gap-2">
          <Mail className="h-5 w-5 text-blue-600" />
          <h3 className="flex-1 text-base font-semibold">意見・要望を送る</h3>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-700 rounded"
            title="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {done ? (
          <div className="p-6 text-center space-y-3">
            <div className="text-green-600 text-sm font-medium">送信しました。ありがとうございます。</div>
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              閉じる
            </button>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-auto p-4 space-y-3">
              <div>
                <label className="block text-xs text-slate-600 mb-1">本文</label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={6}
                  maxLength={10000}
                  placeholder="気になった点や追加してほしい機能などを自由にお書きください。"
                  className="w-full px-2 py-1.5 text-sm border rounded resize-y"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-slate-600">画像添付（任意 / 複数可）</label>
                  <button
                    type="button"
                    onClick={handlePickFiles}
                    disabled={preparing || sending}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50"
                  >
                    {preparing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ImageIcon className="h-3.5 w-3.5" />
                    )}
                    画像を追加
                  </button>
                </div>
                {attachments.length > 0 && (
                  <div className="grid grid-cols-3 gap-2">
                    {attachments.map((a) => (
                      <div key={a.id} className="relative group">
                        <img
                          src={a.dataUrl}
                          alt={a.filename}
                          className="w-full aspect-square object-cover rounded border"
                        />
                        <button
                          onClick={() => handleRemoveAttachment(a.id)}
                          className="absolute top-1 right-1 p-1 bg-white/90 text-red-600 rounded shadow opacity-0 group-hover:opacity-100 hover:bg-white"
                          title="この画像を外す"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {error && (
                <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">
                  {error}
                </div>
              )}
            </div>

            <div className="px-4 py-3 border-t flex justify-end gap-2">
              <button
                onClick={onClose}
                disabled={sending}
                className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                onClick={handleSend}
                disabled={sending || preparing || !message.trim()}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {sending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                送信
              </button>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleFilesSelected}
              className="hidden"
            />
          </>
        )}
      </div>
    </div>
  )
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'))
    reader.readAsDataURL(blob)
  })
}
