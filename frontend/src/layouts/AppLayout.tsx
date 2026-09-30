import { useState } from 'react'
import { Link, Outlet } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export function AppLayout() {
  const { user, loading, logout } = useAuth()
  const [logoutState, setLogoutState] = useState<'idle' | 'signing-out' | 'error'>('idle')

  const handleLogout = async () => {
    if (logoutState === 'signing-out') return

    setLogoutState('signing-out')
    try {
      await logout()
    } catch {
      setLogoutState('error')
    }
  }

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
                <div className="flex flex-col items-end gap-1">
                  <button
                    type="button"
                    onClick={handleLogout}
                    disabled={logoutState === 'signing-out'}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {logoutState === 'signing-out' ? 'Signing out…' : 'Logout'}
                  </button>
                  {logoutState === 'error' && (
                    <span role="alert" className="text-right text-xs text-red-700">
                      Couldn't sign out. Please try again.
                    </span>
                  )}
                </div>
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
