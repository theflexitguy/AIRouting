# RouteIQ Python Cloud Functions

## Functions

### `train_routing_model` (HTTP)
POST with `{ "companyId": "..." }` to train the XGBoost model on historical routes.

### `get_route_confidence` (HTTP)
POST with `{ "companyId": "...", "route": {...} }` to get AI confidence score.

## Local Development
```bash
pip install -r requirements.txt
functions-framework --target=train_routing_model --port=8080
```

## Deploy to Cloud Run
```bash
gcloud run deploy routeiq-train-model \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars FIREBASE_ADMIN_SERVICE_ACCOUNT='...'
```
