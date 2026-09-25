<div align="center">

# 🎯 DuoFocus

### A private study-together app for exactly two people.

Create a session, focus side by side, keep each other accountable — no noise, no crowd.

![React](https://img.shields.io/badge/React-18.3-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-5.4-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-F9C400?style=for-the-badge&logo=open-source-initiative&logoColor=white)

![Status](https://img.shields.io/badge/Status-Phase_8_Verification_+_CI-brightgreen?style=flat-square)
![PRs](https://img.shields.io/badge/PRs-private_project-orange?style=flat-square)

</div>

---

## 📖 About

**DuoFocus** is a minimal, distraction-free study-together application built for exactly **two people**. Instead of joining crowded study servers, you and your study partner share a private space: synchronized focus sessions, a shared timer, and gentle accountability — nothing more.

DuoFocus is **Firebase-first**: React + TypeScript on the client; Firebase Authentication, Cloud Firestore, and Firestore Security Rules on the backend-as-a-service side. All core features — rooms, the shared timer, session history & statistics, and partner presence — are implemented and covered by a 244-test verification suite that runs locally (`npm run regression`) and in GitHub Actions CI.

## ✨ Features

**Current:**

- ⚛️ **React 18 + Vite** dev environment with instant hot-module reload
- 🔒 **Strict TypeScript** configuration (`strict`, `noUnusedLocals`, `noUnusedParameters`)
- 🔐 **Firebase Authentication** — email/password sign-up, login, logout, protected `/app` routes
- 🏠 **Two-person study rooms** — create a room, share a 6-character code, join by code, live membership updates via Firestore real-time listeners
- ⏱ **Shared focus timer** — one room-level 25-minute timer with start/pause/resume/reset, server-anchored state, real-time sync across both browsers, and race-safe concurrency enforced by Firestore rules
- 🛡 **Hardened Firestore security rules** — member-only room reads, shape-exhaustive join/leave/timer writes, atomic room↔code lifecycle, no enumeration of room codes
- 📊 **Session history & personal statistics** — immutable completion evidence materialized into private study logs, with totals, today-focus, and streaks
- 🟢 **Partner presence** — heartbeat-based online/idle/offline indicator for your study partner
- ✅ **244-test verification suite** — Firestore rules, unit, service-integration, and multi-user tests on the Firebase emulators, run by one command (`npm run regression`) and by GitHub Actions CI
- 🧹 **Clean repository hygiene** — builds, env files, and editor junk are ignored

## 🛠 Tech Stack

| Layer | Technology | Version | Purpose |
|-------|------------|---------|---------|
| Frontend | [React](https://react.dev) | 18.3 | UI library |
| Frontend | [Vite](https://vite.dev) | 5.4 | Dev server & bundler |
| Frontend | [TypeScript](https://www.typescriptlang.org) | 5.6 | Type-safe JavaScript |
| BaaS | [Cloud Firestore](https://firebase.google.com/docs/firestore) | — | Rooms, timer, sessions, presence (real-time) |
| BaaS | [Firebase Authentication](https://firebase.google.com/docs/auth) | — | Email/password identity |
| BaaS | Firestore Security Rules | — | Server-side authorization (`firestore.rules`) |

## 🏗 Architecture

```text
Browser
   │
   ▼
React + Vite  (frontend/)
   │  Firebase Web SDK
   ▼
Firebase Authentication  +  Cloud Firestore
                              │
                              ▼
                 Firestore Security Rules
```

> DuoFocus is Firebase-first: there is no custom server. All authorization is enforced server-side by [`firestore.rules`](firestore.rules).

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
│   │   ├── services/          # firebase.ts · rooms.ts · timer.ts · sessions.ts · presence.ts
│   │   ├── types/             # Shared + room domain types
│   │   └── vite-env.d.ts      # Vite client + env types
│   ├── index.html             # HTML entry
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
│   └── tests/                 # rules · unit · integration · multi-user suites
├── firestore.rules            # Firestore security rules (rooms + roomCodes)
├── firebase.json              # Firebase config (rules source of truth)
├── .firebaserc                # Firebase project alias
├── .github/workflows/ci.yml   # GitHub Actions CI (npm run regression)
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
| Node.js | 20+ | `node -v` |
| npm | 10+ | `npm -v` |
| Java | 17+ | `java -version` (required by the Firebase emulators) |

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
| Full verification suite | `cd frontend && npm run regression` | all tests + typecheck + build pass |

## 📜 Available Scripts

**Frontend** (run inside `frontend/`):

| Command           | Description                              |
|-------------------|------------------------------------------|
| `npm run dev`     | Start dev server at `localhost:5173`     |
| `npm run build`   | Type-check + production build to `dist/` |
| `npm run preview` | Preview the production build locally     |
| `npm run regression` | One-command verification: starts the Firebase **emulators**, runs all Vitest suites (rules + unit + integration + multi-user), test typecheck, and the production build; non-zero exit on any failure; emulators always shut down afterward |

## 🗺 Roadmap

- [x] **Phase 1 — Foundation**: React + Vite + TypeScript frontend
- [x] **Phase 2 — Frontend Foundation**: routing, Tailwind, layout/pages/services/types structure
- [x] **Phase 3 — Authentication**: Firebase email/password, protected routes
- [x] **Phase 4 — Study Rooms**: create/join by code, real-time membership, hardened Firestore rules
- [x] **Phase 5 — Shared Focus Timer**: synchronized room-level timer with rules-enforced state machine
- [x] **Phase 6 — Statistics**: session history, personal statistics, immutable completion evidence
- [x] **Phase 7 — Partner Presence**: heartbeat-based presence with real-time indicators
- [x] **Phase 8 — Testing & Verification**: rules/unit/integration/multi-user suites, one-command regression, GitHub Actions CI
- [x] **Phase 9 — Firebase-First Consolidation**: removed the unused FastAPI backend; DuoFocus is React + Firebase Auth + Firestore + Security Rules

## 🧰 Troubleshooting

<details>
<summary><b>Vite starts on a different port</b></summary>

If 5173 is taken, Vite picks the next free port. Force the default with:

```bash
npm run dev -- --strictPort
```

</details>

<details>
<summary><b>Emulator ports are already in use</b></summary>

`npm run regression` needs Firebase emulator ports 9099 (Auth), 8080 (Firestore), and 4000 (Emulator UI). Stop any process already listening there:

```bash
# Windows
netstat -ano | findstr :9099

# macOS / Linux
lsof -i :9099
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
