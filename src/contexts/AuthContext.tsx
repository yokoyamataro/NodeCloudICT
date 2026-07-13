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
  /** ログイン中ユーザーが所属組織の管理者 (organizations.admin_user_id) か */
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

      if (!nextProfile.organization_id) {
        setOrganizationName(null)
        setIsOrgAdmin(false)
        return
      }
      const { data: orgRow } = await supabase
        .from('organizations')
        .select('name, admin_user_id')
        .eq('id', nextProfile.organization_id)
        .maybeSingle<{ name: string; admin_user_id: string | null }>()
      if (cancelled) return
      setOrganizationName(orgRow?.name ?? null)
      setIsOrgAdmin(orgRow?.admin_user_id === user.id)
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
