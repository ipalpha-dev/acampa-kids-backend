# Acampa Kids backend — agent notes

Bun + Hono + MongoDB. Product docs live in `README.md`; production env in `DEPLOYMENT.md`;
route / shape changes of the IPAlpha rewrite in `API_CHANGES.md`.
Run `bun test` and `bunx tsc --noEmit` before every commit.

## People live in IPAlpha core (CONTRACTS_ACAMPA §10–§15)

Intent: IPAlpha owns identity, people, family links, health, roles and message delivery.
Acampa owns CAMP OPERATIONS only — `participants` rows (room, bed, caretaker, team,
vehicle, check-ins, vest, notes) keyed by the IPAlpha `personId`, plus the windows,
programme, documents, scores, photos. Details: README → "Identity, people and roles".

- All core HTTP goes through `src/services/ipalpha/coreClient.ts` (inject fakes in tests via
  `src/testing/ipalphaHarness.ts`; no network in tests).
- Roles are §10 project role keys; `services/scope.ts#ROLE_FLAGS` maps them onto scopes. A new
  helper role = a new key in core + (optionally) a flag here — never a settings list.
- Person data at use only: names via `services/people.ts#namesOf` (app client, ≤ 200 per call,
  page the lists), health / contacts with the ACTING role token (`services/acting.ts`), counts
  via the anonymized count endpoint. Writes of people go through `services/coreRegistration.ts`
  with the coordenação tokens.
- Messages only through `services/messages.ts` + `src/messages/templates.ts` (5 languages,
  SMS ≤ 160 chars rendered — decision 45). A new message = a new catalog entry + test.
- A 401 from core on a role token ends the session (`services/coreErrors.ts`); never retry it.

Do NOT:

- store, cache or log tokens, codes, phones, e-mails, names, birth dates, documents or health
  (logs carry ids and counts only). The only stored tokens are SEALED (`SESSION_TOKEN_KEY`):
  the session's role tokens and a running import job's importer token (decision 50, deleted
  when the job ends). AI health goes straight to persons-api — never a health queue;
- send a role token, a phone or health to the browser outside the role's own reads;
- put person data in the realtime snapshot (camp-ops records only);
- add a local SMS / e-mail / OTP path — answer `503 IPALPHA_UNAVAILABLE` when core is down;
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
