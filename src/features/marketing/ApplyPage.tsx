// 申し込み／問い合わせフォーム（公開・認証不要）。signup_requests に保存。
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, CheckCircle2, ArrowLeft } from 'lucide-react'
import { supabase } from '@/lib/supabase'

interface FormState {
  companyName: string
  contactName: string
  email: string
  phone: string
  userCount: string
  planInterest: string
  message: string
}

const EMPTY: FormState = {
  companyName: '',
  contactName: '',
  email: '',
  phone: '',
  userCount: '',
  planInterest: 'undecided',
  message: '',
}

export function ApplyPage() {
  const [form, setForm] = useState<FormState>(EMPTY)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const update = (k: keyof FormState, v: string) => setForm((p) => ({ ...p, [k]: v }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.companyName.trim() || !form.contactName.trim() || !form.email.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const payload = {
        company_name: form.companyName.trim(),
        contact_name: form.contactName.trim(),
        email: form.email.trim(),
        phone: form.phone.trim() || null,
        user_count: form.userCount ? parseInt(form.userCount, 10) : null,
        plan_interest: form.planInterest,
        message: form.message.trim() || null,
      }
      const { error: insErr } = await (
        supabase.from('signup_requests' as never) as unknown as {
          insert: (p: typeof payload) => Promise<{ error: { message: string } | null }>
        }
      ).insert(payload)
      if (insErr) throw insErr
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信に失敗しました。時間をおいて再度お試しください。')
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100 p-4">
        <div className="bg-white rounded-lg shadow-lg p-8 max-w-md w-full text-center">
          <CheckCircle2 className="h-12 w-12 text-emerald-600 mx-auto mb-3" />
          <h1 className="text-xl font-bold">お申し込みを受け付けました</h1>
          <p className="text-sm text-slate-600 mt-2">
            担当者より、ご記入のメールアドレス宛にご連絡いたします。
            今しばらくお待ちください。
          </p>
          <Link to="/lp" className="inline-block mt-6 text-blue-600 hover:underline text-sm">
            サービス紹介に戻る
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-100 py-8 px-4">
      <div className="max-w-lg mx-auto">
        <Link to="/lp" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900 mb-3">
          <ArrowLeft className="h-4 w-4" /> サービス紹介
        </Link>
        <div className="bg-white rounded-lg shadow-lg p-6">
          <h1 className="text-xl font-bold">お申し込み・お問い合わせ</h1>
          <p className="text-sm text-slate-600 mt-1">
            下記をご記入ください。担当者より折り返しご連絡します（料金・契約のご案内）。
          </p>

          {error && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-600">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-4 space-y-3">
            <Field label="会社名 / 事務所名" required>
              <input
                type="text"
                value={form.companyName}
                onChange={(e) => update('companyName', e.target.value)}
                required
                className="form-input"
              />
            </Field>
            <Field label="ご担当者名" required>
              <input
                type="text"
                value={form.contactName}
                onChange={(e) => update('contactName', e.target.value)}
                required
                className="form-input"
              />
            </Field>
            <Field label="メールアドレス" required>
              <input
                type="email"
                value={form.email}
                onChange={(e) => update('email', e.target.value)}
                required
                className="form-input"
              />
            </Field>
            <Field label="電話番号">
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => update('phone', e.target.value)}
                className="form-input"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="想定利用人数">
                <input
                  type="number"
                  min={1}
                  value={form.userCount}
                  onChange={(e) => update('userCount', e.target.value)}
                  className="form-input"
                  placeholder="例: 3"
                />
              </Field>
              <Field label="ご興味のあるプラン">
                <select
                  value={form.planInterest}
                  onChange={(e) => update('planInterest', e.target.value)}
                  className="form-input"
                >
                  <option value="undecided">未定 / 相談したい</option>
                  <option value="civil">農業土木</option>
                  <option value="boundary">境界測量（不動産・士業）</option>
                </select>
              </Field>
            </div>
            <Field label="ご質問・ご要望">
              <textarea
                value={form.message}
                onChange={(e) => update('message', e.target.value)}
                rows={3}
                className="form-input"
              />
            </Field>

            <button
              type="submit"
              disabled={submitting}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 font-medium"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              送信する
            </button>
          </form>
        </div>
      </div>

      {/* このページ内だけの入力欄スタイル */}
      <style>{`
        .form-input {
          width: 100%;
          padding: 0.5rem 0.75rem;
          border: 1px solid #cbd5e1;
          border-radius: 0.375rem;
          font-size: 0.875rem;
        }
        .form-input:focus { outline: none; box-shadow: 0 0 0 2px #3b82f6; }
      `}</style>
    </div>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-slate-700 mb-1">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </span>
      {children}
    </label>
  )
}
