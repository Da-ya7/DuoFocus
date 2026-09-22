from fastapi import FastAPI

app = FastAPI(
    title="DuoFocus API",
    description="Backend API for the DuoFocus study app",
    version="0.1.0",
)


@app.get("/health")
def health_check() -> dict[str, str]:
    """Health-check endpoint for the DuoFocus API."""
    return {"status": "ok", "service": "duofocus-api"}
