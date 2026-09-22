# Changelog

All notable changes to DuoFocus are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com) and the project adheres to [Semantic Versioning](https://semver.org).

## [Unreleased]

### Planned (later phases — not implemented)

- Authentication via Firebase
- Private two-person study rooms
- Synchronized focus timer
- Study session statistics

## [0.1.0] - 2026-09-22

### Added

- React 18 + Vite 5 + TypeScript frontend scaffold with dev server on `localhost:5173`
- FastAPI backend with `GET /health` endpoint returning `{"status": "ok", "service": "duofocus-api"}`
- Auto-generated Swagger documentation at `/docs`
- Root `.gitignore` covering Python venvs, Node modules, builds, and env files
- Project README with setup instructions, architecture overview, and roadmap
- MIT License
