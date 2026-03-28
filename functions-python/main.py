import json
import math
import os
import pickle
import tempfile
from datetime import datetime, timedelta
from typing import Any

import functions_framework
import firebase_admin
from firebase_admin import credentials, firestore, storage
import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_squared_error
import xgboost as xgb

# Initialize Firebase Admin
if not firebase_admin._apps:
    cred_json = os.environ.get("FIREBASE_ADMIN_SERVICE_ACCOUNT", "{}")
    if cred_json and cred_json != "{}":
        cred = credentials.Certificate(json.loads(cred_json))
        firebase_admin.initialize_app(cred, {
            "storageBucket": os.environ.get("FIREBASE_STORAGE_BUCKET", "")
        })
    else:
        firebase_admin.initialize_app()

db = firestore.client()


def extract_route_features(route_data: dict, jobs_data: dict) -> dict[str, float]:
    """Extract ML features from a route."""
    stop_seq = route_data.get("stopSequence", [])
    date_str = route_data.get("date", "")

    features = {
        "total_stops": len(stop_seq),
        "drive_time_minutes": route_data.get("totalDriveTimeMinutes", 0),
        "confidence": route_data.get("confidence", 0.5),
        "day_of_week": 0,
        "avg_job_duration": 60.0,
        "service_type_diversity": 0.0,
        "geographic_spread": 0.0,
        "ai_generated": 1 if route_data.get("generatedBy") == "ai" else 0,
    }

    # Extract day of week from date
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        features["day_of_week"] = dt.weekday()  # 0=Monday, 6=Sunday
    except (ValueError, TypeError):
        pass

    # Calculate job-based features
    route_jobs = [jobs_data.get(jid, {}) for jid in stop_seq]
    valid_jobs = [j for j in route_jobs if j]

    if valid_jobs:
        durations = [j.get("duration", 60) for j in valid_jobs]
        features["avg_job_duration"] = sum(durations) / len(durations)

        service_types = set(j.get("serviceType", "") for j in valid_jobs)
        features["service_type_diversity"] = len(service_types) / max(len(valid_jobs), 1)

        lats = [j.get("lat", 0) for j in valid_jobs if j.get("lat")]
        lngs = [j.get("lng", 0) for j in valid_jobs if j.get("lng")]
        if lats and lngs:
            lat_spread = max(lats) - min(lats)
            lng_spread = max(lngs) - min(lngs)
            features["geographic_spread"] = math.sqrt(lat_spread**2 + lng_spread**2)

    return features


