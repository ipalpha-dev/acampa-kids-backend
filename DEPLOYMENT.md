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
| `SESSION_TOKEN_KEY` | Secret `acampa-2025-secrets`, key `session-token-key` — 32 bytes (`openssl rand -hex 32`); seals the per-role IPAlpha tokens kept in each session (AES-256-GCM). Rotating it ends every session |
| `SESSION_HOURS` | `96` (fallback only; auth-api's `sessionIdleHours` wins) |
| `SUPER_ADMIN_PERSON_IDS` | comma list of IPAlpha person ids of the deployment owners |
| `TRUST_PROXY_HOPS` | `1` (Traefik appends the real peer as the last `X-Forwarded-For` entry). Set to the number of appending proxies; `0` ignores the header |
| `APP_URL` | `https://ipalpha-kids-camping.kevyn.com.br` (the `{link}` of the message templates) |
| `NOTIFY_COALESCE_SECONDS` | `20` |
| `IPALPHA_ENV` | `prod` in production; `preview` / `dev` enable the wizard's synthetic sample camp (decision 71 — anything else answers 403 `SAMPLE_DISABLED`) |
| `AI_BASE_URL` | `https://ai-models.kevyn.com.br/v1` |
| `AI_API_KEY` | Secret `acampa-2025-secrets`, key `ai-api-key`; optional, empty disables AI |
| `OPENROUTER_API_KEY` | Secret `acampa-2025-secrets`, key `openrouter-api-key`; optional. Empty disables the editor's icon suggestions (imports no longer use AI in Acampa — persons-api runs them through ai-api, cost on the project) |
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
| `IPALPHA_AUTH_API_URL` | auth-api base URL (server-to-server; JWKS at `/.well-known/jwks.json`). **Every `IPALPHA_*` below (+ `SESSION_TOKEN_KEY`) is required — any missing = nobody can sign in** (boot logs the missing names, never values) |
| `IPALPHA_AUTH_ORIGIN` | auth-webapp origin that hosts the sign-in popup / One Tap frame |
| `IPALPHA_PERSONS_API_URL` | persons-api base URL (names, health, registrations, links, count, birthdays today) |
| `IPALPHA_NOTIFICATIONS_API_URL` | notifications-api base URL (template messages by person id) |
| `IPALPHA_TOKEN_ISSUER` | auth-api `iss` |
| `IPALPHA_CLIENT_ID`, `IPALPHA_ENTRY_POINT`, `IPALPHA_REDIRECT_URI` | Acampa's confidential external entry point in auth-api |
| `IPALPHA_CLIENT_SECRET` | Secret ref only — the entry point's client secret |
| `IPALPHA_SYSTEM_CLIENT_ID` | Acampa's app-bound system client: `login:relay`, `projects:editions`, `projects:app-members`, `projects:templates`, `persons:app-names`, `notifications:send-template`, `dispatch:app-channel` (CONTRACTS §14, §22) |
| `IPALPHA_SYSTEM_CLIENT_SECRET` | Secret ref only |
| `IPALPHA_PROJECT_ID` | the yearly Acampa project (camps = its editions; roles = its memberships) |
| `IPALPHA_PROJECTS_API_URL` | projects-api base URL (editions, memberships, message templates) |
| `IPALPHA_DISPATCH_URL` | optional — dispatch-api origin for the ONE app-channel socket (`/api/dispatch/socket.io`, namespace `/apps`). Empty = no socket: import batches arrive by webhook and by the catch-up (boot, the importer's reads) from persons-api |
| `IPALPHA_WEBHOOK_SECRET` | Secret ref only — the app webhook signing secret (Mordomia / Developers portal → app → webhook, shown once). Webhook URL to register: `https://<acampa host>/api/dispatch/webhook`. Empty = the webhook answers 503 |

MongoDB uses `MONGO_INITDB_ROOT_USERNAME` / `MONGO_INITDB_ROOT_PASSWORD`
from `mongo-credentials`, and `MONGO_INITDB_DATABASE=camping`. These initialize
an empty database only; changing the Secret does not rotate an existing DB user.

The frontend needs **no production environment variables**: `/api`, uploaded
images, and WebSocket traffic use the browser origin, routed by Traefik.
`VITE_API_URL` is an optional **build-time** override, not an nginx runtime
variable. `DEV_LAN` is development-only. Docker excludes local `.env` files.

### Rotating or adding a secret key

`acampa-2025-secrets` already exists, so **patch** it — never re-create it from a
single `--from-literal`, that would drop `session-token-key` and the rest. Read the value
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
- There is **no worker Deployment any more** (decision 58): spreadsheet imports
  run in persons-api. Delete the old worker Deployment and the `worker-secret`
  key when rolling this version out.
- Probes: `GET /live` (always 200) for liveness, `GET /ready` (200 only when
  boot finished and MongoDB answers; 503 `{ready, checks, info}` otherwise —
  `info.dispatch` shows the app-channel socket state and never gates) for
  readiness/startup. The server listens before MongoDB connects; `/api/*`
  answers 503 `STARTING` until boot finished.
- **Indexes never block boot (decision 91).** An index MongoDB refuses
  (duplicate keys under a unique index, an index of the same name with other
  keys / options…) is logged once as `[indexes] <collection>.<name> not created
  (code <n> <CodeName>)` — the name and the error code only, never the
  message (a duplicate-key message carries document values) — and boot goes
  on. `/ready` then stays **200** with `checks.indexes: "degraded"`, so the pod
  keeps serving (slower queries / no uniqueness guard on that index); only
  MongoDB itself being down answers 503. Fix the data or drop the conflicting
  index by hand, then restart the backend to re-create it. Indexes whose keys
  changed in the IPAlpha rewrite carry new names (`*_v2`: e.g.
  `campId_1_dose_scheduled_unique_v2`, `personId_campId_unique_v2`), so they never
  collide with an index an older version left behind.
- Keep ONE backend replica: dispatch keeps exactly one app-channel socket per
  app (a second instance would replace the first; the replaced one stops).
- Startup only creates indexes (see above) and guarantees one active camp; it
  runs **no data migration** and reads no collection or field of an older
  version (decision 90).
- Backups (`bun run scripts/backup.ts`) dump an explicit ALLOWLIST of this
  version's collections (`src/services/backupScope.ts`); a restore writes only
  those. Sessions, sign-ins in flight, import jobs and any leftover of an older
  version are never exported.
- Do not upload local development `data/` to production: file metadata must match
  the target database. Runtime pictures, `.env`, and scratch files are excluded
  from Git/build contexts.
- Check Settings → notification toggles before real use. Do not
  send login codes or enable broadcasts just to smoke-test a deployment.

## Boot and the IPAlpha cut-over

At boot `ensureFirstCamp()` (`services/campMigration.ts`) only guarantees one
active camp; there is **no data migration** (decisions 33, 90). People, roles and
contacts live in IPAlpha: before the first camp on this version, provision the
Acampa app / project / editions / clients through the core seams (deployment
§8) and seed the message templates (`bun scripts/templates-json.ts` prints the
catalog; or Settings → Mensagens → "Criar modelos"). Backups are format v3;
older files are refused.

### Cut-over checklist (decision 90 — Kevyn: "clean all the data. no need to backup")

The old Acampa data is **not** kept: the production `camping` database is
dropped entirely, **without a backup**, and the new version starts empty.

1. Stop the old backend so nothing writes meanwhile:
   `kubectl -n ipalpha-kids scale deploy/acampa-2025-backend --replicas=0`
   (and delete the old worker Deployment + the `worker-secret` key).
2. **Drop the whole `camping` database** (no backup, no export):

   ```bash
   kubectl -n ipalpha-kids exec deploy/acampa-2025-mongo -- sh -c \
     'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" \
        --authenticationDatabase admin --eval "db.getSiblingDB(\"camping\").dropDatabase()"'
   ```

   Check it is gone (`--eval "db.adminCommand({listDatabases:1}).databases.map(d=>d.name)"`).
3. Empty the pictures volume (`/mnt/k8s-data/ipalpha/kids/acampa-2025/pictures`):
   its files belonged to the dropped database's metadata and can no longer be
   reached — kids' photos are not kept around unreachable.
4. Publish the new version (`./publish -d`, then `./publish`) and verify the
   running image, the rollout (old pods gone) and `GET /ready` →
   `{ ready: true, checks: { mongo: "ok", indexes: "ok" } }`.
5. Provision core (above) and create the first edition's data in the app.

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
