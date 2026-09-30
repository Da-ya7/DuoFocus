import React, { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import {
  getFriendlyAuthErrorMessage,
  getFriendlyPasswordResetErrorMessage,
} from '../utils/authErrors'

/**
 * Minimal shape gate shared by the login and password-reset forms (Phase
 * 11.20): an email must be non-empty and look like local@domain.tld. Firebase
 * remains the authority on deliverability — the reset flow maps its
 * auth/invalid-email rejection through the friendly error utility.
 */
function isValidEmailFormat(value: string): boolean {
  const [local, domain, ...extra] = value.split('@')
  return local.length > 0 && !!domain && extra.length === 0 && domain.includes('.')
}

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [resetSent, setResetSent] = useState(false)
  const [mode, setMode] = useState<'login' | 'reset'>('login')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const { login, resetPassword } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const from = (location.state as { from?: { pathname?: string } })?.from?.pathname || '/app'

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)

    const trimmedEmail = email.trim()
    if (!isValidEmailFormat(trimmedEmail)) {
      setError(
        trimmedEmail
          ? 'Please enter a valid email address.'
          : 'Please enter your email address.',
      )
      return
    }

    if (!password) {
      setError('Please enter your password.')
      return
    }

    setIsSubmitting(true)
    try {
      await login(trimmedEmail, password)
      navigate(from, { replace: true })
    } catch (err) {
      setError(getFriendlyAuthErrorMessage(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleResetSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    setResetSent(false)

    const trimmedEmail = email.trim()
    if (!isValidEmailFormat(trimmedEmail)) {
      setError(
        trimmedEmail
          ? 'Please enter a valid email address.'
          : 'Please enter your email address.',
      )
      return
    }

    setIsSubmitting(true)
    try {
      await resetPassword(trimmedEmail)
      setResetSent(true)
    } catch (err) {
      setError(getFriendlyPasswordResetErrorMessage(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  const showLogin = () => {
    setMode('login')
    setError(null)
    setResetSent(false)
  }

  return (
    <section className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-12">
      <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Sign in to DuoFocus</h1>
          <p className="mt-1 text-sm text-slate-600">Enter your credentials to access your account</p>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-6 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          >
            {error}
          </div>
        )}

        {mode === 'reset' ? (
          resetSent ? (
            <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              Password reset email sent. Check your inbox.
            </div>
          ) : (
            <form onSubmit={handleResetSubmit} className="space-y-4" noValidate>
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-slate-700">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={isSubmitting}
                  autoComplete="email"
                  required
                  className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 disabled:opacity-50"
                  placeholder="name@example.com"
                />
              </div>
              <button
                type="submit"
                disabled={isSubmitting}
                className="mt-2 flex w-full justify-center rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? 'Sending reset link…' : 'Send reset link'}
              </button>
            </form>
          )
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-700">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isSubmitting}
                autoComplete="email"
                required
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 disabled:opacity-50"
                placeholder="name@example.com"
              />
            </div>
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-700">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isSubmitting}
                autoComplete="current-password"
                required
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 disabled:opacity-50"
                placeholder="••••••••"
              />
            </div>
            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-2 flex w-full justify-center rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? 'Signing in…' : 'Login'}
            </button>
          </form>
        )}

        {mode === 'login' ? (
          <button
            type="button"
            onClick={() => {
              setMode('reset')
              setError(null)
              setResetSent(false)
            }}
            className="mt-4 text-sm font-semibold text-slate-900 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
          >
            Forgot password?
          </button>
        ) : (
          <button
            type="button"
            onClick={showLogin}
            className="mt-4 text-sm font-semibold text-slate-900 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
          >
            Return to Login
          </button>
        )}

        <div className="mt-6 text-center text-sm text-slate-600">
          Don't have an account?{' '}
          <Link to="/register" className="font-semibold text-slate-900 hover:underline">
            Create account
          </Link>
        </div>
      </div>
    </section>
  )
}
