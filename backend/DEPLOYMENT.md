# Internal Rollout (v1)

## Fast path (one command from your laptop)
1. Configure `/Users/jalenbrown/flex-routing/.env`:
   - `FR_SHARED_PASSWORD`
   - `FR_ALLOWED_ORIGINS`
   - `INTERNAL_HOST`
2. Run:
   - `VM_HOST=<vm-ip-or-host> VM_USER=<ssh-user> /Users/jalenbrown/flex-routing/ops/deploy/deploy_vm.sh`
3. Open:
   - `https://<INTERNAL_HOST>`

This script syncs the app to the VM, builds AR+MO+OK OSRM data, starts Docker Compose, and installs 90-day cleanup cron.

## AWS zero-touch path (provision + deploy)
If AWS credentials are already configured on your laptop:

- `. /Users/jalenbrown/flex-routing/.venv/bin/activate && /Users/jalenbrown/flex-routing/ops/deploy/provision_aws_and_deploy.sh`

Optional:
- `AWS_REGION=us-east-2`
- `TEAM_HTTPS_CIDR=<vpn-or-office-cidr>`

This script creates the EC2 instance, security group, installs Docker via user-data, updates `.env`, and then deploys the stack.

## Manual path
1. Build OSRM region:
   - `./ops/osrm/build-region.sh ./data/osrm region`
2. Start services:
   - `docker compose up -d --build`

Services:
- `app` (FastAPI)
- `osrm` (dedicated OSRM backend)
- `reverse-proxy` (Caddy HTTPS)

## Operations
- Health: `GET /healthz`
- Ready check: `GET /readyz`
- List runs: `GET /runs`
- Cleanup (90-day retention):
  - `RETENTION_DAYS=90 ./ops/cleanup/retention.sh /data`

## FieldRoutes Sandbox Pilot Gate (one-day)
Run this from the deployed server (same host as app data) so artifacts stay run-scoped.

1. Set env vars on server (do not commit secrets):
   - `FIELDROUTES_BASE_URL`
   - `FIELDROUTES_AUTH_KEY`
   - `FIELDROUTES_AUTH_TOKEN`
   - optional: `FIELDROUTES_TIMEOUT_SEC` (default `30`)
   - optional: `FIELDROUTES_WRITE_QPS` (default `8`)
   - optional: `FIELDROUTES_BYPASS_LOCKED_ROUTE` (default `0`)
   - optional: `FIELDROUTES_BYPASS_SCHEDULE_PERMISSION` (default `0`)
   - optional: `FIELDROUTES_CREATE_MISSING_APPOINTMENTS` (default `1`)
   - optional: `FIELDROUTES_DEFAULT_SERVICE_ID` (default `2`; used for create-missing flow if CSV has no `serviceID`/`type`)
2. Dry-run pilot for one date:
   - `docker compose exec -T app python scripts/push_fieldroutes.py --run-id <runId> --edited --date 2026-04-01 --dry-run`
3. Review artifacts in `/data/runs/<runId>/`:
   - `fieldroutes_push_report.json`
   - `fieldroutes_push_exceptions.csv`
   - `fieldroutes_request_log.ndjson`
4. Apply same scope:
   - `docker compose exec -T app python scripts/push_fieldroutes.py --run-id <runId> --edited --date 2026-04-01 --apply`
5. Idempotency check:
   - rerun dry-run command; expect mostly `unchanged`.

Notes:
- Matching policy is `skip + report` for missing/ambiguous records.
- Primary appointment key is `(subscriptionID, routeDate)` when available, then strict fallback to `(customerID, routeDate)`.
- Duration is not written unless `--sync-duration` is explicitly passed.

## Notes
- Single active routing run at a time (conflicts return HTTP 409 with `activeRunId`).
- All outputs are run-isolated under `/data/runs/<runId>/`.
- Existing legacy root files remain as fallback for backward compatibility.
