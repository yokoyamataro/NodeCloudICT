// アプリ全体をラップする ErrorBoundary。
// 目的:
//   * React 木のどこかで throw された未捕捉エラーを受け止め、真っ白ではなく
//     「再読み込み」ボタン付きの画面を出す。
//   * Vite の動的 import の chunk 404 (デプロイ後の古い hash) は、
//     window.addEventListener('error') 側で 1 回だけ自動リロードするので、
//     ここに到達するのは「本当のロジックバグ」が中心になる想定。
//
// 意図的に外部ライブラリ (react-error-boundary 等) は使わず、依存を増やさない。

import { Component, type ReactNode, type ErrorInfo } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 開発時のデバッグ用。本番ではブラウザコンソールに出るだけ。
    // Sentry 等を入れるならここでキャプチャする。
    console.error('[AppErrorBoundary]', error, info)
  }

  private handleReload = () => {
    // sessionStorage の chunk リロード履歴も消してから再読み込み
    try {
      sessionStorage.removeItem('__chunk_reload__')
    } catch {
      /* ignore */
    }
    window.location.reload()
  }

  private handleGoHome = () => {
    window.location.href = '/'
  }

  render() {
    if (!this.state.error) return this.props.children
    const message = this.state.error.message || String(this.state.error)
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-lg shadow p-6 space-y-4">
          <div className="flex items-center gap-2 text-red-700">
            <AlertTriangle className="h-5 w-5" />
            <h1 className="text-lg font-bold">エラーが発生しました</h1>
          </div>
          <p className="text-sm text-slate-700 leading-relaxed">
            画面の表示中に問題が発生しました。再読み込みで復旧することがあります。
          </p>
          <details className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded p-2">
            <summary className="cursor-pointer">詳細</summary>
            <pre className="mt-2 whitespace-pre-wrap break-all">{message}</pre>
          </details>
          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={this.handleGoHome}
              className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
            >
              トップに戻る
            </button>
            <button
              onClick={this.handleReload}
              className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              <RefreshCw className="h-4 w-4" />
              再読み込み
            </button>
          </div>
        </div>
      </div>
    )
  }
}
