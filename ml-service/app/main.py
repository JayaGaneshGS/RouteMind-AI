"""RouteMind AI - ML service (FastAPI)."""
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException

from app.schemas import (BatchTrafficRequest, BatchTrafficResponse, HealthResponse, TrafficRequest,
                         TrafficResponse, TravelTimeRequest, TravelTimeResponse)
from app.services.predictor import predictor
from app.services.travel_time import predict_travel_time


@asynccontextmanager
async def lifespan(_: FastAPI):
    if not predictor.load():
        print("WARNING: model file missing - run `python train_model.py`")
    yield


app = FastAPI(title="RouteMind ML Service", version="1.0.0", lifespan=lifespan,
              description="Traffic-level classification (RandomForest) trained on an academic demonstration dataset.")


def _require_model():
    if not predictor.loaded:
        raise HTTPException(status_code=503, detail="Model not loaded. Run train_model.py first.")


@app.get("/health", response_model=HealthResponse)
def health():
    return HealthResponse(status="ok", model_loaded=predictor.loaded)


@app.post("/predict-traffic", response_model=TrafficResponse)
def predict_traffic(req: TrafficRequest):
    _require_model()
    return predictor.predict([req])[0]


@app.post("/predict-traffic/batch", response_model=BatchTrafficResponse)
def predict_traffic_batch(req: BatchTrafficRequest):
    _require_model()
    return BatchTrafficResponse(results=predictor.predict(req.items))


@app.post("/predict-travel-time", response_model=TravelTimeResponse)
def travel_time(req: TravelTimeRequest):
    return predict_travel_time(req.base_minutes, req.traffic_level)


@app.get("/model-info")
def model_info():
    """Evaluation metrics saved by train_model.py (for the UI / viva demo)."""
    _require_model()
    return predictor.metrics()
