import { Link, Outlet } from 'react-router-dom'

export function AppLayout() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-4">
          <Link to="/" className="text-lg font-bold tracking-tight text-slate-900">
            DuoFocus
          </Link>
        </div>
        </header>
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 py-10">
        <Outlet />
      </main>
      <footer className="border-t border-slate-200">
        <div className="mx-auto w-full max-w-5xl px-6 py-4 text-center text-xs text-slate-500">
          Study together. Stay focused.
        </div>
      </footer>
    </div>
  )
}
