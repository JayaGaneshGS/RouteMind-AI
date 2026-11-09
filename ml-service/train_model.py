"""
Train the traffic-level classifier.

Pipeline: load CSV -> clean -> split -> (one-hot + RandomForest) -> evaluate -> save with joblib.

NOTE: the CSV is a synthetic, academic-demonstration dataset (see data/README.md).
Metrics below describe performance on that dataset only - they do NOT imply accuracy
on real roads.

Run:  python train_model.py
"""
import json
from pathlib import Path

import joblib
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, precision_recall_fscore_support
from sklearn.model_selection import cross_val_score, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

from app.utils.features import CATEGORICAL_FEATURES, CLASSES, FEATURES, NUMERIC_FEATURES, TARGET

BASE = Path(__file__).parent
DATA_PATH = BASE / "data" / "traffic_data.csv"
MODEL_PATH = BASE / "app" / "models" / "traffic_model.joblib"
METRICS_PATH = BASE / "app" / "models" / "metrics.json"


def load_and_clean(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    df = df.drop_duplicates().dropna(subset=[TARGET])
    df = df[df[TARGET].isin(CLASSES)]
    df["hour"] = df["hour"].clip(0, 23)
    df["day_of_week"] = df["day_of_week"].clip(0, 6)
    df["distance"] = df["distance"].clip(lower=0)
    for col in NUMERIC_FEATURES:  # impute any missing numeric values with the median
        df[col] = df[col].fillna(df[col].median())
    for col in CATEGORICAL_FEATURES:
        df[col] = df[col].fillna(df[col].mode()[0])
    return df.reset_index(drop=True)


def build_pipeline() -> Pipeline:
    pre = ColumnTransformer(
        [("cat", OneHotEncoder(handle_unknown="ignore"), CATEGORICAL_FEATURES)],
        remainder="passthrough",
    )
    clf = RandomForestClassifier(
        n_estimators=200, max_depth=12, min_samples_leaf=3,
        class_weight="balanced", random_state=42, n_jobs=-1,
    )
    return Pipeline([("pre", pre), ("clf", clf)])


def main() -> None:
    df = load_and_clean(DATA_PATH)
    print(f"Loaded {len(df)} rows. Class balance:\n{df[TARGET].value_counts()}\n")

    X, y = df[FEATURES], df[TARGET]
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, stratify=y, random_state=42)

    pipe = build_pipeline()
    pipe.fit(X_train, y_train)
    pred = pipe.predict(X_test)

    acc = accuracy_score(y_test, pred)
    p, r, f1, _ = precision_recall_fscore_support(y_test, pred, average="weighted", zero_division=0)
    cv = cross_val_score(build_pipeline(), X, y, cv=5, scoring="accuracy")
    cm = confusion_matrix(y_test, pred, labels=CLASSES)

    print("=== Evaluation (hold-out 20%) ===")
    print(f"Accuracy : {acc:.4f}")
    print(f"Precision: {p:.4f} (weighted)")
    print(f"Recall   : {r:.4f} (weighted)")
    print(f"F1 score : {f1:.4f} (weighted)")
    print(f"5-fold CV accuracy: {cv.mean():.4f} +/- {cv.std():.4f}\n")
    print(classification_report(y_test, pred, labels=CLASSES, zero_division=0))
    print("Confusion matrix (rows=true, cols=pred, order LOW/MEDIUM/HIGH):\n", cm)

    # Feature importance (explainability)
    names = pipe.named_steps["pre"].get_feature_names_out()
    imp = sorted(zip((n.split("__")[-1] for n in names), pipe.named_steps["clf"].feature_importances_),
                 key=lambda t: -t[1])
    print("\nTop feature importances:")
    for n, v in imp[:8]:
        print(f"  {n:32s} {v:.3f}")

    # Lookup of average historical congestion per (route_type, hour), used at inference
    # when the caller doesn't supply historical_traffic_level.
    hist_lookup = df.groupby(["route_type", "hour"])["historical_traffic_level"].mean().round(3)
    hist_lookup = {f"{rt}|{h}": float(v) for (rt, h), v in hist_lookup.items()}

    bundle = {"pipeline": pipe, "classes": list(pipe.named_steps["clf"].classes_), "hist_lookup": hist_lookup,
              "hist_default": float(df["historical_traffic_level"].median())}
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, MODEL_PATH)

    metrics = {
        "model": "RandomForestClassifier (scikit-learn) in a one-hot Pipeline",
        "dataset": "Synthetic academic-demonstration dataset (not real traffic data)",
        "train_rows": int(len(X_train)), "test_rows": int(len(X_test)),
        "accuracy": round(acc, 4), "precision_weighted": round(float(p), 4),
        "recall_weighted": round(float(r), 4), "f1_weighted": round(float(f1), 4),
        "cv_accuracy_mean": round(float(cv.mean()), 4), "cv_accuracy_std": round(float(cv.std()), 4),
        "confusion_matrix": {"labels": CLASSES, "matrix": cm.tolist()},
        "feature_importances": [{"feature": n, "importance": round(float(v), 4)} for n, v in imp],
    }
    METRICS_PATH.write_text(json.dumps(metrics, indent=2))
    print(f"\nSaved model -> {MODEL_PATH}\nSaved metrics -> {METRICS_PATH}")


if __name__ == "__main__":
    main()
