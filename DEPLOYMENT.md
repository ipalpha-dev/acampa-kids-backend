# Production deployment

- URL: https://ipalpha-kids-camping.kevyn.com.br
- Namespace: `ipalpha-kids`; node: `kevyn-local-server`.
- Manifests: `~/WebstormProjects/k8s/ipalpha/kids/acampa-2025/`.
- Release from the parent `camping/` directory with `./publish -d`, then `./publish`.
  The tool commits/pushes both changed application repositories and the Kubernetes
  manifests; CI builds the versioned images and applies the manifests. Always
  verify the running image versions and rollout, not just the Git push.

## Environment inventory

All values below are backend runtime variables. Never put credentials into
committed YAML or frontend `VITE_*` variables.

| Variable | Production value / source |
|---|---|
| `NODE_ENV` | `production` (Bun/runtime) |
| `PORT` | `3000` |
| `CORS_ORIGIN` | `https://ipalpha-kids-camping.kevyn.com.br` |
| `MONGODB_URI` | `mongodb://$(MONGO_USERNAME):$(MONGO_PASSWORD)@acampa-2025-mongo:27017/camping?authSource=admin` |
| `MONGODB_DB` | `camping` |
| `MONGO_USERNAME`, `MONGO_PASSWORD` | Deployment-only expansion variables from Secret `mongo-credentials`, keys `username`, `password`; credentials must be URI-safe |
| `FILES_DIR` | `/app/data/files`, mounted from `acampa-2025-pictures-pvc` |
| `JWT_SECRET` | Secret `acampa-2025-secrets`, key `jwt-secret`; required, strong, never the development default |
| `SESSION_HOURS` | `96` |
| `TRUST_PROXY_HOPS` | `1` (Traefik appends the real peer as the last `X-Forwarded-For` entry). Set to the number of appending proxies; `0` ignores the header |
| `OTP_EXPIRE_MINUTES` | `5` |
| `OTP_MAX_ATTEMPTS` | `3` |
| `ACCOUNT_FREEZE_MINUTES` | `30` |
| `RESEND_COOLDOWN_SECONDS` | `60` |
| `COMTELE_API_KEY` | Secret `acampa-2025-secrets`, key `comtele-api-key`; required in production. Empty enables console-only mock OTP |
| `COMTELE_PREFIX` | `AcampaKids` |
| `APP_URL` | `https://ipalpha-kids-camping.kevyn.com.br` (SMS links) |
| `PUBLIC_ORIGIN` | `https://ipalpha-kids-camping.kevyn.com.br` (image URLs in notification emails). Alias `BACKEND_PUBLIC_URL`. Empty = mail send is refused |
| `SENDGRID_API_KEY` | Optional Secret `acampa-2025-secrets`, key `sendgrid-api-key`. Empty = notification emails are logged only |
| `MAIL_FROM` | `alphakids@kevyn.com.br` (verified SendGrid sender) |
| `MAIL_FROM_NAME` | `Acampa Kids` |
| `NOTIFY_COALESCE_SECONDS` | `20` |
| `IMPORT_ADMIN_PHONE` | Admin E.164 phone notified when an AI import review takes over five minutes |
| `IMPORT_SUPER_ADMIN_PHONE` | Super-admin E.164 phone for import error alerts; default `+5561985891092` |
| `WORKER_SECRET` | Secret `acampa-2025-secrets`, key `worker-secret`; shared by the API and the import worker for `POST /api/worker/reviewed` (websocket event per reviewed record). **Required (not optional): pods fail to start without the key — patch the Secret before rolling out** |
| `BACKEND_URL` | Worker only: `http://acampa-2025-backend:3000` (cluster-internal API address for the callback) |
| `SUPER_ADMIN_PHONE` | E.164 phone guaranteed the top-level `admin` login role at API startup |
| `AI_BASE_URL` | `https://ai-models.kevyn.com.br/v1` |
| `AI_API_KEY` | Secret `acampa-2025-secrets`, key `ai-api-key`; optional, empty disables AI |
| `OPENROUTER_API_KEY` | Secret `acampa-2025-secrets`, key `openrouter-api-key`; optional. Empty disables Jev (icon suggestions + every closed import decision: column mapping, health bucketing, option/transport/team/leader matching, neurodivergent yes/no, name sex) — the generative fallback then does all of it, slower. Worker also needs it for health structuring |
| `AI_TRANSCRIBE_URL` | `https://whisper.kevyn.com.br/v1`; empty hides voice input |
| `AI_TRANSCRIBE_MODEL` | `whisper-large-v3-turbo` |
| `AI_TRANSCRIBE_KEY` | Optional Secret key `ai-transcribe-key`; leave absent if the speech endpoint needs no authentication |
| `AI_LIVE_BASE_URL` | `https://api.openai.com/v1` — GPT-Live needs OpenAI directly; the gateway has no `/v1/live` |
| `AI_LIVE_API_KEY` | Secret `acampa-2025-secrets`, key `ai-live-api-key`; **optional**, empty disables the assistant drawer |
| `AI_LIVE_MODEL` | voice model running the spoken conversation (`gpt-live-1`) |
| `AI_LIVE_VOICE` | voice it answers in (default `marin`; Brazilian Portuguese: `bossa` feminine or `tempo` masculine) |
| `AI_LIVE_BACKEND_MODEL` | reasoning model GPT-Live delegates to, and the one that reads MongoDB (`gpt-5.6-terra`) |
| `FACE_SERVICE_URL` | `http://acampa-2025-face:8000` (cluster-internal only). Empty disables the parents' photo search |
| `FACE_MATCH_THRESHOLD` | `0.22`; low so parents find their kid (a few other children in the results is ok) |
| `FACE_MIN_DETECTION_SCORE` | `0.4` |
| `IPALPHA_AUTH_API_URL` | auth-api base URL (server-to-server; JWKS at `/.well-known/jwks.json`). **IPAlpha login needs every required `IPALPHA_*` below — any missing = feature off** (boot logs the missing names) |
| `IPALPHA_AUTH_ORIGIN` | auth-webapp origin that hosts the sign-in popup / One Tap frame |
| `IPALPHA_PERSONS_API_URL` | persons-api base URL (first-login phone read) |
| `IPALPHA_TOKEN_ISSUER` | auth-api `iss` |
| `IPALPHA_CLIENT_ID`, `IPALPHA_ENTRY_POINT`, `IPALPHA_REDIRECT_URI` | Acampa's confidential external entry point in auth-api |
| `IPALPHA_CLIENT_SECRET` | Secret ref only — the entry point's client secret |
| `IPALPHA_SYSTEM_CLIENT_ID` | Acampa's app-bound system client (`login:relay`, `projects:editions`) |
| `IPALPHA_SYSTEM_CLIENT_SECRET` | Secret ref only |
| `IPALPHA_PROJECT_ID` | optional: the Acampa project (project-scoped sign-in + yearly edition rollover) |
| `IPALPHA_PROJECTS_API_URL` | optional: projects-api base URL; needed with `IPALPHA_PROJECT_ID` for the edition rollover on camp activation |

