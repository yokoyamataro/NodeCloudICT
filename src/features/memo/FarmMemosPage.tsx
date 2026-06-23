// 工区メモ一覧ページ。
// 現工区のメモを新しい順に並べる。新規作成 / 編集 / 削除、写真の追加と
// 位置情報があれば「地図で見る」リンクで地図ページにジャンプする。

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plus,
  Loader2,
  Trash2,
  Pencil,
  Camera,
  MapPin,
  Compass,
  Save,
  X,
  StickyNote,
} from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { useFarmStore } from '@/stores/farmStore'
import { useFarmMemoStore, EMPTY_FARM_MEMOS, type FarmMemo } from '@/stores/farmMemoStore'
import { useAttachmentStore } from '@/stores/attachmentStore'
import { MemoPhotoModal } from './MemoPhotoModal'

function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function fmtCompass(deg: number | null): string {
  if (deg == null) return '—'
  const dirs = ['北', '北東', '東', '南東', '南', '南西', '西', '北西']
  const idx = Math.round(((deg % 360) / 45)) % 8
  return `${deg.toFixed(0)}° (${dirs[idx]})`
}

export function FarmMemosPage() {
  const navigate = useNavigate()
  const { currentFarm } = useFarmStore()
  const farmId = currentFarm?.id ?? null
  const projectId = currentFarm?.project_id ?? null

  const memos = useFarmMemoStore((s) =>
    farmId ? s.byFarm.get(farmId) ?? EMPTY_FARM_MEMOS : EMPTY_FARM_MEMOS,
  )
  const loading = useFarmMemoStore((s) => s.loading)
  const fetchByFarm = useFarmMemoStore((s) => s.fetchByFarm)
  const createMemo = useFarmMemoStore((s) => s.createMemo)
  const updateMemo = useFarmMemoStore((s) => s.updateMemo)
  const deleteMemo = useFarmMemoStore((s) => s.deleteMemo)
  const error = useFarmMemoStore((s) => s.error)

  const attachmentsByEntity = useAttachmentStore((s) => s.byEntity)
  const fetchAttachments = useAttachmentStore((s) => s.fetchByEntityIds)

  const [showNewModal, setShowNewModal] = useState(false)
  const [editingMemo, setEditingMemo] = useState<FarmMemo | null>(null)
  const [photoMemoId, setPhotoMemoId] = useState<string | null>(null)

  useEffect(() => {
    if (farmId) void fetchByFarm(farmId)
  }, [farmId, fetchByFarm])

  // メモが揃ったら写真の件数も一括取得（カウント表示用）
  useEffect(() => {
    if (memos.length === 0) return
    void fetchAttachments('farm_memo', memos.map((m) => m.id))
  }, [memos, fetchAttachments])

  const photoCountByMemoId = useMemo(() => {
    const m = new Map<string, number>()
    for (const memo of memos) {
      const list = attachmentsByEntity.get(`farm_memo:${memo.id}`) ?? []
      m.set(memo.id, list.length)
    }
    return m
  }, [memos, attachmentsByEntity])

  const handleDelete = async (memo: FarmMemo) => {
    if (!confirm('このメモを削除しますか？（紐づいた写真も合わせて消えます）')) return
    await deleteMemo(memo.id)
  }

  if (!farmId) {
    return (
      <div className="h-full flex flex-col">
        <PageHeader title="メモ" subtitle="工区を選択してください" />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="メモ"
        subtitle="現場で気付いたことを位置・方向・写真と一緒に残せます"
        actions={
          <button
            onClick={() => setShowNewModal(true)}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            <Plus className="h-3.5 w-3.5" />
            メモを追加
          </button>
        }
      />

      {error && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4 space-y-2">
        {loading && memos.length === 0 ? (
          <div className="flex items-center justify-center text-slate-500 text-sm py-8">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            読み込み中…
          </div>
        ) : memos.length === 0 ? (
          <div className="text-center py-12 text-sm text-slate-400 border border-dashed rounded">
            まだメモはありません。
          </div>
        ) : (
          memos.map((memo) => (
            <MemoCard
              key={memo.id}
              memo={memo}
              photoCount={photoCountByMemoId.get(memo.id) ?? 0}
              onEdit={() => setEditingMemo(memo)}
              onDelete={() => handleDelete(memo)}
              onOpenPhotos={() => setPhotoMemoId(memo.id)}
              onLocate={
                memo.lat != null && memo.lng != null
                  ? () => navigate('/coordinates')
                  : null
              }
            />
          ))
        )}
      </div>

      {showNewModal && (
        <MemoEditModal
          mode="create"
          initial={null}
          onClose={() => setShowNewModal(false)}
          onSave={async (data) => {
            await createMemo(farmId, data)
            setShowNewModal(false)
          }}
        />
      )}

      {editingMemo && (
        <MemoEditModal
          mode="edit"
          initial={editingMemo}
          onClose={() => setEditingMemo(null)}
          onSave={async (data) => {
            await updateMemo(editingMemo.id, data)
            setEditingMemo(null)
          }}
        />
      )}

      {photoMemoId && projectId && (
        <MemoPhotoModal
          open={!!photoMemoId}
          onClose={() => setPhotoMemoId(null)}
          projectId={projectId}
          memoId={photoMemoId}
        />
      )}
    </div>
  )
}

function MemoCard({
  memo,
  photoCount,
  onEdit,
  onDelete,
  onOpenPhotos,
  onLocate,
}: {
  memo: FarmMemo
  photoCount: number
  onEdit: () => void
  onDelete: () => void
  onOpenPhotos: () => void
  onLocate: (() => void) | null
}) {
  return (
    <div className="bg-white border rounded-lg p-3 hover:shadow-sm transition-shadow">
      <div className="flex items-start gap-2 mb-2">
        <StickyNote className="h-4 w-4 text-amber-500 mt-0.5" />
        <div className="flex-1 text-xs text-slate-500">
          {fmtDateTime(memo.createdAt)}
        </div>
        <button
          onClick={onEdit}
          className="p-1 text-slate-400 hover:text-blue-600 rounded"
          title="編集"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onOpenPhotos}
          className="flex items-center gap-1 p-1 text-slate-400 hover:text-blue-600 rounded"
          title="写真を追加/閲覧"
        >
          <Camera className="h-3.5 w-3.5" />
          {photoCount > 0 && <span className="text-[10px]">{photoCount}</span>}
        </button>
        <button
          onClick={onDelete}
          className="p-1 text-slate-400 hover:text-red-500 rounded"
          title="削除"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="text-sm text-slate-800 whitespace-pre-wrap mb-2">
        {memo.content || <span className="text-slate-400">(本文なし)</span>}
      </div>
      {(memo.lat != null || memo.headingDeg != null) && (
        <div className="flex items-center gap-3 text-[11px] text-slate-500">
          {memo.lat != null && memo.lng != null && (
            <button
              onClick={onLocate ?? undefined}
              disabled={!onLocate}
              className="inline-flex items-center gap-1 hover:text-blue-600 disabled:hover:text-slate-500"
              title="地図で見る"
            >
              <MapPin className="h-3 w-3" />
              {memo.lat.toFixed(6)}, {memo.lng.toFixed(6)}
            </button>
          )}
          {memo.headingDeg != null && (
            <span className="inline-flex items-center gap-1">
              <Compass className="h-3 w-3" />
              {fmtCompass(memo.headingDeg)}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function MemoEditModal({
  mode,
  initial,
  onClose,
  onSave,
}: {
  mode: 'create' | 'edit'
  initial: FarmMemo | null
  onClose: () => void
  onSave: (data: {
    content: string
    lat: number | null
    lng: number | null
    headingDeg: number | null
  }) => Promise<void>
}) {
  const [content, setContent] = useState(initial?.content ?? '')
  const [lat, setLat] = useState(initial?.lat?.toString() ?? '')
  const [lng, setLng] = useState(initial?.lng?.toString() ?? '')
  const [heading, setHeading] = useState(initial?.headingDeg?.toString() ?? '')
  const [busy, setBusy] = useState(false)

  // PC でも現在地が拾えれば自動入力する。失敗（権限なし等）はサイレントに無視。
  const fillCurrentLocation = () => {
    if (!('geolocation' in navigator)) return
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude.toFixed(6))
        setLng(pos.coords.longitude.toFixed(6))
        if (pos.coords.heading != null && !Number.isNaN(pos.coords.heading)) {
          setHeading(pos.coords.heading.toFixed(0))
        }
      },
      () => {},
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    )
  }

  const save = async () => {
    setBusy(true)
    try {
      const latN = lat.trim() === '' ? null : parseFloat(lat)
      const lngN = lng.trim() === '' ? null : parseFloat(lng)
      const headN = heading.trim() === '' ? null : parseFloat(heading)
      await onSave({
        content,
        lat: latN === null || Number.isNaN(latN) ? null : latN,
        lng: lngN === null || Number.isNaN(lngN) ? null : lngN,
        headingDeg: headN === null || Number.isNaN(headN) ? null : headN,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b flex items-center gap-2">
          <StickyNote className="h-4 w-4 text-amber-500" />
          <h3 className="flex-1 text-base font-semibold">{mode === 'create' ? 'メモを追加' : 'メモを編集'}</h3>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700 rounded">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-slate-600">本文</span>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={5}
              className="px-2 py-1.5 text-sm border rounded"
              placeholder="現場で気付いたことを書いてください"
            />
          </label>

          <div className="border rounded p-3 bg-slate-50">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-slate-600">位置情報（任意）</span>
              <button
                type="button"
                onClick={fillCurrentLocation}
                className="text-xs text-blue-600 hover:text-blue-800"
              >
                現在地を取得
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <label className="flex flex-col gap-1 text-[10px] text-slate-500">
                緯度
                <input
                  type="text"
                  inputMode="decimal"
                  value={lat}
                  onChange={(e) => setLat(e.target.value)}
                  placeholder="35.0000"
                  className="px-1.5 py-1 text-xs border rounded"
                />
              </label>
              <label className="flex flex-col gap-1 text-[10px] text-slate-500">
                経度
                <input
                  type="text"
                  inputMode="decimal"
                  value={lng}
                  onChange={(e) => setLng(e.target.value)}
                  placeholder="139.0000"
                  className="px-1.5 py-1 text-xs border rounded"
                />
              </label>
              <label className="flex flex-col gap-1 text-[10px] text-slate-500">
                方向 (°)
                <input
                  type="text"
                  inputMode="decimal"
                  value={heading}
                  onChange={(e) => setHeading(e.target.value)}
                  placeholder="0..360"
                  className="px-1.5 py-1 text-xs border rounded"
                />
              </label>
            </div>
          </div>
        </div>

        <div className="px-4 py-3 border-t flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
