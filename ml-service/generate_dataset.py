"""
Generates the ACADEMIC DEMONSTRATION dataset  data/traffic_data.csv.

IMPORTANT: this dataset is synthetic. It encodes commonly observed urban/highway
traffic patterns (morning/evening peaks, weekend relief, rain slowing traffic,
city roads being more congested than highways) plus random noise so that the
classifier has something realistic to learn. It is NOT real-time or measured
traffic data. A production system would need a large real-world dataset
(e.g. GPS probe data, loop detectors, or a commercial traffic feed).

Run:  python generate_dataset.py
"""
import numpy as np
import pandas as pd
from pathlib import Path

RNG = np.random.default_rng(42)  # fixed seed -> reproducible dataset
N = 2000

WEATHER = ["clear", "cloudy", "rain", "fog"]
ROUTE_TYPES = ["highway", "mixed", "city"]


def peak_score(hour: int) -> float:
    """0..1 score representing how close the hour is to a commuting peak."""
    morning = np.exp(-((hour - 9) ** 2) / 4.5)
    evening = np.exp(-((hour - 18) ** 2) / 5.0)
    return float(max(morning, evening))


def main() -> None:
    rows = []
    for _ in range(N):
        hour = int(RNG.integers(0, 24))
        dow = int(RNG.integers(0, 7))  # 0 = Monday
        weekend = int(dow >= 5)
        distance = float(np.round(RNG.uniform(3, 400), 1))
        weather = str(RNG.choice(WEATHER, p=[0.5, 0.25, 0.2, 0.05]))
        rain = int(weather == "rain")
        route_type = str(RNG.choice(ROUTE_TYPES, p=[0.35, 0.35, 0.30]))

        # Latent congestion index built from domain knowledge + noise.
        idx = 0.0
        idx += 1.6 * peak_score(hour) * (0.45 if weekend else 1.0)
        idx += {"highway": 0.0, "mixed": 0.35, "city": 0.8}[route_type]
        idx += 0.5 * rain + (0.25 if weather == "fog" else 0.0)
        idx += 0.3 if (weekend and 10 <= hour <= 20 and route_type != "city") else 0.0  # leisure trips
        idx += 0.15 * (distance < 40)  # short trips are mostly urban
        idx -= 0.35 * (0 <= hour <= 5)
        idx += RNG.normal(0, 0.28)

        # historical_traffic_level: noisy "average past congestion" on this corridor (0..2)
        hist = float(np.clip(np.round(idx + RNG.normal(0, 0.35), 2), 0, 2))

        level = "LOW" if idx < 0.85 else ("MEDIUM" if idx < 1.55 else "HIGH")
        rows.append([hour, dow, weekend, distance, weather, rain, route_type, hist, level])

    df = pd.DataFrame(rows, columns=[
        "hour", "day_of_week", "weekend", "distance", "weather",
        "rain", "route_type", "historical_traffic_level", "traffic_level",
    ])
    out = Path(__file__).parent / "data" / "traffic_data.csv"
    out.parent.mkdir(exist_ok=True)
    df.to_csv(out, index=False)
    print(f"Wrote {len(df)} rows to {out}")
    print(df["traffic_level"].value_counts())


if __name__ == "__main__":
    main()
