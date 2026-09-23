import { Link, Outlet } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export function AppLayout() {
  const { user, loading, logout } = useAuth()

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-4">
          <Link to="/" className="text-lg font-bold tracking-tight text-slate-900">
            DuoFocus
          </Link>

          <nav className="flex items-center gap-4 text-sm">
            {loading ? null : user ? (
              <>
                <Link
                  to="/app"
                  className="font-medium text-slate-700 hover:text-slate-900"
                >
                  App
                </Link>
                <button
                  type="button"
                  onClick={() => logout()}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Logout
                </button>
              </>
            ) : (
              <>
                <Link
                  to="/login"
                  className="font-medium text-slate-700 hover:text-slate-900"
                >
                  Login
                </Link>
                <Link
                  to="/register"
                  className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-slate-800"
                >
                  Register
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 py-10">
        <Outlet />
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto w-full max-w-5xl px-6 py-4 text-center text-xs text-slate-500">
          Study together. Stay focused.
        </div>
      </footer>
    </div>
  )
}
