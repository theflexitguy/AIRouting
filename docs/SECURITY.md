# API security

The dashboard's `/api/*` routes read and write Firestore with the **Admin SDK, which bypasses the Firestore security
rules**. So the routes themselves are the access control. Every route is wrapped in `guarded(...)`
(`src/lib/api-guard.ts`), and a test (`src/lib/api-auth.routes.test.ts`) fails the build if a route is added without one.

## Who can call what

| Caller | How | Can reach |
|---|---|---|
| Signed-in dashboard user | `Authorization: Bearer <Firebase ID token>` (the app's `apiFetch` adds it) | Their **own company's** data only. The company comes from their profile (`users/{uid}`); a request naming any other company gets 403. Reads: any member. Writes / spend (generate, approve, delete, geocode, upload, sync…): any member except accounts marked `role: "viewer"`. |
| Operator (you, and Vercel cron) | `CRON_SECRET` as `Authorization: Bearer …`, `x-cron-secret: …` or `?secret=…` | Everything, including the maintenance / debug / destructive routes below. |
| Anyone else | — | 401. |

**Operator-only** (no dashboard user can reach these, even an admin): `admin/delete-company`, `admin/diagnose-user`,
`admin/cleanup-csv-jobs`, `reset-routing`, `fieldroutes/reset-jobs`, `fieldroutes/reset-sync`, `fieldroutes/sync`,
`fieldroutes/recompute-past-due`, and every `fieldroutes/debug-*`.

Not behind the guard, by design: the MCP endpoint and OAuth endpoints (their own auth, see `docs/MCP.md`),
`account/init` (sign-up; verifies the ID token itself), `fieldroutes/manual-sync` (verifies the token itself), and
`admin/routing-status?summary=1` (public health summary; the full probe needs `CRON_SECRET`).

Calling an operator route by hand:

```bash
curl -X POST "https://<your-domain>/api/fieldroutes/reset-jobs" \
  -H "Authorization: Bearer $CRON_SECRET" -H "content-type: application/json" \
  -d '{"companyId":"company_xxx","confirm":"DELETE"}'
```

`CRON_SECRET` must be set in Vercel (production). If it is missing, operator access is **off** (nothing can use it), and
the cron jobs will fail with 401.

## Firestore rules and sign-up

Clients may **read** their own `users/{uid}` profile but may not **write** it (`firestore.rules`). Previously a browser
could write its own profile and name any `companyId` and `role`, which made it a member/admin of that company. Profiles
are now created by the server (`POST /api/account/init`), which always creates a *new* company.

**Deploy order matters:** ship the code first, then deploy the rules. Deploying the rules first would break sign-up for
new accounts until the code is live.

```bash
firebase deploy --only firestore:rules
```

If you do not want strangers to be able to create accounts at all, turn off *Email/Password sign-up* for new users in
Firebase Console → Authentication → Settings (User actions), or restrict it, since the onboarding page is public.

## Known limits

- Roles are enforced on the server only as "not an explicit viewer". Finer-grained roles (admin vs dispatcher) are a follow-up.
- Profiles are cached in memory for 30 s per server instance, so a role or company change takes up to 30 s to apply.
- ID tokens are not checked for revocation on every request (a disabled account keeps working until its token, at most an hour old, expires).
- `fieldroutes/reconcile-range` triggers a FieldRoutes sync for the company configured in the environment, whichever member calls it.