MongoDB uses `MONGO_INITDB_ROOT_USERNAME` / `MONGO_INITDB_ROOT_PASSWORD`
from `mongo-credentials`, and `MONGO_INITDB_DATABASE=camping`. These initialize
an empty database only; changing the Secret does not rotate an existing DB user.

The frontend needs **no production environment variables**: `/api`, uploaded
images, and WebSocket traffic use the browser origin, routed by Traefik.
`VITE_API_URL` is an optional **build-time** override, not an nginx runtime
variable. `DEV_LAN` is development-only. Docker excludes local `.env` files.

### Rotating or adding a secret key

`acampa-2025-secrets` already exists, so **patch** it — never re-create it from a
single `--from-literal`, that would drop `jwt-secret` and the rest. Read the value
from the terminal so it never reaches shell history or the process table:

```bash
read -rs "?AI_LIVE_API_KEY: " value; echo
jq -n --arg v "$value" '{stringData:{"ai-live-api-key":$v}}' \
  | kubectl -n ipalpha-kids patch secret acampa-2025-secrets --type merge --patch-file /dev/stdin
unset value
kubectl -n ipalpha-kids rollout restart deploy/acampa-2025-backend
```

(`read -rs "?prompt"` is zsh; in bash it is `read -rs -p "AI_LIVE_API_KEY: " value`.)

`OPENROUTER_API_KEY` (icon suggestions + spreadsheet mapping) is collected the same way, or with:

```bash
./backend/scripts/collect-openrouter-secret.sh            # prompt, never hits shell history
./backend/scripts/collect-openrouter-secret.sh --from-env # copy from backend/.env
```

## Face service (parents' photo search)

- Manifest: `face-service.yaml` (Deployment + ClusterIP Service + `acampa-2025-face-models-pvc`).
- Repo: `ipalpha-acampa-kids-2025-face-service` (sibling folder `../face-service`),
  image `registry.kevyn.com.br/ip-alpha/kids/acampa-2025-face`, published by the
  parent folder's `./publish` like the backend and the frontend.
- Requests one time-sliced GPU (`nvidia.com/gpu: 1`, `runtimeClassName: nvidia`).
  It also runs on CPU: drop the GPU limit and the runtime class, expect seconds
  per photo instead of fractions.
- First start downloads the InsightFace `buffalo_l` pack into the PVC; the
  startup probe allows up to ten minutes for it.
- Never expose it through the ingress. It is the only component that sees a
  parent's reference photo, and it stores nothing.
- Rolling the backend re-runs the face backfill for photos without
  `facesIndexedAt`; indexing failures are simply retried on the next boot.

