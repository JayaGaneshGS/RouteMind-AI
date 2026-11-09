"""Configuration for the ML service (all values overridable via environment variables)."""
import os
from pathlib import Path

MODEL_PATH = Path(os.getenv("MODEL_PATH", Path(__file__).parent / "models" / "traffic_model.joblib"))
METRICS_PATH = Path(__file__).parent / "models" / "metrics.json"

# Travel time = base time x multiplier for the predicted traffic level.
# Configurable, e.g. TRAFFIC_MULTIPLIERS="LOW=1.05,MEDIUM=1.20,HIGH=1.45"
DEFAULT_MULTIPLIERS = {"LOW": 1.05, "MEDIUM": 1.20, "HIGH": 1.45}


def get_multipliers() -> dict[str, float]:
    result = dict(DEFAULT_MULTIPLIERS)
    raw = os.getenv("TRAFFIC_MULTIPLIERS", "")
    for part in raw.split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            try:
                result[k.strip().upper()] = float(v)
            except ValueError:
                pass  # ignore malformed entries, keep defaults
    return result
