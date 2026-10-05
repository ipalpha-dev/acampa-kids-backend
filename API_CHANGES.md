# API changes — IPAlpha people rewrite (CONTRACTS_ACAMPA §15)

For the frontend (§16). People, roles and contacts live in IPAlpha; Acampa's API serves
camp operations + person data read live. Every person id below is an **IPAlpha person
id**; `Camper.id` / `Staff.id` / `caretakerId` / `staffId` (assignments) **are** person ids.

## Cross-cutting

- Any authenticated route may answer `401 {code:"SESSION_ENDED"}` (core revoked / expired
  the acting role token — go to login, wipe the offline copy), `503 IPALPHA_UNAVAILABLE`
  (maintenance screen) or `403 {code:"CORE_FORBIDDEN", reason}` (core's role rules).
- The session token is opaque (not a JWT); idle length is sliding (`sessionIdleHours`).
- `byUserId`/`byName`/`camperName`/`createdByName` snapshots are gone everywhere → ids only
  (`byPersonId`, `personId`). Resolve names with `POST /api/people/names`.
- Audience (`requireRole`) is `admin` (coordenação) | `staff` (any team/helper role) |
  `parent` (responsável). `health_staff` is gone.

## Auth `/api/auth`

| Route | Change |
|---|---|
| `POST /otp/request {phone, locale?}` | → `{success, challenge, codeLength, expiresAt, expireMinutes, delivery:"sms"}`. Errors `PHONE_INVALID`, `NOT_IN_PROJECT` (404), `OTP_COOLDOWN`, `IPALPHA_UNAVAILABLE`. Removed `phone/role/roles/reused`, `USER_NOT_FOUND`, `NO_PROFILE`, `SMS_*`, mock delivery. |
| `POST /otp/verify {challenge, code}` | **body changed** (was `{phone, code}`) → login answer. Errors `OTP_INVALID(+attemptsLeft)`, `OTP_EXPIRED`, `ACCOUNT_FROZEN(+minutesLeft)`, `NOT_IN_PROJECT`, `STAFF_ACCESS_*`. |
| `POST /ipalpha/complete {code, state}` | → login answer; `NOT_IN_PROJECT` (403) replaces `NO_PROFILE`. |
| login answer | `{success, token, tokenExpiresAt, sessionIdleHours, user, camp, camps?}`; `user = {id, personId, name, roles: CoreRole[], activeRole: CoreRole, audience, superAdmin}` (no `phone`, `locale`). |
| `GET /me` | `{user, camp, camps?}` (same `user` shape, name read live). |
| `POST /role {role: CoreRole}` | Keeps the SAME token → `{success, tokenExpiresAt, user, camp, camps?}`. Re-checked live; a role gone → 403 `ROLE_FORBIDDEN` and it leaves `user.roles`. Offline key rotates. |
| `POST /camp {campId}` | Same token; coordenação / super admin only. Offline key rotates. |
| **NEW** `GET /offline-key` | `{key (base64, 32 B), alg:"AES-GCM", role, healthAllowed, sessionExpiresAt, campEndsAt}` — `no-store`; wipe the IndexedDB copy on logout, role/camp switch, 401, and after `campEndsAt`. |

CoreRole keys: `coordenacao, organizacao, organizacao-jogos, pontuacao, saude, coletes,
fotografia, checkin, checkin-onibus, equipe, responsavel` (+ future helper keys = equipe).

## Campers `/api/campers` (camp ops only)

Record: `{id, personId, invitedBy, caretakerId, qrToken, team, transportation, bed,
bedroom, generalNotes, bedroomPreference, checkin, busCheckin, busReturnCheckin,
parentEditedAt, importId, createdAt, updatedAt}` (+ `contactsHidden` / `redacted`
views). **Removed:** `name, sex (now from core with the name), birthDate, probableGender, cpf, rg, school, schoolGrade, church,
externalId, weightKg, allergies, drugAllergies, healthIssues, neurodivergent, medications,
foodRestrictions, healthNotes, insurance, insuranceCard, emergencyContact, guardian*`.
Check-in stamps: `{at, byPersonId, byRole: CoreRole, note?}`.

| Route | Change |
|---|---|
| `GET /?cursor&limit≤200&bedroom&q&tag` | **paged** → `{items, nextCursor, total}`; item = record + `name, nickname, sex ("F"\|"M"\|null, from core — decision 39)` (+ `hasHealth` for roles allowed health; + `health` only with `tag=allergies:<optionId>\|drugAllergies:<id>\|healthIssues:<id>\|medications\|neurodivergent\|foodRestrictions` or a `q` with ≤ 6 matches). |
| **NEW** `GET /health-counts?tags=a,b` | `{total, byTag}` (anonymized chips). |
| `GET /:id` | `{camper: record + name, nickname, sex, health? , healthForbidden?, responsibles:[{personId, name}]}`. Health is read with the ACTING role token — for a family, their `responsavel` token (core's own-kids rule, §19). `healthForbidden: true` (+ `health: null`) = core refused this role: show "não disponível para o seu perfil", never "nada informado". |
| `GET /lookup/:id` | camper adds `name`, `health`; `caretaker {id, name}`. |
| `GET /:id/detail` | records only (names via `/api/people/names`). |
| `GET /checkin/log`, `/:id/checkin/log` | `{log:[{id, who, personId, kind, action, at, byPersonId, byRole, note}]}`. |
| `GET /:id/changes` | `{changes:[{id, personId, at, byPersonId, byRole, medical, fields}]}` (no before/after values). |
| `PUT /:id/parent`, `PUT /:id/health` | same field names; health written to persons-api with the acting role token (parents: `responsavel`); answer `{camper: record + health, changed}`. Option ids = `GET /api/people/health-lists`. When core refuses to READ the block: 403 `{code:"CORE_FORBIDDEN", reason:"medicalForbidden"}` and nothing is saved (notes included) — a block we cannot read is never written over. |
| **NEW** `POST /register` | coordenação: `{name, birthDate, responsible:{name, phone}, sex? ("F"\|"M", only when the family said it), homeChurch? (≤ 120), school? {name, grade}, emergencyContact? ({name, phone, relation?} or the free text "Maria (mãe) 11 9…"), health?, …ops}` → 201 `{camper, responsible:{personId, created}, medical: "written"|"unchanged"|"refused"}`. Person fields travel in core's registration (`sex`, `homeChurch`, `data.school/emergencyContact`); **health never does** — core answers a person it knows with `created:false` and would REPLACE their block. Health is merged afterwards (read with the coordenação token, lists unioned, texts kept/appended, never blanked); `refused` = core refused the read/write, nothing was changed. 400 `SEX_INVALID` \| `HOME_CHURCH_INVALID` \| `EMERGENCY_CONTACT_INVALID`. |
| ~~`POST /:id/responsibles`~~ | **removed** (decision 57, CONTRACTS §23): a project role links a responsável only inside the registration / import of that kid (persons `POST /links` is steward-only — `403 linkOnlyDuringRegistration`). A second responsável comes in the spreadsheet import (2º responsável columns), or a steward links them / they accept in IPAlpha. |
| `POST /` | `{personId, …ops}` (an existing IPAlpha person). |
| `PUT /:id` | ops only: `team, transportation, bed, bedroom, caretakerId, invitedBy, qrToken, generalNotes, bedroomPreference`. |
| `DELETE /:id` | `{success, membershipRemoved}`. |

## Staff `/api/staff` (camp ops only)

Record: `{id, personId, active, team, bedroom, roomRole, transportation, generalNotes,
importId, checkin, vest, prepDone, foreignLookupCount, foreignLookupCamperIds, createdAt,
updatedAt}`. **Removed:** `name, sex (from core), phone, email, document, birthDate, admin, probableGender,
allergies…, medications, healthNotes, foreignLookupNames`. Contact views carry no phone —
read it with `GET /api/people/:personId/data/phone` (core's role rules decide).

| Route | Change |
|---|---|
| `GET /?active&cursor&limit&q` | **paged** `{items, nextCursor, total}`; item + `name, nickname, sex` (+ `hasHealth` for managers). |
| `GET /:id` | `{staff: record + name, nickname, health? (self / managers)}`. |
| **NEW** `POST /register` | coordenação: `{name, phone, sex?, homeChurch?, school?, emergencyContact?, …ops}` → registration (person fields in it) + `equipe` membership. Same 400 codes as campers. |
| `POST /` | `{personId, …ops}`. `PUT /:id`: `active, team, transportation, bedroom, roomRole, generalNotes`. `DELETE` → `{success, membershipRemoved}`. |

## NEW `/api/people`

`POST /names {personIds≤200}` → `{items:[{personId, name, nickname, sex}]}` (only people the viewer
may know) · `GET /search?role=participante|equipe|responsavel&q&cursor` (managers) ·
`GET /health-lists` · `GET|PATCH /:personId/data/:kind` (phone, email, document, address,
medical, school, emergencyContact, churchRelationship — acting role token).
**REMOVED (decision 50):** `GET /health-queue` and `POST /health-queue/flush` (now 404) — the
import worker writes AI health to persons-api itself; drop the flush call after `ai-review-done`.

## Other routes

- Medications: **NEW** `GET /prescriptions?cursor` → `{items:[{personId, name, medications, drugAllergies, allergies, healthIssues}], nextCursor}` (allergy lists = church option ids, read live with the acting saúde / coordenação token, never stored — the checklist flags 🚫💊 and the popup shows them); `POST` body `{personId, medName, slot, day?, note?}` (was `camperId`); dose `{id, personId, medKey, medName, dose, day, slot, givenAt, byPersonId, note}`.
- Occurrences: record `{id, campers: personId[], staff: personId[], description, createdBy:{personId, role, group}, createdAt}`.
- Scores: `{…, camperId (personId), byPersonId}` (no `camperName`, `by`); scan answer adds `camperName` (first name).
- Gallery photo: `byPersonId` (was `byName`). Files: `byPersonId`.
- Settings: removed `checkinHelpers, organizers, gameOrganizers, scoreHelpers, medicalStaff, vestHelpers, photographers, smsRedirect, smsEnabled, mailEnabled` (helper roles are managed in Mordomia); `busHelpers {helpers:[{personId, vehicleId}]}`, `parentContacts [{id, title, personId}]`, `foreignLookupOffenders [{personId, count, camperIds, blocked}]`, `superAdmin`. Removed `GET|POST /sample-emails`. `GET /welcome-preview` → `personIds` instead of names.
- **NEW** templates (coordenação): `GET /api/settings/message-templates` → `{templates:[{slug, name, channel, variables, subject, body (5 langs), live, version, customized, defaults}]}` · `POST /message-templates/seed` · `PATCH /message-templates/:slug {name?, body?, subject?}` (400 `TEMPLATE_INVALID`) · `POST /message-templates/:slug/reset`.
- Admins: `GET /api/admins` → `{admins:[{personId, name, superAdmin}], appUrl}`; `POST /api/admins` and `/handover` removed (roles are granted in Mordomia).
- Camps: `POST /:id/delete/request` → `{success, expiresAt, delivery:"sms"}` (no phone); `/:id/campers` rows `{id, name, sex (core), bedroom, team, matched}`; `/:id/staff` rows `{id, name, roomRole, bedroom, team, matched}`; cross-year import results may carry `membershipsFailed`.

## Imports run in persons-api (CONTRACTS §20–§24, decisions 58–67)

**REMOVED:** `/api/camper-imports/*`, `/api/staff-imports/*` (analyze, progress, fields,
leaders/members, apply, needs-sign-in, resume), `/api/worker/*`, `/api/super/import-cache*`,
realtime `ai-review-done` and `import-needs-sign-in`, every `aiReview*` field of camper /
staff records. No AI, staging, dictionary or worker in Acampa any more.

**NEW `/api/imports`** (coordenação / organização reach it; only a session holding
`coordenacao` gets past `403 COORDINATION_REQUIRED` — the importer's coordenação token
calls persons-api, never stored):

| Route | Answer |
|---|---|
| `GET /app-fields?subject=camper\|team` | `{subject, appFields:[{key, description, kind:"text"\|"category", categories?:[{key,label}], required}]}` — camper: `transportation` (required; buses + "Carona: …" cars), `bedroom`, `team`, `bedroomPreference`, `invitedBy`, `generalNotes` (never health); team: `roomRole` (required: caretaker / helper), `transportation`, `bedroom`, `team`, `generalNotes`. Category keys = Acampa ids |
| `POST /` multipart `file` (.csv/.xlsx ≤ 5 MB) + `subject` | 201 `{import}`. 400 `FILE_REQUIRED` \| `FILE_TOO_LARGE` \| `FILE_TYPE_INVALID` \| `SUBJECT_INVALID`; 409 `EDITION_UNKNOWN`. To persons-api: multipart `file` + `data` JSON `{editionId, targets, appFields}`; targets camper `{camper:{role:"participante", responsibleRole:"responsavel"}}`, team `{team:{role:"equipe"}}` |
| `GET /:id` | `{import}` (also catches up batches persons-api has and this side has not applied — decision 77) |
| `PATCH /:id` persons-api's own shape `{mapping?:{column: field\|null}, reviews?:[{id, choice?, value?, rows?}]}` | `{import}`; 400 `DECISIONS_INVALID` (unknown field, a category key the camp does not have, a text over its limit) |
| `POST /:id/apply` | `{import}` (persons-api gets the coordenação projects token in `X-Projects-Authorization`); 409 `DECISIONS_PENDING` `{pending:[{id, kind, field?}]}` |
| `DELETE /:id` | `{success:true}` (cancel; rows wiped in core; batches applied before it are still read) |
| `GET /:id/results?cursor=<batch number>` | `{items:[{batch, rows:[{rowRef, personId, status:"created"\|"updated"\|"skipped"\|"failed", reason, appFields, unfilled}]}], nextCursor}` — ids + app field values only; `cursor` = the FIRST batch to return (1-based), `nextCursor` null when no further batch exists yet |

`import` = `{id, subject, status:"analysing"|"review"|"applying"|"done"|"failed"|"cancelled", failureReason
(a failed apply resumes by applying again; `analysisFailed` is final), steps:[{name:"read"|"columns"|"matching"|
"categories"|"observations"|"apply", done, total}], file:{name,size,sheet}|null, mapping, fields:[core field key |
"app:<key>"], reviews:[{id, kind:"column"|"rowKind"|"invalid"|"match"|"duplicate"|"category"|"observations"|"required",
blocking, options, rowRef, rowRefs, field, who, basis, existingPersonId, firstRowRef, choice, value, rows, resolved,
context:{name?, original?, value?, rows?}}], appFields, counts:{rows, pending, batches, created, updated, skipped, failed},
applied:{batches}, createdAt, expiresAt}`. Apply stays blocked while `counts.pending > 0`. `context` is the
importer's own view of the file (never stored or logged by Acampa).

Realtime (importer's sockets only): `import-progress {importId, step, done, total, status, batch?}`
and `import-batch {importId, batch, rows, applied, skipped, unfilled, conflicts}`.

**`importJobs`** (decision 77, ids only): `{_id: importId, campId, startedBy, status, lastBatch}`. Batches apply
in order, once; at boot, on every app-channel connect and on the importer's reads, unfinished imports are caught up
from persons-api with a live coordenação session of `startedBy`. Entries go once persons-api dropped the import.

**NEW `/api/import-conflicts`** (decision 78; organização): a camp field someone changed by hand since the last
import (`participants.importEdited`, keys only) is never overwritten by a different import value — it waits here.

| Route | Answer |
|---|---|
| `GET /?subject=camper\|team` | `{items:[{id, personId, field, importValue, currentValue, importId, createdAt}]}` (`currentValue` = now; no-longer-different entries are dropped) |
| `POST /resolve {ids, choice:"import"\|"keep"}` | `{applied, kept, failed:[{id, code:"BEDROOM_FULL"\|"BEDROOM_NOT_FOUND"\|"TRANSPORT_NOT_FOUND"\|"TEAM_NOT_FOUND", message}]}` |

**NEW `POST /api/dispatch/webhook`** (dispatch-api only — no session): HMAC-SHA256 of the raw body
with `IPALPHA_WEBHOOK_SECRET` in `X-IPAlpha-Signature: sha256=<hex>` (401 `SIGNATURE_INVALID`, 503
`WEBHOOK_DISABLED` when unset), idempotent by `X-IPAlpha-Delivery` (→ `{ok, duplicate:true}`); 202.

## Review fixes (2026-10-05)

- `GET /live` (always 200) and `GET /ready` (`{ready, checks:{boot, mongo}, info:{dispatch}}`, 503
  until boot finished / Mongo answers); `/api/*` → 503 `STARTING` before boot finished.
- `GET /api/auth/me` answers `tokenExpiresAt` (sliding expiry) — store ONLY the opaque token.
- Lists: `hasHealth` comes from persons health-flags (no medical read); `health-counts` counts the
  edition's role members (no ids sent).
- `POST /api/campers {personId}` needs a live `participante` membership of the camp's edition, `POST
  /api/staff {personId}` a live staff role of it → else 409 `NOT_IN_EDITION`.
- `GET /api/wizard/sample` → `{enabled}`; `POST` → 403 `SAMPLE_DISABLED` unless `IPALPHA_ENV` is
  `preview` / `dev`. The sample's observations go to core health notes, never to `generalNotes`.
- An unknown role key behaves exactly as `equipe` (staff access window included).
- Realtime: logout / revocation / a core 401 close the session's sockets (`error SESSION_ENDED`, 4401);
  a role / camp switch re-keys them and sends a fresh `snapshot`.
- Label "Neurodivergência".

## Birthday messages (decision 51)

`settings.notifications.birthdays` works again: on camp days at 07:45 (São Paulo) the team
of the room of each kid whose birthday is today gets the `acampa-birthday` template
(`{name}`, `{kid}` first name, `{room}`), once per kid per day. No new route; core answers
only the ids of today's birthdays — no birth date ever reaches Acampa.
- Bedrooms `apply/preview`: `messages:[{staffId, messages:[{key, variables}], text}]`.
- Cleanup: staff keep groups are only `busHelpers`, `parentContacts`.
- Removed: `POST /api/ai/guess-sex` (sex comes from core). Bedrooms `apply` checks the wing against the sex read from core.
- Realtime snapshot/update: `campers`/`staff` are the records above (no names, no health).
- Backups are format v3 (mirror `BACKUP_VERSION = 3` on the "Sobre" page).