@functions_framework.http
def train_routing_model(request):
    """Train XGBoost model on historical route data."""
    request_json = request.get_json(silent=True) or {}
    company_id = request_json.get("companyId") or request.args.get("companyId")

    if not company_id:
        return {"error": "companyId is required"}, 400

    try:
        # Fetch route history
        history_ref = db.collection(f"companies/{company_id}/routeHistory")
        history_docs = history_ref.limit(1000).stream()

        history_records = [doc.to_dict() for doc in history_docs]

        if len(history_records) < 5:
            return {
                "success": False,
                "message": f"Insufficient training data: {len(history_records)} routes (need at least 5)",
                "totalRoutesLearned": len(history_records)
            }, 200

        # Fetch all jobs for feature extraction
        jobs_ref = db.collection(f"companies/{company_id}/jobs")
        jobs_docs = jobs_ref.stream()
        jobs_data = {doc.id: doc.to_dict() for doc in jobs_docs}

        # Build feature dataset
        features_list = []
        targets = []  # Target: drive time efficiency (lower is better)

        for record in history_records:
            orig_route = record.get("originalRoute", {})
            mod_route = record.get("modifiedRoute", {})
            delta = record.get("deltaStops", {})

            if not orig_route:
                continue

            orig_features = extract_route_features(orig_route, jobs_data)

            # Target: number of stops moved (0 = perfect AI route, higher = needed more human fixes)
            n_moved = len(delta.get("moved", []))
            n_added = len(delta.get("added", []))
            n_removed = len(delta.get("removed", []))
            change_score = n_moved + n_added + n_removed

            features_list.append(orig_features)
            targets.append(float(change_score))

        if len(features_list) < 5:
            return {"success": False, "message": "Not enough valid training records"}, 200

        df = pd.DataFrame(features_list)
        y = np.array(targets)

        X_train, X_test, y_train, y_test = train_test_split(df, y, test_size=0.2, random_state=42)

        # Train XGBoost model
        model = xgb.XGBRegressor(
            n_estimators=100,
            max_depth=5,
            learning_rate=0.1,
            subsample=0.8,
            colsample_bytree=0.8,
            random_state=42,
            eval_metric="rmse",
        )
        model.fit(X_train, y_train, eval_set=[(X_test, y_test)], verbose=False)

        y_pred = model.predict(X_test)
        rmse = math.sqrt(mean_squared_error(y_test, y_pred))
        accuracy = max(0.0, 1.0 - (rmse / (y.max() + 1)))

        # Save model to Firebase Storage
        with tempfile.NamedTemporaryFile(suffix=".pkl", delete=False) as tmp:
            pickle.dump(model, tmp)
            tmp_path = tmp.name

        try:
            bucket = storage.bucket()
            blob = bucket.blob(f"models/{company_id}/routing_model.pkl")
            blob.upload_from_filename(tmp_path, content_type="application/octet-stream")
            model_saved = True
        except Exception as e:
            print(f"Storage upload failed: {e}")
            model_saved = False
        finally:
            os.unlink(tmp_path)

        # Build accuracy history
        metrics_ref = db.document(f"companies/{company_id}/modelMetrics/current")
        existing_metrics = metrics_ref.get()
        accuracy_history = []
        if existing_metrics.exists:
            accuracy_history = existing_metrics.to_dict().get("accuracyHistory", [])

        accuracy_history.append({
            "date": datetime.utcnow().strftime("%Y-%m-%d"),
            "accuracy": round(accuracy, 4)
        })
        accuracy_history = accuracy_history[-90:]  # keep 90 days

        # Update metrics
        metrics = {
            "lastTrainedAt": datetime.utcnow().isoformat(),
            "accuracy": round(accuracy, 4),
            "totalRoutesLearned": len(history_records),
            "avgConfidence": round(float(np.mean([r.get("originalRoute", {}).get("confidence", 0.5) for r in history_records])), 4),
            "accuracyHistory": accuracy_history,
            "modelSaved": model_saved,
            "rmse": round(rmse, 4),
            "trainingSize": len(X_train),
            "testSize": len(X_test),
        }
        metrics_ref.set(metrics)

        return {
            "success": True,
            "accuracy": round(accuracy, 4),
            "rmse": round(rmse, 4),
            "totalRoutesLearned": len(history_records),
            "trainingSize": len(X_train),
            "modelSaved": model_saved,
        }

    except Exception as e:
        print(f"Training error: {e}")
        return {"error": f"Training failed: {str(e)}"}, 500


@functions_framework.http
def get_route_confidence(request):
    """Predict confidence score for a proposed route."""
    request_json = request.get_json(silent=True) or {}
    company_id = request_json.get("companyId")
    route_data = request_json.get("route", {})

    if not company_id or not route_data:
        return {"error": "companyId and route are required"}, 400

    try:
        # Load model from Storage
        bucket = storage.bucket()
        blob = bucket.blob(f"models/{company_id}/routing_model.pkl")

        if not blob.exists():
            # Return default confidence if no model
            return {"confidence": 0.5, "source": "default"}, 200

        with tempfile.NamedTemporaryFile(suffix=".pkl", delete=False) as tmp:
            blob.download_to_filename(tmp.name)
            model = pickle.load(open(tmp.name, "rb"))
            os.unlink(tmp.name)

        # Get jobs data for features
        jobs_ref = db.collection(f"companies/{company_id}/jobs")
        jobs_docs = jobs_ref.stream()
        jobs_data = {doc.id: doc.to_dict() for doc in jobs_docs}

        features = extract_route_features(route_data, jobs_data)
        df = pd.DataFrame([features])

        change_score = float(model.predict(df)[0])
        max_stops = features.get("total_stops", 1)
        confidence = max(0.1, min(0.99, 1.0 - (change_score / max(max_stops, 1))))

        return {"confidence": round(confidence, 4), "source": "model", "changeScore": round(change_score, 2)}

    except Exception as e:
        print(f"Confidence prediction error: {e}")
        return {"confidence": 0.5, "source": "fallback", "error": str(e)}, 200
