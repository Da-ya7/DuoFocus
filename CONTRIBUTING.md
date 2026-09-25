# Contributing to DuoFocus

Thanks for helping build DuoFocus! This is a small, private two-person project, so we keep the workflow light but consistent.

## Getting Started

1. **Clone the repository**
2. **Frontend setup**
   ```bash
   cd frontend
   npm install
   ```
3. **Firebase setup** — create a Firebase project, enable Email/Password sign-in, and fill in `frontend/.env` (see `frontend/.env.example`). Deploy the security rules from the repo root:
   ```bash
   firebase deploy --only firestore:rules
   ```
4. **Verify everything runs** — see the [README](README.md#verify-the-installation).

## Ground Rules

- **Never commit secrets** — no `.env` files, API keys, tokens, or credentials. Use `frontend/.env.example` as the template.
- **Never commit build artifacts** — `node_modules/`, `dist/` are ignored; keep it that way.
- **Small, focused commits** — one logical change per commit.
- **Match the existing style** — strict TypeScript; the backend is Firebase (Auth + Firestore + Security Rules), not a custom server. Don't introduce new frameworks without discussion.

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org):

```text
feat(scope): add two-person room creation
fix(backend): handle port conflict on startup
docs: update setup instructions
chore: bump vite to 5.4.21
```

Scopes in use: `frontend`, `ui`, `docs`, `deps`, `test`, `ci`.

## Workflow

1. Create a branch per feature: `feat/room-creation`, `fix/health-check`, etc.
2. Before pushing:
   - `cd frontend && npm run regression` must pass (this runs all tests, typechecks, and the production build).
3. Open a pull request with a short description of the change.

## Phase Discipline

DuoFocus is built in controlled phases. **Do not implement features from future phases** — the roadmap in the [README](README.md#roadmap) defines what's in scope right now.
