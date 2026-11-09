import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.predictor import predictor
from app.services.travel_time import predict_travel_time


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:  # triggers lifespan -> loads the model
        yield c


def test_model_loads():
    assert predictor.load() is True
    assert set(predictor.bundle["classes"]) == {"LOW", "MEDIUM", "HIGH"}


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200 and r.json() == {"status": "ok", "model_loaded": True}


def test_predict_endpoint_shape(client):
    r = client.post("/predict-traffic", json={"hour": 18, "day_of_week": 4, "weekend": False, "distance": 150, "rain": True})
    assert r.status_code == 200
    body = r.json()
    assert body["traffic_level"] in {"LOW", "MEDIUM", "HIGH"}
    assert 0 < body["confidence"] <= 1


def test_model_learned_patterns(client):
    """Sanity check: weekday evening rush in a city must be heavier than 3am on a highway."""
    rush = client.post("/predict-traffic", json={"hour": 18, "day_of_week": 2, "weekend": False, "distance": 20, "rain": True, "route_type": "city"}).json()
    night = client.post("/predict-traffic", json={"hour": 3, "day_of_week": 2, "weekend": False, "distance": 200, "rain": False, "route_type": "highway"}).json()
    order = {"LOW": 0, "MEDIUM": 1, "HIGH": 2}
    assert order[rush["traffic_level"]] > order[night["traffic_level"]]


def test_validation_error(client):
    r = client.post("/predict-traffic", json={"hour": 99, "day_of_week": 1, "weekend": False, "distance": 10})
    assert r.status_code == 422


def test_batch(client):
    item = {"hour": 9, "day_of_week": 1, "weekend": False, "distance": 50}
    r = client.post("/predict-traffic/batch", json={"items": [item, item]})
    assert r.status_code == 200 and len(r.json()["results"]) == 2


def test_travel_time_multipliers():
    assert predict_travel_time(100, "LOW").predicted_minutes == 105.0
    assert predict_travel_time(100, "HIGH").predicted_minutes == 145.0


def test_model_accuracy_floor():
    """Guard against a broken retrain: demo-data accuracy should stay well above chance (0.33)."""
    assert predictor.metrics()["accuracy"] > 0.7
