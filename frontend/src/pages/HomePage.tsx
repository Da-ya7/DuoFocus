import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export function HomePage() {
  const { user, loading } = useAuth()

  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-6 py-16 text-center">
      <h1 className="text-4xl font-bold tracking-tight text-slate-900">DuoFocus</h1>
      <p className="max-w-md text-lg text-slate-600">
        Study together.
        <br />
        Stay focused.
      </p>

      {!loading && (
        <div className="mt-4 flex items-center gap-4">
          {user ? (
            <Link
              to="/app"
              className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
            >
              Go to App
            </Link>
          ) : (
            <>
              <Link
                to="/login"
                className="rounded-lg border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
              >
                Login
              </Link>
              <Link
                to="/register"
                className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800"
              >
                Create account
              </Link>
            </>
          )}
        </div>
      )}
    </section>
  )
}
