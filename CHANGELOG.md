# Changelog

All notable changes to DuoFocus are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com) and the project adheres to [Semantic Versioning](https://semver.org).

## [Unreleased]

### Changed

- **Firebase-first consolidation (Phase 9.2)**: removed the unused FastAPI backend and the dead frontend API service (`api.ts`, `getIdToken`, `VITE_API_BASE_URL`). DuoFocus is React + Firebase Authentication + Cloud Firestore + Firestore Security Rules — no custom server. Repository cleaned of backend documentation, scripts, and environment references.

### Planned (later phases — not implemented)

- Production deployment pipeline (hosting + rules deployment automation)
- Error reporting / monitoring

## [0.1.0] - 2026-09-22

### Added

- React 18 + Vite 5 + TypeScript frontend scaffold with dev server on `localhost:5173`
- Root `.gitignore` covering Python venvs, Node modules, builds, and env files
- Project README with setup instructions, architecture overview, and roadmap
- MIT License
