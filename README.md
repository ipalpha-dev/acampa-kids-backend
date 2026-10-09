# Camping Backend 🏕️

Backend for the children's camping management app of **Igreja Presbiteriana em Alphaville**.
Built with **Bun** + **Hono** + **MongoDB**.

## Stack

- **Runtime**: [Bun](https://bun.sh)
- **HTTP framework**: [Hono](https://hono.dev)
- **Database**: MongoDB (official driver)
- **Identity, people, roles, messages**: IPAlpha core (auth-api, persons-api, projects-api, notifications-api) — Acampa keeps camp operations only

## Getting started

```bash
bun install

# start the project's own MongoDB container (camping-mongo, host port 27019)
docker compose up -d

# start the API (watch mode)
bun run dev
```

The API listens on `http://localhost:3000` by default — at once, before
MongoDB connects. Probes: `GET /live` (always 200) and `GET /ready` (200 only
when boot finished and MongoDB answers; `info.dispatch` shows the app-channel
socket, never gating). `/api/*` answers 503 `STARTING` until boot finished.

## Environment

Copy `.env.example` to `.env` for local development. Production configuration and the full variable inventory are documented in [`DEPLOYMENT.md`](./DEPLOYMENT.md). Key variables:

| Variable | Description |
|---|---|
| `MONGODB_URI` / `MONGODB_DB` | MongoDB connection. Code defaults to `mongodb://localhost:27017` / `camping`; the local compose container uses host port `27019` |
| `FILES_DIR` | folder holding the uploaded image bytes (Mongo keeps only the metadata). Default `data/files`. **Mount a volume here in production** |
| `IPALPHA_*` (+ `SESSION_TOKEN_KEY`) | IPAlpha core — identity, people, roles, messages. **All required**: without them nobody can sign in (the API still boots). See [Identity, people and roles](#identity-people-and-roles-ipalpha-core-) |
| `SESSION_HOURS` | fallback session idle length (default `96`) when auth-api answers no `sessionIdleHours` |
| `SUPER_ADMIN_PERSON_IDS` | comma list of IPAlpha person ids — the deployment owners (seeds, archived-year writes) |
| `IPALPHA_DISPATCH_URL`, `IPALPHA_WEBHOOK_SECRET` | optional — the dispatch app channel (socket) and the signed webhook secret for import results (§21/§22) |
| `IPALPHA_ENV` | `preview` / `dev` enable the wizard's synthetic sample camp; anything else (prod) refuses it |
| `TRUST_PROXY_HOPS` | proxies in front of the API that append to `X-Forwarded-For` (default `1` = Traefik ingress); `0` = socket address only |
| `APP_URL` | public URL of the frontend — the `{link}` of the message templates |
| `NOTIFY_COALESCE_SECONDS` | messages to the same person with the same template inside this window collapse into one (default `20`) |
| `FACE_SERVICE_URL` | private face service used by the parents' photo search. **Empty = face search disabled** |
| `FACE_MATCH_THRESHOLD` / `FACE_MIN_DETECTION_SCORE` | face match / detection thresholds (defaults `0.22` / `0.4`) |
| `AI_BASE_URL` / `AI_API_KEY` | OpenAI-compatible API used by the editor AI helpers |
| `AI_LIVE_*` | OpenAI **Live** API for the spoken assistant (empty key = unavailable) |

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

## Identity, people and roles (IPAlpha core) 🔑

Acampa owns **camp operations only** (CONTRACTS_ACAMPA §15). Identity, people
(names, birth dates, documents, contacts, family links, health) and roles live
in IPAlpha: persons-api and projects-api. Every person reference in Acampa's
Mongo is an IPAlpha **person id**; nothing about the person is stored, cached
or logged. All core HTTP goes through `services/ipalpha/coreClient.ts`.

**Roles** are memberships of the one yearly Acampa project (camps = its
editions, `camps.editionId`): per edition `participante` (kids — never sign
in), `responsavel`, `equipe`, `saude`, `organizacao`, `organizacao-jogos`,
`pontuacao`, `coletes`, `fotografia`, `checkin`, `checkin-onibus`; project-wide
`coordenacao` (every edition). They are granted in Oikos (or by Acampa's
imports with the coordenação token). Editions are created in Oikos only, with
Acampa linked to the project or the edition: a camp is created / activated for
an existing edition of its year (`409 EDITION_MISSING` otherwise). `services/scope.ts#ROLE_FLAGS` maps a role
onto what it sees; the WINDOWS (check-in, bus trips, vests, team / parent
access) stay camp ops in `settings`, and so does which vehicle each
`checkin-onibus` person stands at (`settings.busHelpers`). Audiences used by the
route guards: `admin` = coordenação, `staff` = any team / helper role, `parent`
= responsável. Unknown future helper keys behave as `equipe`.

**Login** — both paths end with one IPAlpha token per live role of the person
in the camp's edition (+ project-wide), kept **sealed** (AES-256-GCM,
`SESSION_TOKEN_KEY`) in the Acampa session; the browser only holds an opaque
session token (stored hashed):

| Route | What |
|---|---|
| `GET /api/auth/ipalpha/config` | public: `{enabled, authOrigin, clientId, entryPoint}` |
| `POST /api/auth/ipalpha/start` | PAR (persons + projects + auth resources, `project_id`) → popup URL |
| `POST /api/auth/ipalpha/complete` | `{code, state}` → session |
| `POST /api/auth/otp/request` | `{phone}` → auth-api sends the code (relay v2) → `{challenge}` (sealed, no phone kept) |
| `POST /api/auth/otp/verify` | `{challenge, code}` → session |
| `GET /api/auth/me` · `POST /api/auth/role` · `POST /api/auth/camp` · `POST /api/auth/logout` | who am I (name read live) · switch role (re-checked live in projects-api, no SMS) · switch year (coordenação) · logout |
| `GET /api/auth/offline-key` | per-session key for the encrypted offline copy (rotated by a new session / role / camp switch) |

No role in the project → `NOT_IN_PROJECT`. The session lands on the most
capable role whose access window is open (`STAFF_ACCESS_*` when none is).
Idle length = auth-api's `sessionIdleHours`, sliding. **Any 401 from core on
the acting role token ends the session** (`401 SESSION_ENDED`,
`services/coreErrors.ts`). Super admins (`SUPER_ADMIN_PERSON_IDS`) still need a
role to sign in.

**People at use** (`services/people.ts`, `routes/people.ts`): names with the
REQUESTER's acting role token (≤ 200 per call, the lists are PAGED) — core
answers only who that role may see (roles policy `seesPersonsOf`, below; a
responsável also their own kids), others come back without a name; a timer has
no requester and reads no names. Names are read for the session's camp edition.
Member lists (one role, ids + involvement) use the ACTING role's token only —
core answers when that role `seesPersonsOf` the listed role; a refusal fails
closed (`responsiblesHidden`). A parent's kids and a role check come from the
self read with their own token (`services/members.ts`, `services/viewer.ts`).
Sign-in (popup and SMS relay) asks auth-api for the ACTIVE camp's edition.

**The roles policy Oikos must hold for Acampa** (`seesPersonsOf` on the project
roles — the same table as `deployment/fixtures/2/README.md` and
`deployment/scripts/preview/provision-acampa-kids.py`). Acampa's screens and
messages are built on exactly this; a narrower policy hides people (shown as
such), a wider one shows more than the camp needs:

| Role | Sees the persons of |
|------|---------------------|
| `coordenacao` | every Acampa role (project-wide) |
| `equipe` (caretakers included), `saude`, `organizacao` | `participante`, `responsavel`, `equipe` |
| `checkin`, `checkin-onibus` | `participante`, `responsavel` |
| `organizacao-jogos` | `participante`, `equipe` |
| `pontuacao`, `fotografia` | `participante` |
| `coletes` | `equipe` |
| `responsavel`, `participante` | — (a responsável's own kids come from the self read) |

Health /
contacts / documents with the ACTING role token (persons-api role rules
decide; logged for the person), health-tag chips through the anonymized count
endpoint (acting role token). Lists never show health details (neutral ♥ only) unless filtered by a
health tag or narrowed by name to ≤ 6 people (decision 31).

**Registrations** (wizard sample, manual registration — `services/coreRegistration.ts`):
people go to core through persons `POST /registrations` with everything its DTO
takes — `sex` (only when the form said it, never guessed), `homeChurch` and
`data` blocks `document`, `school`, `emergencyContact` — then the memberships of
the camp's edition; health is merged afterwards (never erased).

**Spreadsheet imports run in persons-api** (CONTRACTS §20/§24, decisions
58–67 — `routes/imports.ts`, `services/personImports.ts`). Acampa hands
persons-api the whole file with the importer's coordenação role token, the
`targets` (kids → `participante` + `responsavel`; team → `equipe`) and its
`appFields` (camp ops: `transportation` — required for kids, buses and
caronas —, `bedroom`, `team`, `bedroomPreference`, `invitedBy`, `generalNotes`
— never health —, `roomRole` — required for the team; categories keyed by
Acampa ids). persons-api runs every step (mapping, matching, observation
extraction into core's health notes, duplicates, category mapping, AI via
ai-api billed to the project) and the importer decides in Acampa's screens.
Results come back batch by batch — ids + app field values only — over the ONE
dispatch app-channel socket (`services/dispatchChannel.ts`) or the signed
webhook (`POST /api/dispatch/webhook`), and are written into `participants`
by personId. Idempotent: `importJobs` (decision 77, ids only: importId, campId,
startedBy, status, lastBatch) applies each batch once and in order, a row
already stamped with the import's id is not touched again, and webhook
deliveries are de-duplicated by `X-IPAlpha-Delivery` (`dispatchDeliveries`,
ids only, TTL 7 days). Missed batches are caught up from persons-api (`GET
/imports/:id/batches`, cursor = next batch number) at boot, on every app-channel
connect and when the importer reads the import — with a live coordenação
session of whoever started it. A camp field changed by hand since the last
import (`participants.importEdited`, keys only) is never overwritten by a
different import value: it becomes an `importConflicts` entry that the
campers / team page asks about ("Aplicar valor da importação" / "Manter o
atual", decision 78). No AI, no staging, no worker, no health in Acampa.

**Messages** (`services/messages.ts`, `src/messages/templates.ts`): every SMS /
e-mail is a project template sent by notifications-api to a person id
(language, contact and access log are core's). The catalog holds the default
copy in 5 languages (`bun scripts/templates-json.ts` prints it); the app owner
creates and edits Acampa's templates in the IPAlpha Developers portal — Acampa
has no template screen. Where Acampa cannot read a member list (a timer, a
family's request), it sends to a role `audience` and core resolves the people.

## Realtime feed (WebSocket) 📡

The frontend is offline-first: it keeps every collection in the device's
localStorage and **never polls**. Instead each logged-in client keeps one
WebSocket open and the server pushes the data.

```
GET /api/realtime?token=<session token>   (upgrade: websocket)
```

The token goes in the query string because browsers can't set headers on a
WebSocket upgrade. An invalid/expired token gets `{ type: "error", code:
"UNAUTHORIZED" }` and close code **4401** (the client then logs out).

Messages (server → client, JSON):

| `type` | when | payload |
|---|---|---|
| `snapshot` | right after connect, or after the client sends `"refresh"` | `data: { campers, staff, bedrooms, categories, roles, events, … }` — only what the session's role may read. `campers` / `staff` are **camp-ops records keyed by person id: no names, no health** (names come from the paged REST lists / `POST /api/people/names`) |
| `update` | after **any** write (debounced 25 ms) | `data` with just the collections that changed, whole lists |
| `ping` | every 30 s | keep-alive; client answers `"pong"` |
| `import-progress` | a persons-api import moved (importer's sockets only) | `data: { importId, step, done, total, status, batch? }` |
| `import-batch` | Acampa applied an import batch (importer's sockets only) | `data: { importId, batch, rows, applied, skipped, unfilled }` (counts) |
| `error` `SESSION_ENDED` | logout, revocation, a core 401 | then close **4401** |

A role or camp switch re-keys the session's open sockets to the new scope and
sends a fresh `snapshot`; a session that ends closes them (4401).

Every route handler that writes calls `publish("campers", "bedrooms", …)`
(`services/realtime.ts`); `services/snapshot.ts` re-reads and serializes the
collections with the exact serializers the REST endpoints use, so the two
shapes never drift. Payloads are whole collections on purpose — the dataset is
small (≈150 kids / 70 staff / 40 rooms / 50 events, ~300 KB) and "replace the
list" keeps the client trivial and always consistent.

Bun serves the socket natively (`Bun.serve({ fetch, websocket })` in
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
| GET | `/api/bedrooms?group=girls\|boys\|staff` | admin, staff | — |
| GET | `/api/bedrooms/:id` | admin, staff | — |
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

  The write endpoints still accept the old boolean `forEveryone` as input (`true` = both positions, `false` = none); it is never stored.
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
| GET | `/api/schedule/roles` | admin, staff | — (team: only the roles that appear in *their* scoped events) |
| POST | `/api/schedule/roles` | admin | `{ name, emoji?, instructions?, preparation?, forRoomRoles?, hasDetail?, detailPlaceholder? }` (legacy `forEveryone` still accepted) |
| PUT | `/api/schedule/roles/:id` | admin | partial |
| DELETE | `/api/schedule/roles/:id` | admin | 409 `ROLE_IN_USE` while referenced by an event |
| GET | `/api/schedule/events` | admin, staff | sorted by day, startTime. **Team scope** (`services/scope.ts#scopeEvent`): every event, but `roles` is cut to the viewer's own função (their assignment, else the ones falling on their `roomRole`) and `assignments` to their own entry — who else does what is never sent. Same for the realtime snapshot. |
| POST | `/api/schedule/events` | admin | `{ date "YYYY-MM-DD", title, emoji?, startTime, endTime?, notes?, roles? }` |
| PUT | `/api/schedule/events/:id` | admin | partial |
| DELETE | `/api/schedule/events/:id` | admin | — |

Error codes: `ROLE_NOT_FOUND`, `EVENT_NOT_FOUND`, `NAME_INVALID`, `NAME_DUPLICATE` (409, case-insensitive),
`INSTRUCTIONS_INVALID`, `FOR_ROOM_ROLES_INVALID`, `ROLE_IN_USE` (409), `DATE_INVALID`, `TITLE_INVALID`,
`START_TIME_INVALID`, `END_TIME_INVALID`, `NOTES_INVALID`, `ROLES_INVALID`.

## Campers (acampantes)

Kids are `participants` rows with `kind: "camper"` (camp ops: room, bed,
caretaker, team, vehicle, check-ins, `invitedBy`, `generalNotes`,
`bedroomPreference`, QR token), `id` = the IPAlpha person id. Name, birth date,
documents, school, responsáveis and health live in core. `GET /api/campers` is
paged (`{items, nextCursor, total}`) with the page's names; see
[`API_CHANGES.md`](./API_CHANGES.md) for every route and shape.

**Caretaker (`caretakerId`)** — the team member (person id) responsible for the
kid: must sleep in the kid's room with `roomRole: "caretaker"` (409
`CARETAKER_INVALID`). A room change without `caretakerId` makes the kid an
**orphan**; a caretaker leaving the room makes their kids orphans.

**What the team sees** (services/scope.ts): a caretaker gets the kids under
their care any time; the rest of their room only WHILE THE CAMP IS HAPPENING —
as **care** records. Coordenação, saúde and check-in keep the full view; health
itself is read with the acting role token, so core's role rules have the last
word.

**Health** (`PUT /:id/health` — saúde / coordenação; `PUT /:id/parent` — the
responsável) is written to persons-api (`medical`); the change log keeps only
WHICH fields changed and who changed them. New kids come from imports or
`POST /api/campers/register` (coordenação: persons registration + `participante`
/ `responsavel` memberships in the edition).

## Staff (equipe)

Team members are `participants` rows with `kind: "team"` (active, room, room
role `caretaker`/`helper`, team, vehicle, check-in, vest, Preparação ticks,
notes), `id` = person id. Whether they may sign in, and as what, comes from
their project roles. `GET /api/staff` is paged with names; new people come
from imports or `POST /api/staff/register` (coordenação: registration +
`equipe` membership); `POST /api/staff {personId}` adds an existing person.
`POST /api/staff/:id/move` keeps its caretaker semantics (orphan / bring /
assign / swap).

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

The session's person must be on this camp's team (active). Errors:
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
(`preparation`) to admin / staff (their room role) and to
PARENTS (only sections listing `parent`); admins and organizers see all.
`AUDIENCE_INVALID` when empty or unknown. Role-specific preparation is
`schedule_roles.preparation`.

Each section is a **checklist item**. The team's ticks live on their roster
record (`staff.prepDone: string[]`, keys `section:<id>` / `role:<id>`); a
PARENT has no roster record, so theirs live on their account
(`userCampState.prepDone`, only `section:<id>` keys) and come back on the
wire as `section.done` — a boolean computed per session, always `false` for
the team and the admin. Deleting a section (or wiping the Instruções /
Preparação block) drops its key from every staff and user record.

Creating / editing a section posted to the parents texts every parent with a
phone (`notifications.parentContentChanges`), only while the parents' access
window is open (checked at send time, coalesced like the team's SMS).

| Method | Path | Who | Body |
|---|---|---|---|
| GET | `/api/preparation` | admin, staff, parent | — (filtered to what the session may see) |
| POST | `/api/preparation` | admin | `{ title, emoji?, audiences?, content? }` |
| PUT | `/api/preparation/reorder` | admin | `{ ids: string[] }` |
| PUT | `/api/preparation/:id` | admin | partial |
| DELETE | `/api/preparation/:id` | admin | — |
| PUT | `/api/preparation/me/:key` | parent | `{ done: boolean }` — ticks / unticks one item of the responsible's checklist; `key` is `section:<id>` (must be a section posted to them). Stored in `userCampState.prepDone` (per person, per camp) |
| PUT | `/api/staff/me/prep/:key` | staff, admin | `{ done: boolean }` — ticks / unticks one item of the person's checklist; `key` is `section:<id>` or `role:<id>`. Stored on the team member's participant row (`prepDone`) |

### Images for the editor 🖼️

| Method | Path | Who | Body |
|---|---|---|---|
| POST | `/api/files` | admin | multipart `file` (jpeg/png/webp/gif, ≤ 2 MB — the frontend shrinks to ≤ 1280 px first) → `{ file: { id, url: "/api/files/<id>", name, type, size } }` |
| GET | `/api/files/:id` | **public** | the image, `cache-control: immutable` |

File bytes live under `FILES_DIR` on a persistent volume; MongoDB's `files`
collection holds metadata. Back up **both MongoDB and the pictures directory**. Ids are 24 random bytes (hex) — unguessable — which
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
| GET | `/api/instructions` | admin, staff | — (sorted by `order`) |
| POST | `/api/instructions` | admin | `{ title, emoji?, content? }` |
| PUT | `/api/instructions/reorder` | admin | `{ ids: string[] }` |
| PUT | `/api/instructions/:id` | admin | partial |
| DELETE | `/api/instructions/:id` | admin | — |

Errors: `TITLE_INVALID` (≤ 120 chars), `CONTENT_INVALID`, `IDS_INVALID`,
`INSTRUCTION_NOT_FOUND`.

## Settings ⚙️

One document per camp with the camp-wide configuration: meeting points,
notification toggles, the windows (check-in, return bus, team / parent access,
score suspense), `busHelpers {helpers:[{personId, vehicleId}]}` and
`parentContacts [{id, title, personId}]`. **Who holds which helper role is not
here any more** — it is a project role in projects-api (Oikos). Message
templates are edited in the IPAlpha Developers portal.

## Parents 👨‍👩‍👧

A parent is a person holding the `responsavel` role in the camp's edition AND
named as involved responsável on their kids' `participante` memberships
(`services/members.ts#kidsOfResponsible`). `resolveParentScope` gives them their
own kids (full), the kids' rooms, the `parentContacts` always and, inside the
parents' window, the team of those rooms (contact view — phones are read from
core with the responsável token). Health edits (`PUT /api/campers/:id/parent`)
go to persons-api; medical changes notify the saúde team, the coordenação and
the caretaker. `settings.parentAccessWindow` gates their sessions.

## Helper roles 🙋

| Role key | What it adds (on top of the person's own team row, when they have one) |
|---|---|
| `organizacao` | the coordenação's data scope and writes, minus its own settings |
| `organizacao-jogos` | programme writes + the scoreboard |
| `pontuacao` | the bulk QR scan by event |
| `saude` | every kid in full + health edits + the medication checklist, always |
| `checkin` | the church roll call while the check-in window is open |
| `checkin-onibus` | the roll call at the door of the vehicle in `settings.busHelpers` (either trip window) |
| `coletes` | every team member's vest, until a week after the camp |
| `fotografia` | uploads / publishes the album |

## Teams (times) 🚩 and scoreboard (placar) 🏆

Teams are their own collection (`teams`: name, `color` #rrggbb, order).
Nothing migrates an older `equipe` category (decision 90: the old database is
dropped at cut-over).

| Method | Path | Who | Body |
|---|---|---|---|
| GET | `/api/teams` | admin, staff | — |
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
| GET | `/api/scores` | admin, staff | — (newest first) |
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

## Messages (notifications) 📲

`services/notify.ts` decides WHO is told WHAT; `services/messages.ts` sends the
project template by person id. Toggles in `settings.notifications` (all off by
default) as before: room / caretaker changes, duties in the programme, own
room / team / vehicle, check-in confirmation and reminder, occurrences
(coordenação), family health edits, bus boarding (the kid's responsáveis),
welcomes (team / families, once per camp), photos published, content changes.
Plain `equipe` members are messaged only inside the team access window; helper
roles and parent contacts always. Families, the coordenação / medical team
from a non-coordenação request and the helpers of the check-in reminder go as
a role `audience` (notifications-api resolves them, minus `excludePersonIds`
— the author of an occurrence, helpers already checked in; shared variables
only). `{name}` (each recipient's own first name) and `{aboutName}` (the kid /
team member the message is about, sent as `aboutPersonId`) are filled by core;
a recipient who may not see that person, or has no name, is skipped by core.
Acampa never sends a name, and a message whose own variables it cannot fill is
not sent (logged as a count) — never a blank or a placeholder. A refused send
(core 403) is logged; it never fails the action that triggered it. Repeated family health edits and Preparação
changes to families collapse within `NOTIFY_COALESCE_SECONDS` like the
per-person messages. A once-only mark (welcome, photos, birthday day) is lifted
only when core clearly refused the send — never after a timeout / network
failure (core may have sent it) nor after a failed e-mail twin. A role audience
with more than 1000 people to leave out is not sent (logged). A responsável new
to the edition who is proposed by a link request is welcomed when the family
accepts. A camp edition that cannot be resolved, or a self read core cannot
answer, is 503 — never "role not held"; only a definitive answer ends a session. Families who join the edition after its welcome went out
(a registration, a copy from another year) get it by id. Messages to the same person with the same
template inside `NOTIFY_COALESCE_SECONDS` collapse into the last one.

**Birthdays** (decision 51): on camp days at 07:45 São Paulo (a timer + the
hourly safety net) Acampa sends `acampa-birthday` to the team roles
(helpers, coordenação; plain `equipe` inside its window) as an audience with
`birthdayOf: {roles: [participante]}` — notifications-api finds today's
birthdays and fills `{birthdayNames}` per recipient with the kids that
recipient's role sees (`seesPersonsOf`; none → skipped). Acampa never learns
who, nor a date. Once per camp
day: `settings.birthdayNoticeDay` (a camp date, not anyone's birthday). A failed
send lifts the marker so the next run retries.

## Multi-year camps

One MongoDB database holds every year's data. Every camp-owned document
carries a `campId`; the `camps` collection is the registry, with exactly one
`active: true` document at a time.

**Global (no `campId`)**:

| Collection | Why |
|---|---|
| `sessions` | one person (IPAlpha person id), their role list and sealed role tokens; carries `campId` as a plain field |
| `camps` | the registry itself |
| `seeds` | the wizard's templates — reused every year |
| `dispatchDeliveries` | ids of webhook deliveries already accepted (TTL 7 days, no payload) |
| `files` | image bytes on disk under a global, unguessable id, served by the public sessionless `GET /api/files/:id`; staying global means content imported from another year keeps its pictures without copying bytes. Deleting a camp still removes only that camp's gallery files |
| `userCampState` | per-year marks of people who are not participant rows (families) — `prepDone`, `welcomeSentAt`, `photosSmsSentAt` — one row per `{ personId, campId }` |

Everything else is **SCOPED** (`services/campScope.ts#SCOPED`): `participants,
bedrooms, categories, transports, teams, scores, schedule_roles,
schedule_events, prep_sections, instructions, occurrences, medicationDoses,
gallery, settings, checkinLog, camperChangeLog, camperLookups,
ai_usage, sms_usage`.

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
boot camp check, TTL indexes and `scripts/backup.ts`. `models/settings.ts` and
`models/cleanup.ts` are the only call sites that had to change by hand: the
single `settings` document's `_id` is now the camp id instead of the literal
`"global"`.

**`services/campContext.ts`** holds the request-scoped camp: `withCamp(campId,
fn)` enters an `AsyncLocalStorage`; `currentCampId()` reads it back, falling
back to `activeCampId()` (the cached `camps { active: true }` doc, refreshed
by `refreshActiveCamp()` on boot and on every create/activate) when there is
no context — a fire-and-forget promise or a background job never throws, and
a single-camp deployment behaves exactly as before this feature existed.
`requireAuth` (`middleware/auth.ts`) enters `withCamp(session.campId)` before
any model call runs. `inHistoryCamp()` is true when the current context is a
camp other than the active one.

### Sessions & switching years

- The `sessions` document carries a `campId`; login always lands on the
  **active** camp.
- `POST /api/auth/camp { campId }` — the coordenação (project-wide role, sees
  every edition) or a super admin. Anyone else gets `403 CAMP_FORBIDDEN`. The
  same session moves to the target camp (the offline key rotates).
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

### `/api/camps`

`GET /active` is public (the login screen); everything else needs a session.
"manager" below is `requireManager` (coordenação or `organizacao`); "admin" is
the coordenação acting as it, or a `SUPER_ADMIN_PERSON_IDS` owner
(`requireGlobalAdmin` in `routes/camps.ts`).

| Method | Path | Who | Does |
|---|---|---|---|
| GET | `/api/camps/active` | public | `{ id, label, year }` |
| GET | `/api/camps` | admin / active-camp organizer | every camp with `{ counts: { campers, staff, photos }, canEnter: true }`; `403 CAMP_FORBIDDEN` otherwise |
| POST | `/api/camps` `{ label, year }` | admin | maps it to the Oikos edition of `year` (`409 EDITION_MISSING {year}` when there is none), creates the camp, makes it active (archives the previous one), writes its `settings` defaults (`wizardMode: false`), re-arms the runtime timers → `{ camp }` (201) |
| PUT | `/api/camps/:id` `{ label?, year?, active?: true, archived?: boolean }` | admin | renames / activates / archives; activating or a new year maps the edition first (`409 EDITION_MISSING`, nothing changed); `409 CAMP_ACTIVE` when archiving the active camp |
| POST | `/api/camps/:id/delete/request` | admin, target must not be active | sends a 6-digit code to the **caller** (template `acampa-camp-delete-code`, by person id — 5 min) |
| POST | `/api/camps/:id/delete/confirm` `{ code }` | same | wipes the camp → `{ success, removed }` (counts per collection) |
| GET | `/api/camps/:id/summary` | manager | counts per importable block of `:id` |
| GET | `/api/camps/:id/campers?q=` | manager | up to 50 rows (name read live), no health, each flagged `matched` (the same person is already in the active camp) |
| GET | `/api/camps/:id/staff?q=` | manager | same, for the team |
| POST | `/api/camps/:id/import` `{ blocks?, camperIds?, staffIds?, withRoles?, withAssignments?, onMatch? }` | manager, only from the **active** camp (`403 CAMP_ARCHIVED` otherwise) | runs the copy engine → `{ result: { <block>: { created, updated, skipped } } }` |


### Cross-year import (`services/campImport.ts`)

Camp-ops documents (categories, teams, bedrooms, transports, schedule, docs,
settings) get **brand-new ids**, linked inside one run through an in-memory id
map and matched to this year's documents by name (accent/case-insensitive).
**People keep their IPAlpha person id** — the same person in every year — so a
copied kid / team member is a new participant row in this camp (placement
reset) plus, with the coordenação's tokens, the membership of this year's
edition: `equipe` for the team; `participante` (the source year's responsáveis
involved) + `responsavel` for the kids. A membership core refuses is counted in
`membershipsFailed` (fix it in Oikos). `onMatch: "update"` refreshes the
camp-ops notes of a person already here; `"skip"` (default) leaves them.
Settings: `checkinLocations`, `notifications`, `busHelpers` / `parentContacts`
of people on this year's team; never windows, drafts, the reminder, the album
flag or the wizard lock. Not importable: `gallery`, `occurrences`, `scores`,
`medicationDoses`, `checkinLog`, `camperChangeLog`, `camperLookups`,
`ai_usage`, `sms_usage`.

### Camp deletion

`POST /api/camps/:id/delete/request` (admin, target must not be the active
camp) sends a 6-digit code to the **caller** through the
`acampa-camp-delete-code` template (notifications-api, by person id) — valid
**5 minutes**, **3 attempts** (`services/campDelete.ts`). `POST /.../delete/confirm { code }`
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

`BACKUP_VERSION` is `3` (people in IPAlpha: `participants`, no `users`).
`bun run backup [--camp <id>]` dumps the database except `sessions`,
`ipalphaLoginStates` (and a leftover `healthQueue` of older versions), and
strips a leftover `camperImports.jobToken` of older versions; `--camp` filters SCOPED collections
to that camp. Files older than v3 hold person data Acampa no longer keeps and
are refused on restore.
