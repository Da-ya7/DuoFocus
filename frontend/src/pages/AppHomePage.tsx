import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export function AppHomePage() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  const handleLogout = async () => {
    try {
      await logout()
      navigate('/login', { replace: true })
    } catch {
      // In unlikely event logout fails, attempt navigation anyway
      navigate('/login', { replace: true })
    }
  }

  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-6 py-16 text-center">
      <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm max-w-md w-full">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">Welcome to DuoFocus</h1>
        
        <div className="mt-4 rounded-lg bg-slate-50 p-4 border border-slate-200">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">You are signed in as</p>
          <p className="mt-1 text-sm font-medium text-slate-800 break-all">{user?.email ?? 'Unknown User'}</p>
        </div>

        <button
          type="button"
          onClick={handleLogout}
          className="mt-6 w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
        >
          Logout
        </button>
      </div>
    </section>
  )
}
