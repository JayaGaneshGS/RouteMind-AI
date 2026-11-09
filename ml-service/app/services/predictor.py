"""Loads the trained scikit-learn pipeline and serves predictions."""
import json
import joblib

from app.config import METRICS_PATH, MODEL_PATH
from app.schemas import TrafficRequest, TrafficResponse
from app.utils.features import to_frame


class Predictor:
    def __init__(self) -> None:
        self.bundle = None

    def load(self) -> bool:
        if not MODEL_PATH.exists():
            return False
        self.bundle = joblib.load(MODEL_PATH)
        return True

    @property
    def loaded(self) -> bool:
        return self.bundle is not None

    def _row(self, r: TrafficRequest) -> dict:
        weather = r.weather or ("rain" if r.rain else "clear")
        hist = r.historical_traffic_level
        if hist is None:  # fall back to the training-set average for this road type & hour
            hist = self.bundle["hist_lookup"].get(f"{r.route_type}|{r.hour}", self.bundle["hist_default"])
        return {
            "hour": r.hour, "day_of_week": r.day_of_week, "weekend": int(r.weekend),
            "distance": r.distance, "rain": int(r.rain or weather == "rain"),
            "historical_traffic_level": hist, "weather": weather, "route_type": r.route_type,
        }

    def predict(self, items: list[TrafficRequest]) -> list[TrafficResponse]:
        if not self.loaded:
            raise RuntimeError("Model not loaded. Run train_model.py first.")
        frame = to_frame([self._row(r) for r in items])
        pipe = self.bundle["pipeline"]
        proba = pipe.predict_proba(frame)
        classes = list(pipe.named_steps["clf"].classes_)
        out = []
        for p in proba:
            i = int(p.argmax())
            out.append(TrafficResponse(
                traffic_level=classes[i], confidence=round(float(p[i]), 4),
                probabilities={c: round(float(v), 4) for c, v in zip(classes, p)},
            ))
        return out

    @staticmethod
    def metrics() -> dict:
        return json.loads(METRICS_PATH.read_text()) if METRICS_PATH.exists() else {}


predictor = Predictor()
