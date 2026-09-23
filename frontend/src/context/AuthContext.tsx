import React, { createContext, useContext, useEffect, useState } from 'react'
import {
  User,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
} from 'firebase/auth'
import { auth, getIdToken } from '../services/firebase'

export interface AuthContextType {
  user: User | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  getIdToken: (forceRefresh?: boolean) => Promise<string | null>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState<boolean>(true)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser)
      setLoading(false)
    })

    return () => unsubscribe()
  }, [])

  const login = async (email: string, password: string): Promise<void> => {
    await signInWithEmailAndPassword(auth, email, password)
  }

  const register = async (email: string, password: string): Promise<void> => {
    await createUserWithEmailAndPassword(auth, email, password)
  }

  const logout = async (): Promise<void> => {
    await signOut(auth)
  }

  const value: AuthContextType = {
    user,
    loading,
    login,
    register,
    logout,
    getIdToken,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
