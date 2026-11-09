"""Shared feature definitions so training and inference can never drift apart."""
import pandas as pd

NUMERIC_FEATURES = ["hour", "day_of_week", "weekend", "distance", "rain", "historical_traffic_level"]
CATEGORICAL_FEATURES = ["weather", "route_type"]
FEATURES = NUMERIC_FEATURES + CATEGORICAL_FEATURES
TARGET = "traffic_level"
CLASSES = ["LOW", "MEDIUM", "HIGH"]

WEATHER_VALUES = ["clear", "cloudy", "rain", "fog"]
ROUTE_TYPES = ["highway", "mixed", "city"]


def to_frame(rows: list[dict]) -> pd.DataFrame:
    """Build a model-ready DataFrame (column order fixed) from a list of dicts."""
    df = pd.DataFrame(rows)
    return df[FEATURES]
