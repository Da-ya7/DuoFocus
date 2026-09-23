import { Route, Routes } from 'react-router-dom'
import { AppLayout } from '../layouts/AppLayout'
import { HomePage } from '../pages/HomePage'
import { LoginPage } from '../pages/LoginPage'
import { RegisterPage } from '../pages/RegisterPage'
import { AppHomePage } from '../pages/AppHomePage'
import { NotFoundPage } from '../pages/NotFoundPage'
import { ProtectedRoute } from './ProtectedRoute'

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/app" element={<ProtectedRoute />}>
          <Route index element={<AppHomePage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
