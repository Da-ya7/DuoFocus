# Contributing to DuoFocus

Thanks for helping build DuoFocus! This is a small, private two-person project, so we keep the workflow light but consistent.

## Getting Started

1. **Clone the repository**
2. **Backend setup**
   ```bash
   cd backend
   python -m venv .venv
   source .venv/bin/activate       # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   ```
3. **Frontend setup**
   ```bash
   cd frontend
   npm install
   ```
4. **Verify everything runs** — see the [README](README.md#verify-the-installation).

## Ground Rules

- **Never commit secrets** — no `.env` files, API keys, tokens, or credentials. Use `backend/.env.example` as the template.
- **Never commit build artifacts** — `.venv/`, `node_modules/`, `dist/` are ignored; keep it that way.
- **Small, focused commits** — one logical change per commit.
- **Match the existing style** — strict TypeScript on the frontend, plain FastAPI on the backend. Don't introduce new frameworks without discussion.

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org):

```text
feat(scope): add two-person room creation
fix(backend): handle port conflict on startup
docs: update setup instructions
chore: bump vite to 5.4.21
```

Scopes in use: `backend`, `frontend`, `api`, `ui`, `docs`, `deps`.

## Workflow

1. Create a branch per feature: `feat/room-creation`, `fix/health-check`, etc.
2. Before pushing:
   - Frontend: `npm run build` must pass (this type-checks).
   - Backend: app must start and `/health` must return 200.
3. Open a pull request with a short description of the change.

## Phase Discipline

DuoFocus is built in controlled phases. **Do not implement features from future phases** — the roadmap in the [README](README.md#roadmap) defines what's in scope right now.
