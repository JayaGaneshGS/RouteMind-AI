"""Pydantic request/response models."""
from typing import Literal, Optional
from pydantic import BaseModel, Field

TrafficLevel = Literal["LOW", "MEDIUM", "HIGH"]


class TrafficRequest(BaseModel):
    hour: int = Field(..., ge=0, le=23)
    day_of_week: int = Field(..., ge=0, le=6, description="0 = Monday")
    weekend: bool
    distance: float = Field(..., gt=0, le=5000, description="km")
    rain: bool = False
    weather: Optional[Literal["clear", "cloudy", "rain", "fog"]] = None
    route_type: Literal["highway", "mixed", "city"] = "mixed"
    historical_traffic_level: Optional[float] = Field(None, ge=0, le=2)


class TrafficResponse(BaseModel):
    traffic_level: TrafficLevel
    confidence: float
    probabilities: dict[str, float]


class BatchTrafficRequest(BaseModel):
    items: list[TrafficRequest] = Field(..., min_length=1, max_length=20)


class BatchTrafficResponse(BaseModel):
    results: list[TrafficResponse]


class TravelTimeRequest(BaseModel):
    base_minutes: float = Field(..., gt=0)
    traffic_level: TrafficLevel


class TravelTimeResponse(BaseModel):
    base_minutes: float
    multiplier: float
    predicted_minutes: float
    traffic_level: TrafficLevel


class HealthResponse(BaseModel):
    status: str
    model_loaded: bool
