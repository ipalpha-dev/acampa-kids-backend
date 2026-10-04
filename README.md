# Camping Backend 🏕️

Backend for the children's camping management app of **Igreja Presbiteriana em Alphaville**.
Built with **Bun** + **Hono** + **MongoDB**.

## Stack

- **Runtime**: [Bun](https://bun.sh)
- **HTTP framework**: [Hono](https://hono.dev)
- **Database**: MongoDB (official driver)
- **Auth**: phone + OTP (SMS via [Comtele](https://docs.comtele.com.br)), JWT sessions valid for **4 days**

## Getting started

```bash
bun install

# start the project's own MongoDB container (camping-mongo, host port 27019)
docker compose up -d

# start the API (watch mode)
bun run dev
```

The API listens on `http://localhost:3000` by default.

## Environment

Copy `.env.example` to `.env` for local development. Production configuration and the full variable inventory are documented in [`DEPLOYMENT.md`](./DEPLOYMENT.md). Key variables:

| Variable | Description |
|---|---|
| `MONGODB_URI` / `MONGODB_DB` | MongoDB connection. Code defaults to `mongodb://localhost:27017` / `camping`; the local compose container uses host port `27019` |
| `FILES_DIR` | folder holding the uploaded image bytes (editor pictures + the photo album's photos and thumbnails; Mongo keeps only the metadata). Default `data/files`. **Mount a volume here in production** — images stored inside Mongo by older versions are migrated to disk on first read |
| `COMTELE_API_KEY` | Comtele API key (get it at https://sms.comtele.com.br). **Empty = mock mode**: OTP codes are printed to the server console instead of being sent by SMS |
| `OTP_EXPIRE_MINUTES` | OTP lifetime (default `5`) |
| `OTP_MAX_ATTEMPTS` | wrong attempts before freezing the account (default `3`) |
| `ACCOUNT_FREEZE_MINUTES` | how long the account stays frozen (default `30`) |
| `SESSION_HOURS` | session token lifetime (default `96`, 4 days); an IPAlpha login uses the `sessionIdleHours` auth-api returned for it |
| `TRUST_PROXY_HOPS` | proxies in front of the API that append to `X-Forwarded-For` (default `1` = Traefik ingress). The client IP is that many entries from the right; `0` = socket address only |
| `IPALPHA_*` | IPAlpha login (optional; all required ones or the feature is off) — see [IPAlpha login](#ipalpha-login-core-auth-api-) and `DEPLOYMENT.md` |
| `APP_URL` | public URL of the frontend, appended to notification SMS (optional) |
| `PUBLIC_ORIGIN` | public origin of the site (frontend + `/api`). Prefixes images in notification emails. Empty = mail send is refused. Alias: `BACKEND_PUBLIC_URL` |
| `SENDGRID_API_KEY` | SendGrid API key for `POST https://api.sendgrid.com/v3/mail/send`. **Empty = mock mode**: emails are printed to the server console |
| `MAIL_FROM` / `MAIL_FROM_NAME` | From-address (verified SendGrid sender, required with the API key to send) and display name (default `Acampa Kids`) |
| `FACE_SERVICE_URL` | private face service (repo `ipalpha-acampa-kids-2025-face-service`, sibling folder `../face-service`) used to index gallery faces and run the parents' photo search. **Empty = face search disabled** (parents still see the published album) |
| `FACE_MATCH_THRESHOLD` | cosine similarity a gallery face must reach to count as a match (default `0.22`) — low so parents find their kid; a few other children in the results is acceptable |
| `FACE_MIN_DETECTION_SCORE` | detections below this are ignored, both when indexing and when reading the reference (default `0.4`) |
| `NOTIFY_COALESCE_SECONDS` | changes to the same person within this window become one SMS (default `20`) |
| `AI_BASE_URL` / `AI_API_KEY` | OpenAI-compatible API used by the existing editor AI helpers |
| `AI_LIVE_BASE_URL` / `AI_LIVE_API_KEY` | OpenAI **Live** API for the spoken, two-way assistant (`POST /v1/live/sessions`). An OpenAI-compatible gateway is not enough. **Empty key = the drawer shows as unavailable** |
| `AI_LIVE_MODEL` | voice model that runs the conversation (default `gpt-live-1`) |
| `AI_LIVE_VOICE` | the voice it answers in (default `marin`; Brazilian Portuguese: `bossa` feminine or `tempo` masculine) |
| `AI_LIVE_BACKEND_MODEL` | reasoning model GPT-Live delegates to, and the one that actually reads MongoDB (default `gpt-5.6-terra`) |

## Read-only camp assistant

Admins and listed organizers see a live assistant button throughout the logged-in app. It opens a spoken, two-way conversation; the backend keeps the API key private and lets the model query an explicit allowlist of application collections with read-only MongoDB tools.

- No insert, update, delete, `$out`, `$merge`, `$where`, server-side JavaScript or cross-collection `$lookup` is exposed.
- `sessions` is never exposed. OTP internals, QR tokens, file bytes and gallery face embeddings are stripped.
- Queries are capped by execution time, result count and response size.
- Access is enforced server-side: real admin or a staff session currently listed in Settings → Organizadores.

### Talking to it (GPT-Live)

The full-screen focus view holds a spoken conversation. It is a real two-way call, not push-to-talk: both sides can speak at once and the person can cut the answer off mid-sentence. The assistant introduces itself when the session starts.

- The browser holds the microphone and the speaker over WebRTC. `POST /api/assistant/live` trades its SDP offer for GPT-Live's answer, so the API key never reaches the client.
- GPT-Live only runs the conversation. It delegates every question to the `AI_LIVE_BACKEND_MODEL` Responses model, which gets the same prompt and the read-only MongoDB tools.
- Tool calls come back down the browser's data channel and are executed by `POST /api/assistant/tool`, which re-checks the caller's session and role — the browser never touches Mongo.
- Sessions are billed per minute, so closing the drawer hangs up.

## Login flow (roles + phone + OTP)

1. User picks one of 4 roles: `parent`, `staff`, `health_staff`, `admin`.
   **The same person may hold several roles** (e.g. parent + staff + admin) —
   the selected role is sent to the backend, checked against the person's
   roles (`ROLE_NOT_ALLOWED` otherwise) and becomes the session's `activeRole`.
2. Enters their Brazilian mobile number (DDD + 9 digits).
3. Backend sends a 6-digit OTP (valid for **5 minutes**):
   - with `COMTELE_API_KEY` set → real SMS via Comtele `POST /tokenmanager`, validated via `PUT /tokenmanager`
   - without a key → code logged to console, validated locally
4. **3 wrong attempts freeze the account** for `ACCOUNT_FREEZE_MINUTES`.
5. On success the backend issues a JWT bound to a MongoDB session doc, expiring **4 days** later.

> **"admin" in the route tables below** means `requireManager`: the admin
> role **or** a team member listed in Settings → Organizadores (see
> [Organizers](#organizers-admin-like-team-members-)). Only categories,
> the organizers list, the notification switches, `/welcome-preview` and
> `/api/ai/usage` are `requireAdmin` (the real admin role).

### Endpoints

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/auth/otp/request` | `{ phone, role }` | sends OTP → `{ expiresAt, roles, delivery }` |
| POST | `/api/auth/otp/verify` | `{ phone, role, code }` | → `{ token, tokenExpiresAt, user: { …, roles, activeRole } }` |
| GET | `/api/auth/me` | (Bearer token) | → `{ user }` |
| POST | `/api/auth/role` | `{ role }` (Bearer token) | the SAME person switches profile (mãe que também é da equipe): revokes this session and issues a new one → `{ token, tokenExpiresAt, user }`. `ROLE_FORBIDDEN` when the role isn't among their available ones; the target role's access window still applies |

| POST | `/api/auth/logout` | (Bearer token) | revokes the session |
| GET | `/health` | — | liveness check |

**Available profiles** (`services/roles.ts#availableRolesOf`). `users.roles` is
only what the account was created with, and it goes stale: the admin puts
someone on the team roster, or enrols a kid naming them as guardian, without
ever touching their account. So the profiles offered — the `roles` sent to the
client, and what `/api/auth/role` accepts — come from the DATA:

- **`parent` ⇔ at least one kid with that `guardianPhone`.** It is a fact, not
  a grant: a stored `parent` with no kid enrolled is **dropped** (the mother of
  last year's camper is not a responsible this year).
- **`staff` ⇔ an ACTIVE `staff` record with that phone.** Being admin does not
  create a roster row. An administrator who also serves on the team (a real
  Equipe record) receives both profiles and chooses one after OTP.
- `admin` and `health_staff` are never derived: they are granted.

The role a login LANDS on is `pickActiveRole` over **that** list, so an admin
always lands on admin. An account the data gives no profile at all gets
`NO_PROFILE` (403) instead of an SMS. Live sessions are re-checked on every
request and on the WebSocket upgrade (`middleware/auth#roleNoLongerValid`): a
parent session without kids, or an admin's `staff` session, is revoked (401).

Error responses carry machine-readable codes: `PHONE_INVALID`, `USER_NOT_FOUND`, `NO_PROFILE` (the phone has no profile at this year's camp), `ROLE_NOT_ALLOWED` (phone exists but doesn't hold the selected role — includes `availableRoles`), `OTP_COOLDOWN`, `OTP_EXPIRED`, `OTP_INVALID` (with `attemptsLeft`), `ACCOUNT_FROZEN` (with `minutesLeft`), `UNAUTHORIZED`.

## IPAlpha login (core auth-api) 🔑

Optional, on only when every required `IPALPHA_*` variable is set (see
[`DEPLOYMENT.md`](./DEPLOYMENT.md); boot logs the missing **names**, never
values). IPAlpha owns identity; Acampa keeps its own roles, access windows,
freeze rules and sessions. Code: `routes/ipalpha.ts`, `services/ipalpha/`
(all core HTTP behind `coreClient.ts`), shared login gates in `services/login.ts`.

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/auth/ipalpha/config` | — | `{ enabled, authOrigin, clientId, entryPoint }` (public; `enabled:false` hides the button) |
| POST | `/api/auth/ipalpha/start` | `{ personHint? }` | stores `{state, codeVerifier}` (`ipalphaLoginStates`, TTL 10 min, one-time), PARs server-side with the client secret + PKCE S256, `response_mode=web_message`, resource `ipalpha:persons` (+ `project_id`, `login_hint`) → `{ url }` for the popup |
| POST | `/api/auth/ipalpha/complete` | `{ code, state }` (or `{ error, state }`) | state consumed once → code exchanged server-side → token verified locally (JWKS, `iss`, `aud=ipalpha:persons`, `token_use=external_access`, `azp`) → account by `ipalphaPersonIds`, else by the person's **verified** phone read fresh from persons-api (+ roster / guardian provisioning) → person id bound → same profile / frozen / window gates as the phone login → the exact `/otp/verify` answer |

- **Legacy phone + code** keeps its request/response shapes. With IPAlpha on,
  `/otp/request` relays to auth-api (`/internal/login/relay/start`, forwarding
  the client IP — the `X-Forwarded-For` entry our ingress appended, i.e. the
  last one with `TRUST_PROXY_HOPS=1`, else the socket; only valid IPs) and stores only the relay `challengeId`
  on `users.otp` (`provider: "ipalpha"`, no code); `/otp/verify` relays the
  check, binds the returned person id and opens the session. auth reasons map
  to the existing codes: `invalidCode` → `OTP_INVALID`, `tryAgainLater` /
  `tooManyAttempts` → on verify `ACCOUNT_FROZEN` (frozen locally too), on
  request `OTP_COOLDOWN` (never frozen); `tooManyRequests` / `resendTooSoon` →
  `OTP_COOLDOWN`, `challengeExpired` → `OTP_EXPIRED`. Only a 401 token
  rejection (`invalidToken` / no reason) refreshes the system token and
  retries once — a 401 `invalidCode` is never sent twice.
  `personNotFound` keeps the local SMS path (roster phones not in core yet).
  The Settings → Testes SMS redirect does not apply to relayed codes.
- **Session length**: the `sessionIdleHours` of the answer that proved this
  login (relay verify `sessionIdleHours`, popup `/oauth/token`
  `session_idle_hours`); absent or a local code → `SESSION_HOURS`. Stored on
  the session (`sessions.hours`) and reused on profile / camp switches.
- **`/start` limit**: 20 per minute per client IP, in memory per pod →
  429 `IPALPHA_RATE_LIMITED` (+ `secondsLeft`, `Retry-After`).
- **Camp activation** with `IPALPHA_PROJECT_ID` + `IPALPHA_PROJECTS_API_URL`:
  `current-by-year?year=<camp.year>` on projects-api — best effort, logged,
  never blocks the activation.
- New error codes: `IPALPHA_DENIED`, `IPALPHA_STATE_INVALID`,
  `IPALPHA_CODE_INVALID`, `IPALPHA_DISABLED` (404, feature off),
  `IPALPHA_UNAVAILABLE` (503 — core unreachable / 5xx; the app shows its maintenance scene),
  `IPALPHA_MISCONFIGURED` (500 — core refused our PAR / token request:
  credentials, entry point, params; logged as an error),
  `IPALPHA_RATE_LIMITED` (429, `/start` only).

**Do not:** store or cache person tokens or any core profile/person data
(only `users.ipalphaPersonIds` — ids, nothing else); log tokens, codes or
phones; read persons-api ahead of use; trust an unverified phone; return
secrets from `/config`. Only system tokens are cached, in memory, until 30 s
before expiry. Tests: `bun test` (fake core + local ES256 JWKS +
mongodb-memory-server, synthetic data — `src/testing/`, never shipped).

## Realtime feed (WebSocket) 📡

The frontend is offline-first: it keeps every collection in the device's
localStorage and **never polls**. Instead each logged-in client keeps one
WebSocket open and the server pushes the data.

```
GET /api/realtime?token=<jwt>   (upgrade: websocket)
```

The token goes in the query string because browsers can't set headers on a
WebSocket upgrade. An invalid/expired token gets `{ type: "error", code:
"UNAUTHORIZED" }` and close code **4401** (the client then logs out).

Messages (server → client, JSON):

| `type` | when | payload |
|---|---|---|
| `snapshot` | right after connect, or after the client sends `"refresh"` | `data: { campers, staff, bedrooms, categories, roles, events }` — only what the session's role may read (same rules as the REST `requireRole` guards; parents only get `categories`) |
| `update` | after **any** write (debounced 25 ms) | `data` with just the collections that changed, whole lists |
| `ping` | every 30 s | keep-alive; client answers `"pong"` |

Every route handler that writes calls `publish("campers", "bedrooms", …)`
(`services/realtime.ts`); `services/snapshot.ts` re-reads and serializes the
collections with the exact serializers the REST endpoints use, so the two
shapes never drift. Payloads are whole collections on purpose — the dataset is
small (≈150 kids / 70 staff / 40 rooms / 50 events, ~300 KB) and "replace the
list" keeps the client trivial and always consistent.

Bun serves the socket natively (`export default { fetch, websocket }` in
`index.ts`, via `hono/bun`).

## Categories (admin-managed enumerations)

Every "pick from a list" field on the camper/staff forms (time, quarto, cama,
ônibus, alergias, condição crônica…) is a **category**: a closed list of
options that only admins can create/edit. Categories are never free text.

- `appliesTo: ["camper" | "staff"]` — which forms show the category (one or both)
- `selection: "single" | "multiple"` — pick one (quarto) or many (alergias)
- `options[]` — the enumeration; each option has a stable `id`, a `label`, an
  `order` and an `active` flag (hide instead of delete when already in use)
- `key` — stable slug generated from the first name; forms should reference
  categories/options by `id`/`key`, never by label

| Method | Path | Who | Body |
|---|---|---|---|
| GET | `/api/categories?audience=camper\|staff` | any role (non-admins only see active options) | — |
| GET | `/api/categories/:id` | any role | — |
| POST | `/api/categories` | admin | `{ name, emoji?, description?, appliesTo, selection, options?: string[] }` |
| PUT | `/api/categories/:id` | admin | partial `{ name?, emoji?, description?, appliesTo?, selection? }` |
| DELETE | `/api/categories/:id` | admin | — |
| PUT | `/api/categories/reorder` | admin | `{ ids: string[] }` |
| POST | `/api/categories/:id/options` | admin | `{ label }` |
| PUT | `/api/categories/:id/options/:optionId` | admin | `{ label?, active? }` |
| DELETE | `/api/categories/:id/options/:optionId` | admin | — |
| PUT | `/api/categories/:id/options/reorder` | admin | `{ ids: string[] }` |

Error codes: `CATEGORY_NOT_FOUND`, `OPTION_NOT_FOUND`, `NAME_INVALID`,
`AUDIENCE_INVALID`, `SELECTION_INVALID`, `OPTION_INVALID`, `OPTION_DUPLICATE` (409),
`FORBIDDEN` (non-admin trying to write).

## Bedrooms (quartos)

Bedrooms are **not** categories: each has a bed layout — `bunkBeds` (beliches,
2 people each) + `singleBeds` (1 each) — which defines its `capacity`. Stored
in the `bedrooms` collection (unique by `name`), grouped by wing
(`group: girls | boys | staff`). Responses include `occupied`/`available`
(computed from staff assignments).

| Method | Path | Who | Body |
|---|---|---|---|
| GET | `/api/bedrooms?group=girls\|boys\|staff` | admin, staff, health_staff | — |
| GET | `/api/bedrooms/:id` | admin, staff, health_staff | — |
| POST | `/api/bedrooms` | admin | `{ name, group, bunkBeds?, singleBeds?, notes? }` |
| PUT | `/api/bedrooms/:id` | admin | partial (same fields) |
| DELETE | `/api/bedrooms/:id` | admin | — (409 `BEDROOM_IN_USE` while anyone is assigned) |

Error codes: `BEDROOM_NOT_FOUND`, `NAME_INVALID`, `NAME_DUPLICATE` (409), `GROUP_INVALID`,
`BUNK_BEDS_INVALID`, `SINGLE_BEDS_INVALID`, `CAPACITY_INVALID` (needs ≥ 1 bed), `BEDROOM_IN_USE` (409).

## Schedule (programação)

Two collections:

- **`schedule_roles`** — funções staff fulfil. **Who does one is decided in ways that ADD UP** (`services/schedule.ts`):
  - **by position** — `forRoomRoles: RoomRole[]`, the positions that pick the função up on their own, linked by `Staff.roomRole` with no assignment at all: `["caretaker", "helper"]` = the whole team ("Cuidar das crianças"), `["caretaker"]` = only the Líderes, `[]` = nobody automatically.
  - **by person** — `CampEvent.assignments`, scaled by hand, optionally with a detail.

  So "os líderes + a Ana e o Pedro" is `forRoomRoles: ["caretaker"]` **plus** two assignments; "só a Ana" is `[]` plus one; "toda a equipe" is both positions. Moving somebody between positions re-does every event at once. One rule keeps it unambiguous: a person does ONE função per event — an explicit assignment always wins over every position link, and a função aimed at a single position wins over the whole-team one (`#autoRoleFor`). `#peopleInRole` returns both groups, tagged `via: "person" | "position"`.

  Legacy documents hold a boolean `forEveryone`; it is read back as both positions (`true`) or none (`false`), and the write endpoints still accept it. No migration needed.
  `instructions` (what to do during the event) and `preparation` (what to
  bring / wear / prepare *before* the camp, e.g. "Inspeção: roupa verde estilo
  exército com boné") are HTML from the admin WYSIWYG, **sanitized
  server-side** (`services/html.ts`: p/br/strong/em/u/s/ul/ol/li/h2/h3/
  blockquote/a/hr/img only, `http(s)`/`mailto`/`tel` links, images only from
  `/api/files/<id>` or `http(s)` — never `data:` —, scripts & handlers stripped).
- **`schedule_events`** — `{ date "YYYY-MM-DD", title, emoji, startTime "HH:mm", endTime|null, notes, roles: string[], visibleToParents }` — `roles` are the role ids staff fulfil there. `visibleToParents` (default true) is whether parents see the event on their programme.

**PG (pequeno grupo).** The `PG` column of the roster (Líder / Auxiliar) assigns
each person to BOTH `PG` events (Sat & Sun 10:45). The Líder gives the study,
so the roles `Líder do PG — Dia 1/2` carry that day's material as instructions;
`Auxiliar do PG` has no task. The material lives in `backend/assets/pg/`
(`dia1.html`, `dia2.html` + the illustrations, stored in the `files` collection).

Each event has `assignments: [{ staffId, roleId, detail }]` (one role per person
per event, `detail` = team / base / colour / shift):

| Method | Path | Who | Body |
|---|---|---|---|
| PUT | `/api/schedule/events/:id/assignments` | admin | `{ assignments: [{ staffId, roleId, detail? }] }` — replaces the list |
| PUT | `/api/schedule/events/:id/assignments/:staffId` | admin | `{ roleId, detail? }` — sets one person's role |
| DELETE | `/api/schedule/events/:id/assignments/:staffId` | admin | removes the person from the event |

Errors: `STAFF_INVALID`, `ROLE_INVALID` (role must be one of the event's roles), `STAFF_DUPLICATE` (409). Deleting a staff member removes them from every event.

| Method | Path | Who | Body |
|---|---|---|---|
| GET | `/api/schedule/roles` | admin, staff, health_staff | — (team: only the roles that appear in *their* scoped events) |
| POST | `/api/schedule/roles` | admin | `{ name, emoji?, instructions?, preparation?, forRoomRoles?, hasDetail?, detailPlaceholder? }` (legacy `forEveryone` still accepted) |
| PUT | `/api/schedule/roles/:id` | admin | partial |
| DELETE | `/api/schedule/roles/:id` | admin | 409 `ROLE_IN_USE` while referenced by an event |
| GET | `/api/schedule/events` | admin, staff, health_staff | sorted by day, startTime. **Team scope** (`services/scope.ts#scopeEvent`): every event, but `roles` is cut to the viewer's own função (their assignment, else the ones falling on their `roomRole`) and `assignments` to their own entry — who else does what is never sent. Same for the realtime snapshot. |
| POST | `/api/schedule/events` | admin | `{ date "YYYY-MM-DD", title, emoji?, startTime, endTime?, notes?, roles? }` |
| PUT | `/api/schedule/events/:id` | admin | partial |
| DELETE | `/api/schedule/events/:id` | admin | — |

Error codes: `ROLE_NOT_FOUND`, `EVENT_NOT_FOUND`, `NAME_INVALID`, `NAME_DUPLICATE` (409, case-insensitive),
`INSTRUCTIONS_INVALID`, `FOR_ROOM_ROLES_INVALID`, `ROLE_IN_USE` (409), `DATE_INVALID`, `TITLE_INVALID`,
`START_TIME_INVALID`, `END_TIME_INVALID`, `NOTES_INVALID`, `ROLES_INVALID`.

## Campers (acampantes)

Full CRUD (admin). Linked to bedroom, bed (`cama`), team,
transport, allergies and chronic conditions (category option ids); guardian /
insurance / emergency contact kept as text. `weightKg` is a number (one
decimal, 5–200) or null — `WEIGHT_INVALID` otherwise.

**Caretaker (`caretakerId`)** — the staff member responsible for the kid: must
sleep in the kid's room with `roomRole: "caretaker"` (409 `CARETAKER_INVALID`
otherwise). A room change without `caretakerId` makes the kid an **orphan**
(`caretakerId: null`) — orphans are listed first on the admin page. When a
caretaker leaves the room / becomes a helper / is deleted, their kids become
orphans.

**What the team sees** (services/scope.ts): a caretaker gets the kids under
their care any time; the other kids of their room — and every kid for a
helper — only WHILE THE CAMP IS HAPPENING (first → last programme day, São
Paulo). Those come as **care** records (`contactsHidden: true`): health,
notes, preferences, room / team / bus and the guardian's **name + phone** (to
reach the parents) — no emergency contact, insurance, e-mail or document
data. Admin, medical team and check-in helpers keep the full record.
Colleagues in the same room reach a team member as **name + phone + room
role + team** (`redacted: true`: no transport, health or check-in).

**Medication (`medications`)** — a list, one entry per medicine:
`{ name, dose, times: ["HH:MM"], asNeeded, notes }`. `times` are the fixed
moments of the day it is given (the medical checklist ticks each one); `asNeeded`
= no fixed time. Neither = schedule not confirmed yet. ≤ 20 medicines, ≤ 12 times
each, `MEDICATIONS_INVALID` otherwise. Staff use the same `medications` shape.

| Method | Path | Who | Body |
|---|---|---|---|
| GET | `/api/campers?bedroom=<id>` | admin, staff, health_staff | — |
| GET | `/api/campers/:id` | admin, staff, health_staff | — |
| GET | `/api/campers/:id/detail` | admin, staff, health_staff | `{ camper, bedroom, caretakers (staff in the room), roommates }` |
| GET | `/api/campers/lookup/:id` | admin, staff, health_staff — **only while the camp is on** (403 `CAMP_NOT_ACTIVE` otherwise) | emergency badge scan ("Ler crachá") → `{ camper, belonged, foreignLookupCount, foreignLookupBlocked, bedroom?, caretaker? }`; out-of-scope kids come as CARE records, are logged and count towards the alert / block thresholds |
| POST | `/api/campers` | admin | all camper fields (`bedroom` must have a free bed → 409 `BEDROOM_FULL`) |
| PUT | `/api/campers/:id` | admin | partial |
| DELETE | `/api/campers/:id` | admin | — |

Bedroom occupancy (`occupied`, `available`) now counts **campers + staff**, and
the response also carries `occupiedCampers` / `occupiedStaff`.

**Detail endpoints** (what the admin sees when clicking a person or a room):

| Method | Path | Returns |
|---|---|---|
| GET | `/api/staff/:id/detail` | `{ staff, bedroom, schedule: [{ eventId, date, startTime, endTime, title, emoji, role, detail, implicit, defaultRole }], campers, roommates }` — `implicit: true` entries came from the person's **position**, not an escala; `defaultRole` is the função that would fall on that position in the event (or null) |
| GET | `/api/bedrooms/:id/detail` | `{ bedroom, campers, staff }` |

## Staff (equipe)

Camp volunteers, stored in the `staff` collection (unique by phone). Picker
fields store category **option ids** and are validated against these category
keys: `team → equipe`, `transportation → transporte`, `allergies → alergias`,
`healthIssues → condicao-cronica`. `bedroom` is a **Bedroom id** — assigning
someone to a full room fails with 409 `BEDROOM_FULL`.
`foodRestrictions` and `healthNotes` are free text (≤ 500 chars); `medications` is the same list as on campers.
`phone` is the person's **login** and is therefore **required and unique** on
`POST /api/staff` / `PUT /api/staff/:id`: an empty phone gets 400
`PHONE_REQUIRED` and a phone already on the roster gets 409 `PHONE_DUPLICATE`.
(Bulk imports write through the model, so records that arrived without a phone
stay readable — the form asks for one the first time they are edited.)
`roomRole` is `"caretaker"` (responsável: looks after specific kids) or
`"helper"` (auxiliar, the default).

**Admins and the roster.** Admin / super-admin logins live on `users` and do
**not** need a `staff` record. Adding an admin (wizard or `POST /api/admins`)
only grants the role. If they also serve on the team, create a normal Equipe
row; deleting that row removes them from Equipe and keeps the login. Cleanup
→ Equipe wipes roster rows and never touches `users`.

| Method | Path | Who | Body |
|---|---|---|---|
| GET | `/api/staff?active=true\|false` | admin, staff, health_staff | — |
| GET | `/api/staff/:id` | admin, staff, health_staff | — |
| POST | `/api/staff` | admin | `{ name, phone (obrigatório, único), active?, team?, bedroom?, transportation?, allergies?, foodRestrictions?, healthIssues?, medications? }` |
| PUT | `/api/staff/:id` | admin | partial (same fields + `roomRole`) |
| POST | `/api/staff/:id/move` | admin | `{ bedroom, kids: "orphan" \| "bring" \| "assign" \| "swap", assignTo?, swapWith? }` — moves a caretaker and decides what happens to their kids: stay orphans, come along (room + bed cleared), go to `assignTo` (same room; a helper is promoted) or swap with `swapWith` (target room: both people switch rooms, each takes the other's kids) |
| DELETE | `/api/staff/:id` | admin | — (their kids become orphans) |
| POST / DELETE | `/api/staff/:id/checkin` | admin | marks / unmarks the person as arrived (roll call) |
| GET | `/api/staff/me/checkin` | staff, health_staff, admin | → `{ allowed, reason, date, opensAt, location, staff }` — can the caller check themselves in right now? |
| POST | `/api/staff/me/checkin` | staff, health_staff, admin | `{ lat, lng, accuracyM? }` → `{ staff, distanceM }` |

Error codes: `STAFF_NOT_FOUND`, `NAME_INVALID`, `PHONE_INVALID`, `PHONE_DUPLICATE` (409),
`ACTIVE_INVALID`, `TEAM_INVALID`, `BEDROOM_INVALID`, `BEDROOM_FULL` (409), `TRANSPORTATION_INVALID`,
`ALLERGIES_INVALID`, `HEALTHISSUES_INVALID`.

### Self check-in (departure day) 📍

A team member can mark their **own** arrival from their phone, but only when
both rules hold — checked on the server, never trusted from the client:

1. **The window is open**: today is the departure day — the date of the
   *first* event of the programme (`schedule_events` sorted by date/time) —
   and it is at most **one hour before** that event's `startTime`
   (`SELF_CHECKIN_OPENS_MINUTES_BEFORE`, compared in `America/Sao_Paulo`).
   Before that the status answers `NOT_YET` with the opening time; the
   response also carries `opensAt` (ISO).
2. **The phone is at the church**: the device position sent in the body is
   within the radius of one of the meeting points in **Settings**
   (`checkinLocations`: church, camp site… the nearest one wins; plus the
   GPS accuracy, capped at 200 m so a bogus accuracy can't be abused).

The session must be linked to an active staff record by phone. Errors:
`NOT_LINKED`, `INACTIVE`, `NO_SCHEDULE`, `NOT_TODAY`, `NOT_YET`, `ALREADY_CHECKED_IN` (409),
`LOCATION_REQUIRED`, `TOO_FAR` (carries `distanceM`). A successful self
check-in stamps `checkin` with the person's own user and writes the same
audit line as the admin roll call.

## Preparação (before the camp) 🎒

General sections read before leaving home ("O que levar", "Uniforme",
"Chegada na igreja"…). Collection `prep_sections`:
`{ title, emoji, audiences, content (sanitized HTML, may include images), order }`.
`audiences` is a non-empty list of `"parent" | "caretaker" | "helper"` — the
section is POSTED to those groups (older docs with a single `audience` are read
as `caretaker`+`helper` for `"all"`). Pushed in the realtime snapshot
(`preparation`) to admin / staff / health_staff (their room role) and to
PARENTS (only sections listing `parent`); admins and organizers see all.
`AUDIENCE_INVALID` when empty or unknown. Role-specific preparation is
`schedule_roles.preparation`.

Each section is a **checklist item**. The team's ticks live on their roster
record (`staff.prepDone: string[]`, keys `section:<id>` / `role:<id>`); a
PARENT has no roster record, so theirs live on their account
(`users.prepDone: string[]`, only `section:<id>` keys) and come back on the
wire as `section.done` — a boolean computed per session, always `false` for
the team and the admin. Deleting a section (or wiping the Instruções /
Preparação block) drops its key from every staff and user record.

Creating / editing a section posted to the parents texts every parent with a
phone (`notifications.parentContentChanges`), only while the parents' access
window is open (checked at send time, coalesced like the team's SMS).

| Method | Path | Who | Body |
|---|---|---|---|
| GET | `/api/preparation` | admin, staff, health_staff, parent | — (filtered to what the session may see) |
| POST | `/api/preparation` | admin | `{ title, emoji?, audiences?, content? }` |
| PUT | `/api/preparation/reorder` | admin | `{ ids: string[] }` |
| PUT | `/api/preparation/:id` | admin | partial |
| DELETE | `/api/preparation/:id` | admin | — |
| PUT | `/api/preparation/me/:key` | parent | `{ done: boolean }` — ticks / unticks one item of the responsible's checklist; `key` is `section:<id>` (must be a section posted to them). Stored in `users.prepDone: string[]` |
| PUT | `/api/staff/me/prep/:key` | staff, health_staff, admin | `{ done: boolean }` — ticks / unticks one item of the person's checklist; `key` is `section:<id>` or `role:<id>`. Stored in `staff.prepDone: string[]` |

### Images for the editor 🖼️

| Method | Path | Who | Body |
|---|---|---|---|
| POST | `/api/files` | admin | multipart `file` (jpeg/png/webp/gif, ≤ 2 MB — the frontend shrinks to ≤ 1280 px first) → `{ file: { id, url: "/api/files/<id>", name, type, size } }` |
| GET | `/api/files/:id` | **public** | the image, `cache-control: immutable` |

File bytes live under `FILES_DIR` on a persistent volume; MongoDB's `files`
collection holds metadata. Legacy MongoDB Binary data is migrated to disk on
first read, then removed from the document. Back up **both MongoDB and the
pictures directory**. Ids are 24 random bytes (hex) — unguessable — which
allows the GET to be unauthenticated. The editor stores relative URLs; the
frontend resolves them against `VITE_API_URL`, or its current origin in production.

## Instructions (general documents) 📖

Both Instruções documents and Preparação sections carry an `audience`:
`"all"` (default), `"caretaker"` or `"helper"` — only team members with that
`roomRole` receive the document (lists, snapshot and the content-change SMS);
admins and organizers always see everything. `AUDIENCE_INVALID` otherwise.

Long rich-text documents for the whole camp ("Regras do acampamento", "Plano
de emergência", "Rotina do dia"…), written by the admin in the WYSIWYG editor
and read by every team member. Collection `instructions`, pushed in the
realtime snapshot (collection `instructions`) like everything else. Content
is HTML sanitized server-side (`services/html.ts`, up to 400 KB — pictures
are uploaded separately via `/api/files` and referenced by URL).

| Method | Path | Who | Body |
|---|---|---|---|
| GET | `/api/instructions` | admin, staff, health_staff | — (sorted by `order`) |
| POST | `/api/instructions` | admin | `{ title, emoji?, content? }` |
| PUT | `/api/instructions/reorder` | admin | `{ ids: string[] }` |
| PUT | `/api/instructions/:id` | admin | partial |
| DELETE | `/api/instructions/:id` | admin | — |

Errors: `TITLE_INVALID` (≤ 120 chars), `CONTENT_INVALID`, `IDS_INVALID`,
`INSTRUCTION_NOT_FOUND`.

## Settings (admin) ⚙️

One document (`settings`, `_id: "global"`) with the camp-wide configuration.
Until an admin saves it, the defaults apply.

| Method | Path | Who | Body |
|---|---|---|---|
| GET | `/api/settings` | any logged-in role | — |
| GET | `/api/settings/welcome-preview` | admin | → `{ staff: { count, windowOpen, names }, parents: { … } }` — who would get the welcome SMS right now |
| PUT | `/api/settings` | admin, organizer (`organizers` / `notifications` admin-only) | `{ checkinLocations?: [{ id, name, lat, lng, radiusM }], notifications?: { bedroomChanges?, roleChanges?, checkinConfirmation?, …, checkinReminder? }, checkinWindow?: { from, until }, checkinReminder?: { at }, checkinHelpers?: { staffIds }, busHelpers?: { helpers: [{ staffId, vehicleId }] }, organizers?: { staffIds }, gameOrganizers?: { staffIds }, scoreHelpers?: { staffIds }, medicalStaff?: { staffIds }, vestHelpers?: { staffIds }, parentContacts?: [{ id, title, staffId }], parentAccessWindow?: { from, until } }` |

`checkinLocations` defaults to one spot, "Igreja" = Igreja Presbiteriana em Alphaville (a legacy single `checkinLocation` document is read as that spot)
(`-23.48053637134259, -46.83077891444747`, radius 300 m). `radiusM` must be
between 50 and 5000. `notifications` keys are booleans (all default **`false`**);
the patch is partial. `checkinReminder.at` is the ISO instant at which the
whole team is texted to do their check-in (`null` = no reminder); the response
also carries the read-only `checkinReminder.sentAt`, reset whenever `at` changes. The response also carries `smsEnabled` (read-only:
whether a Comtele key is configured). Errors: `LOCATION_INVALID`,
`NOTIFICATIONS_INVALID`, `WINDOW_INVALID`, `REMINDER_INVALID`, `HELPERS_INVALID`, `ORGANIZERS_INVALID`, `CONTACTS_INVALID`, `NOTHING_TO_UPDATE`.

### SMS redirect (Settings → Testes) 📵

`smsRedirect: { enabled, staffPhone, parentPhone }` — admin only in `PUT
/api/settings`. While `enabled`, `services/comtele.ts#resolveSmsTarget`
reroutes **every** text: the ones meant for a team member (login code +
notifications) go to `staffPhone`, the ones meant for a parent / guardian
(login code, welcome, bus check-in, parent content) go to `parentPhone`.
A null phone for an audience drops that audience's texts (OTP request →
503 `SMS_REDIRECT_UNSET`). Admin logins are never redirected. The OTP
response reports `delivery: "redirect"` so the login screen says where
the code went. Must be OFF before the camp — Notificações shows a red
banner while it is on.

### Contacts shared with parents 📞

`parentContacts: [{ id, title, staffId }]` is an ordered list managed by the admin. Each entry points to one active staff member and gives that person a purpose-specific title such as "Coordenação do acampamento". Parents see them (name + phone) while the parents' window is open.

## Parents 👨‍👩‍👧

A parent is a `users` doc with the `parent` role whose phone matches
`Camper.guardianPhone` (staff who are also parents just gain the role).
`services/scope.ts#resolveParentScope`:

- **campers**: only their own kids, full record (while `kidsRoomsDraft` the
  room, bed and caretaker are blanked).
- **bedrooms**: the kids' rooms.
- **staff**: ONLY while the **parents' window** is open — the team of the
  kids' rooms and the `parentContacts`, as `redacted` records with `name`,
  `phone`, `bedroom`, `roomRole` (no vest, health, team or check-in).
  Outside the window nothing.
- **events**: events with `visibleToParents`, with `roles` / `assignments` emptied.
  **roles**: none.
- categories (active options), teams, settings.

The parents' window (`services/camp.ts#parentWindow`, read-only
`settings.parentWindow: { from, until, open }`) runs from `checkinWindow.from`
(one hour before the first event when unset) to the end of the last event.
`services/realtime.ts#rearmWindows` arms timers at both edges (re-armed on
every settings / event write and at boot) so the staff records are pushed /
withdrawn live.

| Method | Path | Who | Body |
|---|---|---|---|
| PUT | `/api/campers/:id/parent` | parent (own kid) | any of `allergies, drugAllergies, healthIssues, medications, foodRestrictions, healthNotes, weightKg, insurance, insuranceCard, generalNotes` — other keys ignored → `{ camper, changed }` |
| GET | `/api/campers/:id/changes` | admin | → `{ changes: [{ id, at, byName, medical, changes: [{ field, before, after }] }] }` (newest first) |

Every real change is appended to `camperChangeLog` and texted
(`notifications.parentEdits`): a MEDICAL field (anything but `generalNotes`)
→ the medical team, every admin and the kid's caretaker; observations alone
→ the caretaker only (`services/notify.ts#notifyParentEdit`, sent at once).
Parents may also `GET` campers, staff, bedrooms, teams and the schedule
(scoped as above).

**Access window.** `settings.parentAccessWindow: { from, until }` (Settings →
Geral) gates parent logins and sessions exactly like `staffAccessWindow` does
for the ordinary team (`STAFF_ACCESS_NOT_YET` / `STAFF_ACCESS_ENDED` with
`audience: "parent"`, sockets closed with 4401 at the edge). Both ends null =
always. Parents are NEVER texted about rooms, roles or any other change —
only the welcome and the bus check-in.

### Check-in helpers (team members running the kids' roll calls) 🙋🚌

`checkinWindow: { from: ISO | null, until: ISO | null }` opens the church and outbound-bus roll calls. `busReturnWindow` separately opens the return-bus roll call days later. Each response adds `open` (read-only).

| List | Roll call | What a listed person receives while the window is open |
|---|---|---|
| `checkinHelpers` | church check-in (`POST/DELETE /api/campers/:id/checkin`) | **every camper, full record** (health included — they confirm it with the parents) and every bedroom |
| `busHelpers` | bus boarding on the outbound and return trips (`POST/DELETE /api/campers/:id/checkin/bus` and `/bus-return`) | `{ helpers: [{ staffId, vehicleId }] }` — each person is **linked to one vehicle** (an active `transporte` option; independent from `staff.transportation`, they work the *door*, they need not ride in it) and receives **only the campers of that vehicle** as **name-only records** (`redacted: true`: name, age, room, team, check-in stamps — health, contacts, notes and weight blanked) and every bedroom |

`services/scope.ts` evaluates `checkinHelper` / `busHelper` on every
request and on every realtime push; `camperVisibility()` decides `full` /
`name` / `none` per kid (kids in the person's own room stay `full`) and
`routes/campers.ts#serializeCamperFor` applies it everywhere a camper leaves
the server (lists, `/detail`, the snapshot, the check-in responses). The
check-in handlers check the permission **per kid**: `403
CHECKIN_WINDOW_CLOSED` to anyone who is not admin nor a helper of *that* roll
call inside the window — a bus helper cannot touch the church check-in, nor a
kid from another vehicle. Other staff members stay invisible to helpers.
Outside the window nothing extra is sent;
`services/realtime.ts#scheduleCheckinWindow` arms timers at both edges (on
save and on boot) so the scoped collections are re-pushed the moment the
window opens or closes — helpers gain / lose the data without a reload.

### Organizers (admin-like team members) 📋

`organizers: { staffIds: string[] }` — no time window. A listed person's
scope is the **admin's** (`{ all: true, admin: false }`, `services/scope.ts`):
every camper, staff member, bedroom and the whole programme, and
`middleware/roles.ts#requireManager` lets them do the admin's writes —
campers, staff (CRUD + roll call), bedrooms, teams, documents, check-in
reset and `PUT /api/settings`. Occurrences: only the ones organizers
registered (the admin sees every group). Four areas stay with the real admin
(`requireAdmin`): the `organizers` list itself and the `notifications`
switches (both 403 in `PUT /api/settings`, except `notifications.checkinReminder`),
categories, `/welcome-preview`, `/api/ai/usage` ("Sobre"). Saving the list
publishes every scoped collection so their phones update at once.

### Medical team (see every kid, always) 🩺

`medicalStaff: { staffIds: string[] }` — **no time window**. A listed person's
scope gets `medical: true` (`services/scope.ts`): `camperVisibility` is
`"full"` for **every camper** (health included) and `canSeeBedroom` is true
for **every bedroom**, before / during / after the camp — which also gives
them every vehicle. Strictly read-only: no camper / bedroom writes, no
check-ins (those keep their own rules). Occurrences: only the ones the
medical team registered. Staff and programme: as any team member. Saving
the list publishes `campers`, `bedrooms`; the frontend's window-close purge
skips medical members.

### Game organizers (Settings → Jogos) 🏆

`gameOrganizers: { staffIds: string[] }` — **no time window**. Scope
`organizer: true` + `gameOrganizer: true`: they see **every staff member in
full** and the **whole programme**, `requireOrganizer` lets them write the
schedule (events, roles, assignments, editor images), and they write the
scoreboard (`POST /api/scores`, `POST /api/scores/reset/:teamId`,
`DELETE /api/scores/:id`). No other admin rights (campers, rooms, settings).
Joining the list sends the enrolment SMS.

### Score helpers (ajudantes do placar) 📷

`scoreHelpers: { staffIds: string[] }` — **no time window**. People who only
run the bulk **QR scan** tied to a programme event: `POST /api/scores/scan`
(the kid's QR at a door → the kid's team gets the event's points) and
`PUT /api/scores/scan/:eventId`. Scope `scoreHelper: true`: every camper
reaches them as a `"name"` record (name + team, `redacted`), so the scan can
be resolved locally. They never give / take points by team (`POST
/api/scores` is 403), never zero a team, `DELETE` only their **own scan**
lines, and get no organizer rights. Joining the list sends the enrolment SMS.

### Vest helpers (coletes) 🦺

`vestHelpers: { staffIds: string[] }` — open before / during the camp and
up to **7 days after** it ends (`services/camp.ts#VEST_GRACE_DAYS`: the vests
come back in the days after); the admin / organizers are never gated. The people who
hand out the team vests at the start of the camp and take them back at the
end (the admin does not do it). A listed person's scope gets `vestHelper:
true`: `staffVisibility` is `"contact"` for **every staff member** — the
record travels `redacted` with only `name`, `phone` and `vest` (never health,
room, team or check-in). They may call:

| Method | Path | Who | Effect |
|---|---|---|---|
| POST / DELETE | `/api/staff/:id/vest/delivery` | admin, vest helper | stamps / clears `vest.delivered` |
| POST / DELETE | `/api/staff/:id/vest/return` | admin, vest helper | stamps / clears `vest.returned` (needs a delivery) |

`Staff.vest = { delivered: CamperCheckin | null, returned: CamperCheckin | null }`.
Errors: `ALREADY_DELIVERED`, `NOT_DELIVERED`, `ALREADY_RETURNED`,
`NOT_RETURNED` (409). `POST /api/settings/checkin/reset` clears the vests too.
Joining the list sends the same enrolment SMS as the other lists
(`notifications.enrolments`).

## Teams (times) 🚩 and scoreboard (placar) 🏆

Teams used to be the `equipe` category; they are now their own collection
(`teams`: name, `color` #rrggbb, `jokerStaffId`, order). At boot
`ensureTeamIndexes()` migrates the legacy category once: each option becomes
a team with the **same id**, so `Staff.team` / `Camper.team` keep pointing at
the right team, then the category is deleted.

| Method | Path | Who | Body |
|---|---|---|---|
| GET | `/api/teams` | admin, staff, health_staff | — |
| POST | `/api/teams` | admin | `{ name, color?, jokerStaffId? }` |
| PUT | `/api/teams/reorder` | admin | `{ ids }` |
| PUT | `/api/teams/:id` | admin | partial |
| DELETE | `/api/teams/:id` | admin | — (unlinks kids / staff, drops the team's score lines) |

The scoreboard is a **ledger** (`scores`): each line is `{ teamId, points,
kind: add | remove | reset, note, camperId, camperName, eventId, by, createdAt }`; a team's score is the sum
of its lines. Zeroing writes a `reset` line cancelling the current total, so
the history survives. **Every write is refused with `409 SCORE_CLOSED`
outside the camp days** (first → last programme day) unless
`settings.scoreDraft` (Settings → Geral → "Placar em rascunho", `PUT
/api/settings { scoreDraft: boolean }`) is on — the rehearsal switch that also
makes the frontend show the Placar tab any day. `camperId` / `camperName` / `eventId` are set only on
lines written by the QR scan. The programme **event** is the unit of the
round, shared across every device: the same kid counts **once per event**
(`409 ALREADY_SCANNED`) and the points are **one value per event** — a scan
sent with a different value re-points every earlier scan of that event (so
does `PUT /api/scores/scan/:eventId`). The note is always the event's
`emoji + title`.

| Method | Path | Who | Body |
|---|---|---|---|
| GET | `/api/scores` | admin, staff, health_staff | — (newest first) |
| POST | `/api/scores` | admin, game organizer | `{ teamId, points (≠ 0), note? }` |
| POST | `/api/scores/scan` | admin, game organizer, score helper | `{ camperId, eventId, points (> 0) }` → `{ score, team }`; errors `EVENT_NOT_FOUND`, `CAMPER_NOT_FOUND`, `CAMPER_WITHOUT_TEAM`, `ALREADY_SCANNED` |
| PUT | `/api/scores/scan/:eventId` | admin, game organizer, score helper | `{ points (> 0) }` → `{ changed }` (re-points every scan of the event) |
| POST | `/api/scores/reset/:teamId` | admin, game organizer | `{ note? }` |
| DELETE | `/api/scores/:id` | admin, game organizer; score helper (own scan lines only) | — (undoes the line) |

Errors: `TEAM_NOT_FOUND`, `NAME_DUPLICATE`, `COLOR_INVALID`, `JOKER_INVALID`,
`POINTS_INVALID`, `ALREADY_ZERO`, `SCORE_NOT_FOUND`. Both collections travel
in the realtime snapshot (`teams`, `scores`) to every team member.

## Photo album 📷 and the parents' face search

Photographers (Settings → Fotógrafos), organizers and the admin upload to
`gallery`; the whole album becomes visible to the camp through the single
`settings.galleryPublished` switch (`PUT /api/gallery/publish`).

| Method | Path | Who | Body |
|---|---|---|---|
| GET | `/api/gallery` | anyone logged in | — (published photos; managers also see drafts) |
| POST | `/api/gallery` | admin, organizer, photographer | multipart `file` + `thumb` + `caption?` + `eventId?` |
| PUT | `/api/gallery/publish` | admin, organizer, photographer | `{ published }` |
| PUT | `/api/gallery/:id`, `/bulk`, `/reorder` | admin, organizer, photographer | caption / event / order |
| DELETE | `/api/gallery/:id`, POST `/bulk-delete` | admin, organizer, photographer | — |
| GET | `/api/gallery/:id/thumb` | public (unguessable id) | — |
| POST | `/api/gallery/search-person` | **parent only** | multipart `reference` → `{ matches: [{ photo, similarity }], indexedFaces, pendingPhotos }` |

Parents see the **published album**, same as the team. `POST /api/gallery/search-person`
is an optional filter on top: a reference picture of their child keeps only
the photos whose faces match. The rest of the album is one tap away.

How the matching works (`services/faceRecognition.ts`, `services/galleryFaces.ts`):

1. Every upload is queued for indexing; `backfillGalleryFaces()` catches older
   photos at boot. Both call the private face service, which returns one
   512-float ArcFace embedding per detected face.
2. The embeddings are stored on the photo document (`faces[]`, `faceModel`,
   `facesIndexedAt`) — never the cropped faces, never a person's identity.
3. A search embeds the reference **in memory**, compares it to the stored
   vectors by cosine similarity and keeps the photos above
   `FACE_MATCH_THRESHOLD` (low on purpose: find the kid, extras are ok). The reference image and its embedding are
   discarded when the request ends.

Errors: `FACE_SEARCH_UNAVAILABLE` (503, no service configured),
`FACE_SEARCH_FAILED` (503), `FACE_NOT_FOUND` (no clear face),
`MULTIPLE_FACES` (reference must show one person), `REFERENCE_MISSING`,
`FILE_TYPE` (415), `FILE_TOO_LARGE` (413, 5 MB).

This is biometric data about children: keep the face service cluster-internal,
keep the album unpublished until the photos are reviewed, and drop the
`gallery` collection (embeddings included) when the camp's retention period
ends.

## SMS notifications to the team 📲

`services/notify.ts` texts the team members concerned by a change so they
open the app and read their instructions. The SMS is a short nudge and never
carries details — the app is the source of truth:

> AcampaKids: João, houve uma mudança na sua escala (função). Abra o app para ver suas instruções. https://…

| Toggle (`settings.notifications`) | Fires when | Who gets it |
|---|---|---|
| `bedroomChanges` | a camper's `caretakerId` changes (`POST/PUT/DELETE /api/campers`, `POST /api/staff/:id/move`) | the caretaker who lost the kid and the one who received it — never helpers or the other caretakers of the room |
| `roleChanges` | a person is assigned / reassigned (role or detail) / removed in an event, the event's date or time changes, the event is deleted, or a role's name / instructions / "for everyone" flag changes | each person whose duty in that event changed (explicit assignment or "for everyone" default) |
| `checkinConfirmation` | a team member's church check-in is recorded (`POST /api/staff/me/checkin` or the admin roll call `POST /api/staff/:id/checkin`) | that person — *"seu check-in foi feito com sucesso. Lembre-se de conferir as crianças do seu quarto no app."* Sent at once (not coalesced); undoing a check-in sends nothing |
| `occurrences` | an occurrence is registered (`POST /api/occurrences`, by an admin or the medical team) | every admin account with a phone, except the one who registered it — names who registered and who is involved (never the description). Sent at once; admins are not gated by the team access window |
| `busCheckin` | a kid's BUS check-in is recorded (`POST /api/campers/:id/checkin/bus`) | the kid's guardian — *"a Ana está a caminho de um fim de semana incrível para aprender sobre Jesus! Aproveite o fim de semana livre: vamos cuidar muito bem dela."* (gendered by `Camper.sex`, falling back to `Camper.probableGender`). Sent at once; undo sends nothing |
| `parentWelcome` | the parents' access window (`settings.parentAccessWindow`) is open — checked at boot, at the window edges, when the window / toggle is edited, hourly | every parent account with a kid and a phone, ONCE ever (`users.welcomeSentAt`, atomic claim) — *"a Ana está inscrita no Acampa Kids! Acompanhe tudo pelo app. Entre com o celular … em <app>"*. **Off by default.** Switching a welcome toggle on (this one or `enrolments`) texts everyone pending at once — the admin UI previews the count via `GET /api/settings/welcome-preview` and asks first |
| `parentEdits` | a parent edited their kid's "Informações de saúde" (`PUT /api/campers/:id/parent`) | medical field changed → medical team + every admin + the kid's caretaker; observations only → the caretaker. Sent at once |
| `checkinReminder` | the instant `settings.checkinReminder.at` is reached (timer re-armed on every settings write and at boot, hourly safety net) | every active team member with a phone who has no check-in yet — *"chegou a hora do seu check-in!"*. **Nothing goes out while the date is unset**; sent ONCE per date (atomic claim on `sentAt`), picking a new date re-arms it. Not gated by the team access window |

Rules: only staff with a phone are texted; the notifier diffs BEFORE/AFTER
records so no-op edits (e.g. renaming a kid) send nothing; every change for the
same person within `NOTIFY_COALESCE_SECONDS` (default 20) is merged into ONE
SMS; delivery is fire-and-forget and never blocks or fails the write. Without
`COMTELE_API_KEY` the texts are printed to the console. `APP_URL` (optional)
is appended to the message.

## Multi-role users

- Users are unique by **phone**; each user has a `roles: string[]` array.
- The profiles a person may actually enter with come from the data, not from
  that array — see [Available profiles](#endpoints)
  (`services/roles#availableRolesOf`): `parent` only while a kid of theirs is
  enrolled, `staff` only from an active roster record and never for an admin.
- The login lands on the highest-privilege available profile and the session
  stores it as the active role (JWT + session doc); the switcher
  (`POST /api/auth/role`) accepts nothing outside that same list.

## Multi-year camps

One MongoDB database holds every year's data. Every camp-owned document
carries a `campId`; the `camps` collection is the registry, with exactly one
`active: true` document at a time.

**Global (no `campId`)**:

| Collection | Why |
|---|---|
| `users` | admin / super-admin logins are deployment-wide; parent and team accounts are one-per-phone, and their profile is derived per camp (`availableRolesOf`), so the same phone is a parent in 2025 and nothing in 2026 with no extra data |
| `sessions` | belongs to exactly one camp by definition — carries `campId` as a plain field instead of being filtered by it |
| `camps` | the registry itself |
| `seeds`, `camperImportDictionary` | the wizard's templates and the AI/import column-matching cache — reused every year |
| `files` | image bytes on disk under a global, unguessable id, served by the public sessionless `GET /api/files/:id`; staying global means content imported from another year keeps its pictures without copying bytes. Deleting a camp still removes only that camp's gallery files |
| `userCampState` (new) | the per-year marks that used to live on `users` — `prepDone`, `welcomeSentAt`, `photosSmsSentAt` — one row per `{ userId, campId }` (`models/userCampState.ts`) |

Everything else is **SCOPED** (`services/campScope.ts#SCOPED`): `campers,
staff, bedrooms, categories, transports, teams, scores, schedule_roles,
schedule_events, prep_sections, instructions, occurrences, medicationDoses,
gallery, settings, checkinLog, camperChangeLog, camperLookups,
camperImports, ai_usage, sms_usage`.

**The scoped `Db` proxy** (`db.ts`) is what keeps the ~300 existing
`.collection(name)` call sites untouched. `getDb()` returns a `Proxy` whose
`collection(name)` hands back the real MongoDB collection for a global name,
and a wrapped one for a SCOPED name. The wrapper reads `currentCampId()` **at
call time** and:

- read methods (`find`, `findOne`, `findOneAndUpdate/Replace/Delete`,
  `updateOne/Many`, `replaceOne`, `deleteOne/Many`, `countDocuments`,
  `estimatedDocumentCount`, `distinct`) get `{ campId, ...filter }` merged in
  — or `{ $and: [{ campId }, filter] }` when the filter already uses `$or` /
  `$and` / `$nor` / `campId`, so neither side shadows the other;
- `aggregate` gets a `$match: { campId }` prepended to the pipeline;
- `insertOne` / `insertMany` stamp `campId` on the document; an upsert
  (`updateOne` / `findOneAndUpdate` with `upsert: true`) stamps it into
  `$setOnInsert` instead, so a matching document is never touched;
- `bulkWrite` patches every operation inside it the same way;
- `createIndex(keys, opts)` becomes `{ campId: 1, ...keys }` — every index,
  unique ones included, ends up per camp.

`rawDb()` is the unscoped `Db` — used for the `camps` registry itself, the
boot migration, and `scripts/backup.ts`. `models/settings.ts` and
`models/cleanup.ts` are the only call sites that had to change by hand: the
single `settings` document's `_id` is now the camp id instead of the literal
`"global"`.

**`services/campContext.ts`** holds the request-scoped camp: `withCamp(campId,
fn)` enters an `AsyncLocalStorage`; `currentCampId()` reads it back, falling
back to `activeCampId()` (the cached `camps { active: true }` doc, refreshed
by `refreshActiveCamp()` on boot and on every create/activate) when there is
no context — a fire-and-forget promise or a background job never throws, and
a single-camp deployment behaves exactly as before this feature existed.
`requireAuth` (`middleware/auth.ts`) enters `withCamp(payload.campId)` before
any model call runs. `inHistoryCamp()` is true when the current context is a
camp other than the active one.

### Sessions & switching years

- The JWT and its `sessions` document carry a `campId` (JWT claim `camp`);
  `verifySessionToken` returns it, and sessions created before this feature
  fall back to the active camp.
- Login (`/api/auth/otp/verify`) always lands on the **active** camp.
- `POST /api/auth/camp { campId }` — a global admin, or a staff/health_staff
  session that is an **organizer of the active camp**
  (`services/campAccess.ts#canSwitchCamps`, evaluated in the active camp
  regardless of which camp the session is currently in). Anyone else gets
  `403 CAMP_FORBIDDEN`. Revokes the current session and issues a new one,
  same role, in the target camp.
- A **history session** (its camp ≠ the active one): `activeRole` is forced to
  `admin` for every read (so list/detail endpoints and the realtime snapshot
  answer with the full manager view); `middleware/camp.ts#campWriteGuard`
  refuses every non-GET request under `/api/*` with `403 CAMP_ARCHIVED`,
  except `/api/auth/*`, everything under `/api/camps` (the registry writes
  are their own thing — see below) and the **super admin** (may fix old
  data).
- `/api/auth/me`, `/otp/verify`, `/role` and `/camp` all return `camp: { id,
  label, year, active }`, and `camps: [...]` (the switchable list) only when
  `canSwitchCamps` says the caller may switch — parents, ordinary team and
  medical never get the field, so they never see a year switcher.

### `/api/camps` and `/api/super`

`GET /active` is public (the login screen); everything else needs a session.
"manager" below is `requireManager` (admin or an organizer of the **active**
camp — see [Organizers](#organizers-admin-like-team-members-)); "admin" is a
real global admin (`requireGlobalAdmin` in `routes/camps.ts`, includes the
super admin — it's just the account whose phone matches
`SUPER_ADMIN_PHONE`).

| Method | Path | Who | Does |
|---|---|---|---|
| GET | `/api/camps/active` | public | `{ id, label, year }` |
| GET | `/api/camps` | admin / active-camp organizer | every camp with `{ counts: { campers, staff, photos }, canEnter: true }`; `403 CAMP_FORBIDDEN` otherwise |
| POST | `/api/camps` `{ label, year }` | admin | creates the camp, makes it active (archives the previous one), writes its `settings` defaults (`wizardMode: false`), re-arms the runtime timers → `{ camp }` (201) |
| PUT | `/api/camps/:id` `{ label?, year?, active?: true, archived?: boolean }` | admin | renames / activates / archives; `409 CAMP_ACTIVE` when archiving the active camp |
| POST | `/api/camps/:id/delete/request` | admin, target must not be active | sends a 6-digit code to the **caller's own phone** (5 min — see below) |
| POST | `/api/camps/:id/delete/confirm` `{ code }` | same | wipes the camp → `{ success, removed }` (counts per collection) |
| GET | `/api/camps/:id/summary` | manager | counts per importable block of `:id` |
| GET | `/api/camps/:id/campers?q=` | manager | up to 50 rows (name / guardian name / CPF match), no health fields, each flagged `matched` (a soft match already exists in the active camp) |
| GET | `/api/camps/:id/staff?q=` | manager | same, by name / phone |
| POST | `/api/camps/:id/import` `{ blocks?, camperIds?, staffIds?, withRoles?, withAssignments?, onMatch? }` | manager, only from the **active** camp (`403 CAMP_ARCHIVED` otherwise) | runs the copy engine → `{ result: { <block>: { created, updated, skipped } } }` |

| Method | Path | Who | Does |
|---|---|---|---|
| GET | `/api/super/import-cache` | super admin | `{ count, staff, campers }` — remembered spreadsheet-column mappings |
| POST | `/api/super/import-cache/staff` | super admin | wipes the staff-import column cache → `{ removed }` |
| POST | `/api/super/import-cache` | super admin | wipes the whole staff + camper import dictionary → `{ removed }` |

(`routes/cleanup.ts`'s former import-cache endpoints live here now.)

### Cross-year import (`services/campImport.ts`)

Every imported document gets a **brand-new id** — nothing links back to the
source year. Links inside one run are kept consistent through an in-memory id
map; links to something already in this year are resolved by **soft match**
(accent/case-insensitive, `pt` collation). Run order: categories → teams →
bedrooms → transports → staff → campers → schedule (roles, events) → docs
(instructions, prep_sections) → settings.

| Block | Soft-match key | Reset on import | Notes |
|---|---|---|---|
| categories | `key`; options by `label` | — | new options an imported record points at, with no label match, are created as **draft** options |
| teams | `name` | — | plain copy (`color`, `order`) |
| bedrooms | `name` | — | `group`, beds, notes copied |
| transports | `kind + number` (bus) or `kind + name` (car) | — | |
| staff | `phone`, else `name` | `checkin`, `vest`, `welcomeSentAt`, `photosSmsSentAt`, `prepDone`, `foreignLookup*`, `bedroom`, `team`, `transportation`, `allergies`, `drugAllergies`, `healthIssues`, `active` (always set `true`), `draft` | identity, health, `roomRole`, email copied; room/team/bus remapped or `null`; login ensured via `ensureLoginAccount` |
| campers | `name + birthDate`, else `cpf`, else `externalId` | `checkin`, `busCheckin`, `busReturnCheckin`, `parentEditedAt`, `birthdayNoticeDay`, `caretakerId`, `bedroom`, `team`, `transportation`, `allergies`, `drugAllergies`, `healthIssues`, `importId`, `aiReview*` | identity, health, guardian, insurance copied; **`qrToken` / `externalId` kept** (so this year's spreadsheet import updates them through the existing duplicate flow); guardian login ensured |
| schedule (roles + events) | roles by `name`; events by `date + startTime + title` | — | dates are **not** shifted — copied as-is, re-dated by hand in Programação. `withRoles` default on, `withAssignments` default off (needs the staff block) |
| docs (instructions + prep_sections) | `title` | — | HTML kept verbatim — `/api/files/<id>` references stay valid since files are global |
| settings | — | — | only `checkinLocations`, `notifications`, the staff lists (remapped, dropped when the person wasn't imported), `parentContacts`, `smsRedirect`. Never `checkinWindow`, `parentAccessWindow`, drafts, `checkinReminder`, `galleryPublished`, `wizardMode` |

Not importable — collections that belong to one year and never travel:
`gallery`, `occurrences`, `scores`, `medicationDoses`, `checkinLog`,
`camperChangeLog`, `camperLookups`, `camperImports`, `ai_usage`,
`sms_usage`.

`onMatch` only applies to **staff** and **campers**: `"skip"` (default) leaves
the matched record untouched — safe to re-run an import; `"update"`
overwrites the matched person's identity/health fields but never their
placement (bedroom/team/bus/caretaker) in *this* year, since those fields are
always in the reset list. A guardian's login is ensured on a camper match
too, even when the match itself is skipped. Import ends with `publish()` of
every collection touched, so connected clients update live.

### Camp deletion

`POST /api/camps/:id/delete/request` (admin, target must not be the active
camp) sends a 6-digit code to the **caller's own phone** — real SMS through
Comtele, or printed to the console in mock mode — valid **5 minutes**, **3
attempts** (`services/campDelete.ts`). `POST /.../delete/confirm { code }`
checks it (`evaluateCampDeleteCode`, pure and unit-testable): a stale /
foreign / expired code is `410 CODE_EXPIRED`, a wrong one is `401
INVALID_CODE` with `attemptsLeft`, and the third miss is `429
TOO_MANY_ATTEMPTS` — either way the pending code is cleared and a new request
is needed.

On a correct code, `deleteCamp(campId)` removes, inside `withCamp(campId)`:
the camp's gallery photos and their files on disk, then every other SCOPED
collection's documents for that camp; then (unscoped) its `userCampState`
rows, its `sessions`, and finally the `camps` registry entry itself. Returns
a per-collection removed count, logged and returned to the caller. **Never
the active camp** — enforced at both the request and confirm steps (`409
CAMP_ACTIVE`).

### Backup (`scripts/backup.ts`)

`BACKUP_VERSION` is `2` (was `1`, pre-multi-year). `bun run backup [--camp
<id>]` dumps the whole database as before; `--camp` filters SCOPED
collections to that one camp's documents (global collections are always
dumped in full) — a way to export a single year. Restoring a v1 backup (made
before this feature) stamps every document with **one** camp id: the target
database's active camp, created on the fly (same as the boot migration's
step 1) if the database has none yet — a v1 file always restores as a
single, fully-owned camp, never split.
