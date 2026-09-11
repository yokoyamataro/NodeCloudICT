import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from '@/lib/supabase'
import type { User, Session } from '@supabase/supabase-js'

interface AuthProfile {
  full_name: string | null
  organization_id: string | null
}

interface AuthContextType {
  user: User | null
  session: Session | null
  loading: boolean
  profile: AuthProfile | null
  /** 表示用の名前。profiles.full_name があればそれ、無ければメールアドレス */
  displayName: string
  /** ログイン中ユーザーが所属する組織名 (無所属 or 取得中は null) */
  organizationName: string | null
  /** ログイン中ユーザーが 1 つ以上の組織の管理者 (organization_members.role='admin') か */
  isOrgAdmin: boolean
  signIn: (email: string, password: string) => Promise<void>
  /** メールに Magic Link を送る。既存ユーザーはリンククリックで自動ログイン、
   *  未登録ユーザーは shouldCreateUser=false で拒否 (勝手にアカウントが
   *  作られない)。リダイレクト先はサイト URL のルート。 */
  sendMagicLink: (email: string) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [profile, setProfile] = useState<AuthProfile | null>(null)
  const [organizationName, setOrganizationName] = useState<string | null>(null)
  const [isOrgAdmin, setIsOrgAdmin] = useState<boolean>(false)

  useEffect(() => {
    // 初期セッション取得
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setUser(session?.user ?? null)
      setLoading(false)
    })

    // 認証状態の変更を監視
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(session)
        setUser(session?.user ?? null)
        setLoading(false)
      }
    )

    return () => subscription.unsubscribe()
  }, [])

  // 「最終利用」 の 記録。
  //
  // auth.users.last_sign_in_at は サインイン処理 の ときだけ 動く。
  // セッション は 自動で リフレッシュ される ので、毎日 使って いても
  // 何週間 も 前の 日付 の まま に なり、稼働状況 が 読めない。
  // 自前で profiles.last_seen_at を 打つ (端末側でも 1 時間 に 1 回 に 間引く)。
  useEffect(() => {
    if (!user) return
    const KEY = `lastSeenTouchedAt:${user.id}`
    // サーバ側 も 10 分 以内 の 再呼び出し は 無視 する ので 同じ 間隔 に する。
    // 「時刻」 まで 見せる ので、開きっぱなし でも 10 分 ごと に 追従 させる。
    const INTERVAL = 10 * 60 * 1000
    const touch = () => {
      try {
        const prev = Number(localStorage.getItem(KEY) ?? '0')
        if (Date.now() - prev < INTERVAL) return
        localStorage.setItem(KEY, String(Date.now()))
      } catch {
        /* localStorage が 使えなくても 打つ */
      }
      void (supabase.rpc as unknown as (fn: string) => Promise<unknown>)('touch_last_seen').catch(
        () => {
          /* 記録できなくても 利用には 影響しない */
        },
      )
    }
    touch()
    const timer = window.setInterval(touch, INTERVAL)
    // 別タブ / バックグラウンド から 戻った ときも 打つ
    const onVisible = () => {
      if (document.visibilityState === 'visible') touch()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [user])

  // ログイン中ユーザーの profile + 所属組織を取得
  useEffect(() => {
    if (!user) {
      setProfile(null)
      setOrganizationName(null)
      setIsOrgAdmin(false)
      return
    }
    let cancelled = false
    ;(async () => {
      const { data: profileRow } = await supabase
        .from('profiles')
        .select('user_id, full_name, organization_id')
        .eq('user_id', user.id)
        .maybeSingle<{
          user_id: string
          full_name: string | null
          organization_id: string | null
        }>()
      if (cancelled) return
      const nextProfile: AuthProfile = {
        full_name: profileRow?.full_name ?? null,
        organization_id: profileRow?.organization_id ?? null,
      }
      setProfile(nextProfile)

      if (nextProfile.organization_id) {
        const { data: orgRow } = await supabase
          .from('organizations')
          .select('name')
          .eq('id', nextProfile.organization_id)
          .maybeSingle<{ name: string }>()
        if (cancelled) return
        setOrganizationName(orgRow?.name ?? null)
      } else {
        setOrganizationName(null)
      }

      // 組織 admin 判定は organization_members から取る。1 個以上あれば admin。
      // (旧: organizations.admin_user_id との一致判定は複数管理者対応後は不十分)
      const { data: adminOrgs } = (await supabase.rpc(
        'list_my_admin_org_ids' as never,
      )) as unknown as {
        data: Array<{ organization_id: string }> | null
        error: unknown
      }
      if (cancelled) return
      setIsOrgAdmin(Array.isArray(adminOrgs) && adminOrgs.length > 0)
    })()
    return () => {
      cancelled = true
    }
  }, [user])

  const displayName = profile?.full_name?.trim() || user?.email || ''

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })
    if (error) throw error
  }

  const sendMagicLink = async (email: string) => {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        // 未登録メールでは Magic Link 発行時にサイレントで新規ユーザー登録
        // されないようにする (招待フローを通した人だけログインさせるため)
        shouldCreateUser: false,
        // クリック後に戻ってくる URL。onAuthStateChange が拾って自動ログイン
        emailRedirectTo:
          typeof window !== 'undefined' ? `${window.location.origin}/` : undefined,
      },
    })
    if (error) throw error
  }

  const signOut = async () => {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        loading,
        profile,
        displayName,
        organizationName,
        isOrgAdmin,
        signIn,
        sendMagicLink,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
