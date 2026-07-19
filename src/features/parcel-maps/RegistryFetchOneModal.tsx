// 1 地番分の「登記取得」モーダル (site owner 限定、Phase 1)。
//
// UI: 所在 / 地番の確認 + 都道府県 select + 市町村 input + 種別 (所有者事項 / 全部事項)
// prefecture / city は farmId 単位で localStorage に前回値を残す (2 回目以降プリフィル)。
// 種別は所有者事項をデフォルト (安いほう)。
// 送信時に Edge Function `fetch-registry-pdfs` を叩き、成功したら onDone を呼ぶ。

import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2, X } from 'lucide-react'
import {
  fetchRegistryPdfs,
  type RegistryKind,
} from './registryFetchClient'

// #fuTodofukenShozai の value と同じ 47 コード
const PREFECTURES: Array<{ code: string; name: string }> = [
  { code: '01', name: '北海道' },
  { code: '02', name: '青森県' }, { code: '03', name: '岩手県' },
  { code: '04', name: '宮城県' }, { code: '05', name: '秋田県' },
  { code: '06', name: '山形県' }, { code: '07', name: '福島県' },
  { code: '08', name: '茨城県' }, { code: '09', name: '栃木県' },
  { code: '10', name: '群馬県' }, { code: '11', name: '埼玉県' },
  { code: '12', name: '千葉県' }, { code: '13', name: '東京都' },
  { code: '14', name: '神奈川県' }, { code: '15', name: '新潟県' },
  { code: '16', name: '富山県' }, { code: '17', name: '石川県' },
  { code: '18', name: '福井県' }, { code: '19', name: '山梨県' },
  { code: '20', name: '長野県' }, { code: '21', name: '岐阜県' },
  { code: '22', name: '静岡県' }, { code: '23', name: '愛知県' },
  { code: '24', name: '三重県' }, { code: '25', name: '滋賀県' },
  { code: '26', name: '京都府' }, { code: '27', name: '大阪府' },
  { code: '28', name: '兵庫県' }, { code: '29', name: '奈良県' },
  { code: '30', name: '和歌山県' }, { code: '31', name: '鳥取県' },
  { code: '32', name: '島根県' }, { code: '33', name: '岡山県' },
  { code: '34', name: '広島県' }, { code: '35', name: '山口県' },
  { code: '36', name: '徳島県' }, { code: '37', name: '香川県' },
  { code: '38', name: '愛媛県' }, { code: '39', name: '高知県' },
  { code: '40', name: '福岡県' }, { code: '41', name: '佐賀県' },
  { code: '42', name: '長崎県' }, { code: '43', name: '熊本県' },
  { code: '44', name: '大分県' }, { code: '45', name: '宮崎県' },
  { code: '46', name: '鹿児島県' }, { code: '47', name: '沖縄県' },
]

interface Props {
  workAreaId: string
  parcelNumber: string
  /** parcels.location (字名。例: 「青葉町」) */
  location: string
  /** parcels.prefecture (取込時 or 前回モーダル入力で既に埋まっていれば渡す) */
  initialPrefecture?: string | null
  /** parcels.municipality (取込時 or 前回モーダル入力で既に埋まっていれば渡す) */
  initialCity?: string | null
  /** farm.id (localStorage キー用) */
  farmId: string
  onClose: () => void
  /** 成功時: 呼び出し側で attachments 再取得等をトリガする */
  onDone: (result: {
    attachmentId: string
    signedUrl: string | null
    kind: RegistryKind
    /** 取得に使った prefecture / municipality (呼び出し側で parcels に upsert したい) */
    prefecture: string
    municipality: string
  }) => void
}

const LS_PREFIX = 'registry:place:'

/** サーバから返ってきた技術的エラー文字列を、UI 表示用に日本語で整える。 */
function friendlyError(raw: string): string {
  if (/service_hours_out/.test(raw)) {
    return (
      '登記情報提供サービスは現在利用時間外です。\n' +
      '利用可能時間: 平日 8:30-21:00 / 土日 8:30-17:00 (JST)\n' +
      '(参考: ' + raw + ')'
    )
  }
  if (/maintenance/.test(raw)) {
    return (
      '登記情報提供サービスがメンテナンス中です。しばらく待って再度お試しください。\n' +
      '(参考: ' + raw + ')'
    )
  }
  if (/unavailable/.test(raw)) {
    return (
      '登記情報提供サービスが利用できない状態です。\n' +
      '(参考: ' + raw + ')'
    )
  }
  if (/login_failed/.test(raw)) {
    return (
      '登記情報提供サービスへのログインに失敗しました。\n' +
      '設定 → 登記情報 で ID / パスワードを再確認してください。\n' +
      '(参考: ' + raw + ')'
    )
  }
  return raw
}

