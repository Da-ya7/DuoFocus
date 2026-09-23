import React, { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { getFriendlyAuthErrorMessage } from '../utils/authErrors'

export function RegisterPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const { register } = useAuth()
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)

    const trimmedEmail = email.trim()
    if (!trimmedEmail) {
      setError('Please enter your email address.')
      return
    }

    if (!password) {
      setError('Please enter a password.')
      return
    }

    if (!confirmPassword) {
      setError('Please confirm your password.')
      return
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setIsSubmitting(true)
    try {
      await register(trimmedEmail, password)
      navigate('/app', { replace: true })
    } catch (err) {
      setError(getFriendlyAuthErrorMessage(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <section className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-12">
      <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Create an account</h1>
          <p className="mt-1 text-sm text-slate-600">Start studying together with your accountability partner</p>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-6 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          >
            {error}
          </div>
        )}

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
              autoComplete="new-password"
              required
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 disabled:opacity-50"
              placeholder="••••••••"
            />
          </div>

          <div>
            <label htmlFor="confirmPassword" className="block text-sm font-medium text-slate-700">
              Confirm password
            </label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={isSubmitting}
              autoComplete="new-password"
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
            {isSubmitting ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <div className="mt-6 text-center text-sm text-slate-600">
          Already have an account?{' '}
          <Link to="/login" className="font-semibold text-slate-900 hover:underline">
            Login
          </Link>
        </div>
      </div>
    </section>
  )
}
