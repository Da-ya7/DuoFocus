import os
from typing import Any
from dotenv import load_dotenv
import firebase_admin
from firebase_admin import auth, credentials
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

load_dotenv()

bearer_scheme = HTTPBearer(auto_error=False)


def get_firebase_admin_app() -> firebase_admin.App | None:
    """Initialize or retrieve the Firebase Admin app safely.

    Uses GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_SERVICE_ACCOUNT_PATH if available,
    or falls back to Application Default Credentials (ADC).
    """
    if firebase_admin._apps:
        return firebase_admin.get_app()

    cred_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS") or os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH")
    project_id = os.getenv("FIREBASE_PROJECT_ID")
    options: dict[str, Any] = {}
    if project_id:
        options["projectId"] = project_id

    try:
        if cred_path and os.path.isfile(cred_path):
            cred = credentials.Certificate(cred_path)
            return firebase_admin.initialize_app(cred, options=options)
        return firebase_admin.initialize_app(options=options)
    except Exception:
        # If credentials are not configured, app is not initialized yet.
        # Any attempt to verify tokens will safely fail with 401.
        return None


async def get_current_user(
    request: Request,
    auth_credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> dict[str, Any]:
    """FastAPI dependency to extract and verify the Firebase ID token.

    Returns verified user information (uid, email).
    Raises HTTP 401 for missing, malformed, invalid, or expired tokens.
    """
    auth_header = request.headers.get("Authorization")
    if not auth_header:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if auth_credentials is None or auth_credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication scheme; expected Bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = auth_credentials.credentials
    if not token or not token.strip():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Empty or missing authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    app = get_firebase_admin_app()
    if app is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Firebase Admin authentication is not configured on the server",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        decoded_token = auth.verify_id_token(token, app=app)
        return {
            "uid": decoded_token["uid"],
            "email": decoded_token.get("email"),
        }
    except (
        auth.InvalidIdTokenError,
        auth.ExpiredIdTokenError,
        auth.RevokedIdTokenError,
        auth.CertificateFetchError,
        ValueError,
    ) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication token verification failed",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
