import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode; title?: string }
type State = { error: Error | null }

/**
 * Without this, any render-time exception unmounts the whole app to a blank white page. In a
 * money-handling system the operator's first reaction to a blank page is that the balances are
 * gone, so the failure is named and bounded instead.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled UI error:', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <div className="card">
          <h1 className="text-xl font-bold text-navy">{this.props.title ?? 'Something went wrong'}</h1>
          <p className="mt-2 text-sm text-slate-600">
            This screen could not be displayed. Nothing you have submitted has been lost — but if
            you were in the middle of entering something, re-open the page and check before
            resubmitting, so nothing is recorded twice.
          </p>
          <p className="mt-3 rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-600">{error.message}</p>
          <div className="mt-4 flex gap-2">
            <button className="btn-blue" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            {/* Not '/' — on a sub-path deploy like /ogeseous-microfinance/ that leaves the app
                entirely and lands on the host's directory listing. */}
            <button className="btn-outline" onClick={() => window.location.assign(import.meta.env.BASE_URL)}>
              Go home
            </button>
          </div>
        </div>
      </div>
    )
  }
}