## Persistent data and upgrades

- MongoDB: `/mnt/k8s-data/ipalpha/kids/acampa-2025/mongo`.
- Pictures (editor images, album originals, thumbnails):
  `/mnt/k8s-data/ipalpha/kids/acampa-2025/pictures` → `/app/data/files`.
- Both PVs use local storage, node affinity, and `Retain`. The pictures claim
  explicitly binds its PV. The declared 20Gi capacity is not a filesystem quota:
  monitor free space on the server and keep off-host backups.
- The backend currently runs as root, matching the root-owned pictures directory.
  If switching to a non-root container, migrate directory ownership first.
- Keep one backend replica with `Recreate`: realtime sockets and notification
  timers are process-local. A rollout causes a brief API interruption; clients
  reconnect. MongoDB also uses `Recreate` to avoid two writers on its data files.
- Run a separate worker Deployment from the same backend image with command
  `bun run src/worker.ts`. Keep one replica: it claims 15 imported campers at a
  time, reviews them in parallel, requeues stale claims on startup and sleeps
  for 10 seconds only when the queue is empty.
- Startup creates indexes and performs one-off migrations (including transports,
  teams, parent-edit stamps, and admin roster entries). Back up MongoDB before
  publishing. A code rollback does **not** undo these data migrations.
- Legacy images in MongoDB migrate lazily when read; no manual copy is needed.
  Do not upload local development `data/` to production: file metadata must match
  the target database. Runtime pictures, `.env`, and scratch files are excluded
  from Git/build contexts.
- Check Settings → notification toggles and SMS redirect before real use. Do not
  send OTPs or enable broadcasts just to smoke-test a deployment.

## Multi-year camps boot migration

`migrateToCamps()` (`services/campMigration.ts`) runs once on every boot,
right after `ensureCampsCollection()` and before the rest of the index setup
(`index.ts`). It is idempotent — safe against an already-migrated database,
and safe against a fresh one:

1. **First camp.** If the `camps` collection is empty, inserts one `{ label:
   "Acampa Kids <year>", year, active: true }` — `year` comes from the
   earliest `schedule_events.date`, else today's year. A pre-existing
   single-camp deployment becomes this camp's **active** year.
2. **Stamp.** Every document in a SCOPED collection with no `campId` gets the
   active camp's id (`updateMany({ campId: { $exists: false } }, { $set: {
   campId } })`, per collection).
3. **Settings.** The single `settings._id: "global"` document is copied to
   `_id: <activeCampId>` (the old `"global"` document is left in place,
   unused).
4. **Legacy indexes.** Every SCOPED collection's index whose key does **not**
   start with `campId` is dropped (`bedrooms.name`, `categories.key`,
   `schedule_roles.name`, `staff.phone`, the `medicationDoses` scheduled-key
   unique index…) — the `ensure*Indexes()` calls right after this recreate
   them through the scoped `Db` wrapper as `{ campId, ... }`, so a second
   camp never collides with the first on the old unique keys.
5. **User marks.** `users.prepDone` / `welcomeSentAt` / `photosSmsSentAt`
   move to `userCampState` rows for the first camp, then are unset from
   `users`.

Expect log lines like:

```
🏕️  camps: created the first camp — "Acampa Kids 2025"
🏕️  camps: stamped campId on 148 "campers" document(s)
🏕️  camps: copied settings.global → settings for the active camp
🏕️  camps: dropped legacy index "bedrooms.name_1"
🏕️  camps: moved prep/welcome marks of 42 user(s) to userCampState
🏕️  active camp: "Acampa Kids 2025" (<id>)
```

A database already on multi-year camps just prints the last line — steps 1–5
find nothing to do.

### Upgrading an existing deployment

**Take a backup first** (`bun run backup`, from `backend/`) — the migration
touches every collection in the database. Then roll out the new image as
usual; the migration runs automatically at boot, before the API accepts
traffic. No manual step, no downtime beyond the normal rollout window (one
replica, `Recreate` — see "Persistent data and upgrades" above).

## Verification

```bash
kubectl apply --dry-run=server -f ~/WebstormProjects/k8s/ipalpha/kids/acampa-2025/
kubectl -n ipalpha-kids get pvc
kubectl -n ipalpha-kids rollout status deploy/acampa-2025-backend
kubectl -n ipalpha-kids rollout status deploy/acampa-2025-frontend
kubectl -n ipalpha-kids exec deploy/acampa-2025-backend -- \
  bun -e 'console.log(await (await fetch("http://localhost:3000/health")).json())'
curl -I https://ipalpha-kids-camping.kevyn.com.br
```

`/health` is an internal liveness endpoint, not routed through the public
frontend ingress. It confirms startup, not ongoing DB availability. Verify an
API request and stored-image retrieval separately, plus that a filesystem write
inside `/app/data/files` appears in the server's pictures directory.
