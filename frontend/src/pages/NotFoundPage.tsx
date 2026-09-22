import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-4 py-16 text-center">
      <p className="text-6xl font-bold tracking-tight text-slate-900">404</p>
      <p className="text-lg text-slate-600">Page not found.</p>
      <Link
        to="/"
        className="mt-4 rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-700"
      >
        Go Home
      </Link>
    </section>
  )
}
