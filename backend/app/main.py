import os
from typing import Any
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.auth import get_current_user

app = FastAPI(
    title="DuoFocus API",
    description="Backend API for the DuoFocus study app",
    version="0.1.0",
)

# CORS configuration: allow only the local frontend origin
frontend_origin = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[frontend_origin],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health_check() -> dict[str, str]:
    """Health-check endpoint for the DuoFocus API."""
    return {"status": "ok", "service": "duofocus-api"}


@app.get("/api/auth/me")
def get_auth_me(
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Verification endpoint that validates the Firebase ID token.

    Returns the verified UID and email extracted directly from the token.
    """
    return {
        "uid": user["uid"],
        "email": user.get("email"),
    }
