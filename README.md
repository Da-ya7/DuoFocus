<div align="center">

# 🎯 DuoFocus

### A private study-together app for exactly two people.

Create a session, focus side by side, keep each other accountable — no noise, no crowd.

![Python](https://img.shields.io/badge/Python-3.13+-3776AB?style=for-the-badge&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688?style=for-the-badge&logo=fastapi&logoColor=white)
![React](https://img.shields.io/badge/React-18.3-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-5.4-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-F9C400?style=for-the-badge&logo=open-source-initiative&logoColor=white)

![Status](https://img.shields.io/badge/Status-Phase_5_Shared_Timer-brightgreen?style=flat-square)
![PRs](https://img.shields.io/badge/PRs-private_project-orange?style=flat-square)

</div>

---

## 📖 About

**DuoFocus** is a minimal, distraction-free study-together application built for exactly **two people**. Instead of joining crowded study servers, you and your study partner share a private space: synchronized focus sessions, a shared timer, and gentle accountability — nothing more.

The project is currently at **Phase 5 (Shared Focus Timer)**: Firebase authentication, private two-person study rooms, and a synchronized room-level study timer backed by Cloud Firestore. See the [Roadmap](#roadmap) for what's coming.

> ⚠️ **Work in progress** — DuoFocus is under active development. Features listed in the [Roadmap](#roadmap) are **not implemented yet**.

## ✨ Features

**Current (Phases 1–5):**

- ⚙️ **FastAPI backend** with a `GET /health` service check
- 📘 **Auto-generated Swagger / OpenAPI docs** at `/docs`
- ⚛️ **React 18 + Vite** dev environment with instant hot-module reload
- 🔒 **Strict TypeScript** configuration (`strict`, `noUnusedLocals`, `noUnusedParameters`)
- 🔐 **Firebase Authentication** — email/password sign-up, login, logout, protected `/app` routes
- 🏠 **Two-person study rooms** — create a room, share a 6-character code, join by code, live membership updates via Firestore real-time listeners
- ⏱ **Shared focus timer** — one room-level 25-minute timer with start/pause/resume/reset, server-anchored state, real-time sync across both browsers, and race-safe concurrency enforced by Firestore rules
- 🛡 **Hardened Firestore security rules** — member-only room reads, shape-exhaustive join/leave/timer writes, atomic room↔code lifecycle, no enumeration of room codes
- 🧹 **Clean repository hygiene** — venvs, builds, env files, and editor junk are ignored

## 🛠 Tech Stack

| Layer | Technology | Version | Purpose |
|-------|------------|---------|---------|
| Frontend | [React](https://react.dev) | 18.3 | UI library |
| Frontend | [Vite](https://vite.dev) | 5.4 | Dev server & bundler |
| Frontend | [TypeScript](https://www.typescriptlang.org) | 5.6 | Type-safe JavaScript |
| Backend | [Python](https://www.python.org) | 3.13+ | Runtime |
| Backend | [FastAPI](https://fastapi.tiangolo.com) | 0.115 | API framework |
| Backend | [Uvicorn](https://www.uvicorn.org) | 0.34 | ASGI server |
| Data | [Cloud Firestore](https://firebase.google.com/docs/firestore) | — | Room storage & real-time sync |
| Auth | [Firebase Authentication](https://firebase.google.com/docs/auth) | — | Email/password identity |

## 🏗 Architecture

```text
Browser
   │
   ▼
React + Vite  (frontend/)
   │
   │  future HTTP / API communication
   ▼
FastAPI  (backend/)
```

> Firebase joins this architecture in a later phase. No database, auth, or realtime layer exists yet — by design.

## 📁 Project Structure

```text
duofocus/
├── frontend/                  # React + Vite + TypeScript
│   ├── src/
│   │   ├── main.tsx           # React entry point
│   │   ├── App.tsx            # Root component
│   │   ├── index.css          # Global styles (Tailwind entry)
│   │   ├── components/        # Reusable UI primitives
│   │   ├── context/           # AuthContext (Firebase auth state)
│   │   ├── layouts/           # Shared page chrome
│   │   ├── pages/             # Home / Auth / AppHome / Room / 404
│   │   ├── routes/            # Route table + protected route
│   │   ├── services/          # firebase.ts · api.ts · rooms.ts
│   │   ├── types/             # Shared + room domain types
│   │   └── vite-env.d.ts      # Vite client + env types
│   ├── index.html             # HTML entry
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
├── backend/                   # FastAPI
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py            # App instance + /health + /api/auth/me
│   │   └── auth/              # Firebase Admin token verification
│   ├── requirements.txt
│   └── .env.example           # Environment variable template
├── firestore.rules            # Firestore security rules (rooms + roomCodes)
├── firebase.json              # Firebase config (rules source of truth)
├── .firebaserc                # Firebase project alias
├── .gitignore
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE
└── README.md
```

## 🚀 Getting Started

### Prerequisites

| Tool | Version | Verify |
|------|---------|--------|
| Python | 3.13+ | `python --version` |
| Node.js | 20+ | `node -v` |
| npm | 10+ | `npm -v` |

### Backend Setup

```bash
# 1. Enter the backend directory
cd backend

# 2. Create a virtual environment
python -m venv .venv

# 3. Activate it
source .venv/bin/activate        # macOS / Linux
.venv\Scripts\activate           # Windows (PowerShell: .venv\Scripts\Activate.ps1)

# 4. Install dependencies
pip install -r requirements.txt

# 5. Start the development server
uvicorn app.main:app --reload
```

### Frontend Setup

```bash
# 1. Enter the frontend directory
cd frontend

# 2. Install dependencies
npm install

# 3. Start the dev server
npm run dev
```

### Deploy Firestore Security Rules

Room security is enforced by [`firestore.rules`](firestore.rules) at the database level — never rely on the UI alone. After changing rules, deploy them:

```bash
# One-time: install the Firebase CLI and sign in
npm install -g firebase-tools
firebase login

# From the repo root — .firebaserc points at your Firebase project
firebase deploy --only firestore:rules
```

The rules enforce: member-only room reads, join only into a one-member room by adding your own UID, leave only by removing your own UID, immutable `ownerId`/`roomCode`/`createdAt`, a hard two-member cap, and room↔roomCode documents that can only be created or deleted together (no orphaned codes).

### Verify the Installation

| Service | URL | Expected |
|---------|-----|----------|
| Frontend (Vite) | http://localhost:5173 | DuoFocus welcome page |
| Backend API | http://localhost:8000 | — |
| Health check | http://localhost:8000/health | `{"status": "ok", "service": "duofocus-api"}` |
| Swagger docs | http://localhost:8000/docs | Interactive API documentation |

## 🔌 API Reference

| Method | Endpoint        | Description                    |
|--------|-----------------|--------------------------------|
| `GET`  | `/health`       | Service health check           |
| `GET`  | `/docs`         | Swagger UI (auto-generated)    |
| `GET`  | `/openapi.json` | Raw OpenAPI schema             |

**`GET /health` response:**

```json
{
  "status": "ok",
  "service": "duofocus-api"
}
```

## 📜 Available Scripts

**Frontend** (run inside `frontend/`):

| Command           | Description                              |
|-------------------|------------------------------------------|
| `npm run dev`     | Start dev server at `localhost:5173`     |
| `npm run build`   | Type-check + production build to `dist/` |
| `npm run preview` | Preview the production build locally     |
| `npm run regression` | One-command verification: starts the Firebase **emulators**, runs all Vitest suites (rules + unit + integration + multi-user), test typecheck, and the production build; non-zero exit on any failure; emulators always shut down afterward |

**Backend** (run inside `backend/` with the venv active):

| Command                         | Description                            |
|---------------------------------|----------------------------------------|
| `uvicorn app.main:app --reload` | Dev server with hot reload at `:8000`  |

## 🗺 Roadmap

- [x] **Phase 1 — Foundation**: React + Vite + TypeScript frontend, FastAPI backend, health check
- [x] **Phase 2 — Frontend Foundation**: routing, Tailwind, layout/pages/services/types structure
- [x] **Phase 3 — Authentication**: Firebase email/password, protected routes, backend token verification
- [x] **Phase 4 — Study Rooms**: create/join by code, real-time membership, hardened Firestore rules
- [x] **Phase 5 — Shared Focus Timer**: synchronized room-level timer with rules-enforced state machine
- [ ] **Phase 6 — Statistics**: session history and study insights

## 🧰 Troubleshooting

<details>
<summary><b>Port 8000 is already in use</b></summary>

Another process is listening on port 8000. Either stop it, or run DuoFocus on another port:

```bash
uvicorn app.main:app --reload --port 8001
```

Find the offending process:

```bash
# Windows
netstat -ano | findstr :8000

# macOS / Linux
lsof -i :8000
```

</details>

<details>
<summary><b><code>.venv\Scripts\activate</code> fails on Windows PowerShell</b></summary>

Use `Activate.ps1` explicitly, or relax the execution policy for the session:

```powershell
.venv\Scripts\Activate.ps1
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process
```

</details>

<details>
<summary><b>Vite starts on a different port</b></summary>

If 5173 is taken, Vite picks the next free port. Force the default with:

```bash
npm run dev -- --strictPort
```

</details>

## 🤝 Contributing

DuoFocus is a **private two-person project**, but contributions between the two of us follow a simple workflow — see [CONTRIBUTING.md](CONTRIBUTING.md). In short: small commits, [Conventional Commits](https://www.conventionalcommits.org) (`feat(scope): message`), and never commit secrets or environment files.

## 📄 License

Distributed under the **MIT License**. See [`LICENSE`](LICENSE) for details.

---

<div align="center">
<sub>Built with ☕ and focus by a duo, for duos.</sub>
</div>
