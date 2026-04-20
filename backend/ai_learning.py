"""
AI Learning Router
==================
Per-company XGBoost model that learns from route editing feedback.
Trains on routeHistory data and predicts confidence scores for new routes.
"""

from __future__ import annotations

import json
import logging
import math
import os
import pickle
from pathlib import Path
from typing import Any, Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

LOGGER = logging.getLogger("routeiq.ai")
MODELS_DIR = Path(os.environ.get("MODELS_DIR", "./data/models")).expanduser().resolve()

router = APIRouter(prefix="/routeiq", tags=["ai-learning"])

# Lazy-load firebase admin to avoid import errors if not configured
_firestore_client = None


def _get_firestore():
    global _firestore_client
    if _firestore_client is not None:
        return _firestore_client

    try:
        import firebase_admin
        from firebase_admin import credentials, firestore

        if not firebase_admin._apps:
            # Try service account from env
            sa_raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "")
            if sa_raw and sa_raw not in ("{}", "undefined"):
                import base64
                try:
                    sa_json = json.loads(sa_raw)
                except Exception:
                    try:
                        sa_json = json.loads(base64.b64decode(sa_raw))
                    except Exception:
                        sa_json = json.loads(base64.urlsafe_b64decode(sa_raw + "=="))
                cred = credentials.Certificate(sa_json)
                firebase_admin.initialize_app(cred)
            else:
                # Fall back to default credentials
                firebase_admin.initialize_app()

        _firestore_client = firestore.client()
        return _firestore_client
    except Exception as e:
        LOGGER.error(f"Failed to initialize Firestore: {e}")
        return None


def _extract_features(route_data: dict) -> list[float]:
    """Extract ML features from a route."""
    stops = route_data.get("stops", route_data.get("stopSequence", []))
    total_stops = len(stops) if isinstance(stops, list) else int(route_data.get("totalStops", 0))
    drive_time = float(route_data.get("totalDriveTimeMinutes", route_data.get("totalDriveMinutes", 0)))
    confidence = float(route_data.get("confidence", 0))

    # Day of week (0=Monday)
    date_str = route_data.get("date", "")
    day_of_week = 0
    if date_str:
        try:
            from datetime import datetime
            dt = datetime.strptime(date_str[:10], "%Y-%m-%d")
            day_of_week = dt.weekday()
        except Exception:
            pass

    # Average job duration
    avg_duration = 25.0
    if isinstance(stops, list) and stops:
        durations = []
        for s in stops:
            if isinstance(s, dict):
                durations.append(float(s.get("duration", 25)))
        if durations:
            avg_duration = sum(durations) / len(durations)

    # Service type diversity
    service_types = set()
    if isinstance(stops, list):
        for s in stops:
            if isinstance(s, dict):
                st = s.get("serviceType", "")
                if st:
                    service_types.add(st)
    diversity = len(service_types) / max(total_stops, 1)

    # Geographic spread
    lats, lngs = [], []
    if isinstance(stops, list):
        for s in stops:
            if isinstance(s, dict):
                lat = s.get("lat")
                lng = s.get("lng")
                if lat is not None and lng is not None:
                    lats.append(float(lat))
                    lngs.append(float(lng))
    spread = 0.0
    if lats and lngs:
        spread = math.sqrt((max(lats) - min(lats)) ** 2 + (max(lngs) - min(lngs)) ** 2)

    ai_generated = 1.0 if route_data.get("generatedBy") == "ai" else 0.0

    return [total_stops, drive_time, confidence, day_of_week, avg_duration, diversity, spread, ai_generated]


FEATURE_NAMES = [
    "total_stops", "drive_time_minutes", "confidence", "day_of_week",
    "avg_job_duration", "service_type_diversity", "geographic_spread", "ai_generated"
]


class TrainRequest(BaseModel):
    companyId: str


class PredictRequest(BaseModel):
    companyId: str
    routes: list[dict[str, Any]]


