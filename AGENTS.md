# Acampa Kids backend — agent notes

Bun + Hono + MongoDB. Product docs live in `README.md`; production env in `DEPLOYMENT.md`;
route / shape changes of the IPAlpha rewrite in `API_CHANGES.md`.
Run `bun test` and `bunx tsc --noEmit` before every commit.

## People live in IPAlpha core (CONTRACTS_ACAMPA §10–§15)

Intent: IPAlpha owns identity, people, family links, health, roles and message delivery.
Acampa owns CAMP OPERATIONS only — `participants` rows (room, bed, caretaker, team,
vehicle, check-ins, vest, notes) keyed by the IPAlpha `personId`, plus the windows,
programme, documents, scores, photos. Details: README → "Identity, people and roles".

- `GET /live` + `GET /ready` (services/readiness.ts); the server listens before Mongo connects.
- All core HTTP goes through `src/services/ipalpha/coreClient.ts` (inject fakes in tests via
  `src/testing/ipalphaHarness.ts`; no network in tests).
- Roles are §10 project role keys; `services/scope.ts#ROLE_FLAGS` maps them onto scopes. A new
  helper role = a new key in core + (optionally) a flag here — never a settings list.
- Person data at use only: names via `services/people.ts#namesOf` (app client, ≤ 200 per call,
  page the lists), health / contacts with the ACTING role token (`services/acting.ts`), the list
  ♥ via persons health-flags (never a full medical read), counts by project role (no ids). Writes of people go through `services/coreRegistration.ts`
  with the coordenação tokens.
- Messages only through `services/messages.ts` + `src/messages/templates.ts` (5 languages,
  SMS ≤ 160 chars rendered — decision 45). A new message = a new catalog entry + test.
- A 401 from core on a role token ends the session (`services/coreErrors.ts`); never retry it.

Do NOT:

- store, cache or log tokens, codes, phones, e-mails, names, birth dates, documents or health
  (logs carry ids and counts only). The only stored tokens are the session's role tokens,
  SEALED (`SESSION_TOKEN_KEY`). Id relations are fine (decision 70: personId ↔ personId /
  project, e.g. the 20 s responsável → kids memo in `services/members.ts`); names never;
- rebuild an import pipeline: spreadsheets go to persons-api (`routes/imports.ts`, §20) with
  Acampa's `appFields`; results come back as ids + app field values over the ONE dispatch
  app-channel socket (`services/dispatchChannel.ts` — never open a second one) or the HMAC
  webhook, and are applied to `participants` idempotently (`services/personImports.ts`).
  Raw observation / health text never goes into `generalNotes`;
- check a peer (core, dispatch) in `/ready` — only Mongo + boot; peers fail at call time;
- send a role token, a phone or health to the browser outside the role's own reads;
- put person data in the realtime snapshot (camp-ops records only);
- add a local SMS / e-mail / OTP path — answer `503 IPALPHA_UNAVAILABLE` when core is down;
- send `medical` in a persons registration: core reuses a known person (`created: false`) and REPLACES the
  block — health goes through `coreRegistration#mergeHealthInto` (read, union / append, never blank; a block
  the role cannot read is never written);
- make camp activation wait on projects-api (edition rollover is best effort);
- guess sex or any person attribute with AI — sex comes from core with the name (decision 39);
  registrations send `sex` only when the sheet / form said it;
- compute or keep birthdays — core answers today's ids (`birthdays-today`, decision 51); the
  `birthdayNoticeDay` marker only lives on its own day.

## Copy

Backend messages are pt-BR + a machine code; the frontend localizes by code (5 languages).
Template copy is localized here (catalog) and edited in Settings / Mordomia. Pastoral language
applies to every user-facing string: never blunt labels about family shape, loss, health or
money — propose gentler options when in doubt (workspace `AGENTS.md`).