interface Persisted {
  prefecture?: string
  city?: string
}

function loadPersisted(farmId: string): Persisted {
  try {
    const raw = localStorage.getItem(LS_PREFIX + farmId)
    return raw ? (JSON.parse(raw) as Persisted) : {}
  } catch {
    return {}
  }
}

function savePersisted(farmId: string, p: Persisted): void {
  try {
    localStorage.setItem(LS_PREFIX + farmId, JSON.stringify(p))
  } catch {
    /* ignore */
  }
}

export function RegistryFetchOneModal({
  workAreaId,
  parcelNumber,
  location,
  initialPrefecture,
  initialCity,
  farmId,
  onClose,
  onDone,
}: Props) {
  const persisted = loadPersisted(farmId)
  // 優先順位: parcels の値 > localStorage > デフォルト
  const [prefecture, setPrefecture] = useState(
    initialPrefecture ?? persisted.prefecture ?? '北海道',
  )
  const [city, setCity] = useState(initialCity ?? persisted.city ?? '')
  const [kind, setKind] = useState<RegistryKind>('ownership')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // localStorage に prefecture / city を保存 (submit 前でも入力中に随時)
  useEffect(() => {
    savePersisted(farmId, { prefecture, city })
  }, [farmId, prefecture, city])

  const cost = kind === 'ownership' ? '¥140' : '¥334'

  const handleSubmit = async () => {
    setError(null)
    if (!city.trim()) {
      setError('市町村を入力してください (例: 斜里郡斜里町)')
      return
    }
    setBusy(true)
    try {
      const res = await fetchRegistryPdfs(
        [
          {
            work_area_id: workAreaId,
            prefecture,
            city: city.trim(),
            location,
            parcel_number: parcelNumber,
          },
        ],
        kind,
      )
      if (!res.ok) {
        setError(res.error ?? '取得に失敗しました')
        return
      }
      const item = res.results?.[0]
      if (!item) {
        setError('結果が空です')
        return
      }
      if (item.error) {
        setError(friendlyError(item.error))
        return
      }
      if (!item.attachment_id) {
        setError('attachment_id が返りませんでした')
        return
      }
      onDone({
        attachmentId: item.attachment_id,
        signedUrl: item.signed_url,
        kind,
        prefecture,
        municipality: city.trim(),
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[3000] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <div className="px-4 py-2 border-b flex items-center justify-between">
          <span className="text-sm font-semibold">登記情報を取得</span>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-slate-400 hover:text-slate-700 disabled:opacity-50"
            title="閉じる"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div className="text-xs text-slate-600 bg-slate-50 border rounded p-2">
            <div>所在: <b>{location || '(未設定)'}</b></div>
            <div>地番: <b>{parcelNumber}</b></div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              都道府県 *
            </label>
            <select
              value={prefecture}
              onChange={(e) => setPrefecture(e.target.value)}
              disabled={busy}
              className="w-full px-2 py-1.5 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {PREFECTURES.map((p) => (
                <option key={p.code} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              市町村 * <span className="text-slate-400">(例: 斜里郡斜里町)</span>
            </label>
            <input
              type="text"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              disabled={busy}
              placeholder="斜里郡斜里町"
              className="w-full px-2 py-1.5 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <div className="text-xs font-medium text-slate-600 mb-1">証明書種別</div>
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="kind"
                  value="ownership"
                  checked={kind === 'ownership'}
                  onChange={() => setKind('ownership')}
                  disabled={busy}
                />
                所有者事項 (¥140)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="kind"
                  value="full"
                  checked={kind === 'full'}
                  onChange={() => setKind('full')}
                  disabled={busy}
                />
                全部事項証明書 (¥334)
              </label>
            </div>
          </div>

          <div className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            <span>
              「取得」を押すと touki.or.jp の残高から <b>{cost}</b> が引き落とされます。
              重複請求の場合も同額が発生します。
            </span>
          </div>

          {error && (
            <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              <span className="break-all">{error}</span>
            </div>
          )}
        </div>
        <div className="px-4 py-2 border-t flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={busy || !city.trim()}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {busy ? '取得中…' : `取得 (${cost})`}
          </button>
        </div>
      </div>
    </div>
  )
}
