"""Analytical travel-time model: base time x traffic multiplier (configurable)."""
from app.config import get_multipliers
from app.schemas import TravelTimeResponse


def predict_travel_time(base_minutes: float, traffic_level: str) -> TravelTimeResponse:
    mult = get_multipliers()[traffic_level]
    return TravelTimeResponse(
        base_minutes=base_minutes, multiplier=mult,
        predicted_minutes=round(base_minutes * mult, 1), traffic_level=traffic_level,
    )
