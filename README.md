# DuoFocus

DuoFocus is a private study-together application for exactly two people: create a shared focus session, study side by side, and keep each other accountable.

## Tech Stack

- **Frontend:** React + Vite + TypeScript
- **Backend:** Python + FastAPI + Uvicorn

## Project Structure

```text
duofocus/
├── frontend/   # React + Vite + TypeScript
└── backend/    # FastAPI
```

## Local Setup

### Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # macOS / Linux
pip install -r requirements.txt
uvicorn app.main:app --reload
```

- API: http://localhost:8000
- Health check: http://localhost:8000/health
- Swagger docs: http://localhost:8000/docs

### Frontend

```bash
cd frontend
npm install
npm run dev
```

- Dev server: http://localhost:5173