@router.post("/train")
def train_model(body: TrainRequest):
    """Train a per-company XGBoost model from route editing feedback."""
    db = _get_firestore()
    if db is None:
        raise HTTPException(status_code=503, detail="Firestore not configured")

    company_id = body.companyId
    LOGGER.info(f"Training model for company: {company_id}")

    # Fetch route history
    history_ref = db.collection(f"companies/{company_id}/routeHistory")
    docs = list(history_ref.order_by("modifiedAt", direction="DESCENDING").limit(1000).stream())

    if len(docs) < 5:
        return {"status": "skipped", "reason": f"Only {len(docs)} feedback records (need at least 5)"}

    # Build training data
    X, y = [], []
    for doc in docs:
        data = doc.to_dict()
        original = data.get("originalRoute", {})
        delta = data.get("deltaStops", {})

        features = _extract_features(original)
        # Target: how much editing was needed (lower = better route)
        change_score = len(delta.get("moved", [])) + len(delta.get("added", [])) + len(delta.get("removed", []))
        X.append(features)
        y.append(change_score)

    X_arr = np.array(X)
    y_arr = np.array(y)

    # Train XGBoost
    try:
        from sklearn.ensemble import GradientBoostingRegressor
        from sklearn.model_selection import train_test_split
        from sklearn.metrics import mean_squared_error

        X_train, X_test, y_train, y_test = train_test_split(X_arr, y_arr, test_size=0.2, random_state=42)

        model = GradientBoostingRegressor(
            n_estimators=100,
            max_depth=5,
            learning_rate=0.1,
            random_state=42,
        )
        model.fit(X_train, y_train)

        y_pred = model.predict(X_test)
        rmse = float(np.sqrt(mean_squared_error(y_test, y_pred)))
        max_change = float(max(y_arr.max(), 1))
        accuracy = max(0.0, 1.0 - (rmse / max_change))

        # Save model
        model_dir = MODELS_DIR / company_id
        model_dir.mkdir(parents=True, exist_ok=True)
        model_path = model_dir / "routing_model.pkl"
        with open(model_path, "wb") as f:
            pickle.dump(model, f)

        # Save metrics to Firestore
        from datetime import datetime
        metrics_ref = db.document(f"companies/{company_id}/modelMetrics/current")
        metrics_doc = metrics_ref.get()
        history = []
        if metrics_doc.exists:
            history = metrics_doc.to_dict().get("accuracyHistory", [])

        history.append({"date": datetime.utcnow().strftime("%Y-%m-%d"), "accuracy": round(accuracy, 4)})
        # Keep last 90 days
        history = history[-90:]

        metrics_ref.set({
            "lastTrainedAt": datetime.utcnow().isoformat() + "Z",
            "accuracy": round(accuracy, 4),
            "totalRoutesLearned": len(docs),
            "avgConfidence": round(float(np.mean([_extract_features(d.to_dict().get("originalRoute", {}))[2] for d in docs])), 4),
            "accuracyHistory": history,
        })

        LOGGER.info(f"Model trained for {company_id}: accuracy={accuracy:.4f}, rmse={rmse:.4f}")

        return {
            "status": "ok",
            "accuracy": round(accuracy, 4),
            "rmse": round(rmse, 4),
            "samplesUsed": len(docs),
            "modelPath": str(model_path),
        }

    except ImportError:
        raise HTTPException(status_code=500, detail="scikit-learn not installed")


@router.post("/predict-confidence")
def predict_confidence(body: PredictRequest):
    """Predict confidence scores for routes using the trained model."""
    company_id = body.companyId
    model_path = MODELS_DIR / company_id / "routing_model.pkl"

    if not model_path.exists():
        # No trained model yet — return default confidence
        return {
            "predictions": [{"confidence": 0.85, "source": "default"} for _ in body.routes],
        }

    with open(model_path, "rb") as f:
        model = pickle.load(f)

    predictions = []
    for route in body.routes:
        features = _extract_features(route)
        predicted_changes = float(model.predict([features])[0])
        # Convert predicted change score to confidence: fewer predicted changes = higher confidence
        # Clamp between 0.3 and 0.98
        confidence = max(0.3, min(0.98, 1.0 - (predicted_changes / 10.0)))
        predictions.append({"confidence": round(confidence, 4), "source": "model", "predictedChanges": round(predicted_changes, 2)})

    return {"predictions": predictions}
