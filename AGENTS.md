# Acampa Kids backend — agent notes

Bun + Hono + MongoDB. Product docs live in `README.md`; production env in `DEPLOYMENT.md`.
Run `bun test` and `bunx tsc --noEmit` before every commit.

## IPAlpha login (consumer of IPAlpha core)

Intent: IPAlpha owns identity; Acampa keeps its roles (`parent | staff | health_staff | admin`),
access windows, freeze rules and its own sessions. Details: README → "IPAlpha login".

- All core HTTP goes through `src/services/ipalpha/coreClient.ts` (inject fakes in tests;
  no network in tests). Login gates shared by every login path live in `src/services/login.ts` —
  change them there, never fork a copy per route.
- Feature on only with every required `IPALPHA_*` env; never log their values.
- Users carry only `ipalphaPersonIds: string[]` from core (unique multikey index).

Do NOT:

- store, cache or log person tokens, codes, phones or any core profile data (LGPD: person data
  is read at the moment of use — persons-api is read only on a first IPAlpha login);
- cache anything but system tokens (memory only, until 30 s before expiry);
- bind an account through an unverified phone;
- make camp activation wait on projects-api (edition rollover is best effort);
- send a local SMS when auth-api is down — answer `503 IPALPHA_UNAVAILABLE`
  (only `personNotFound` falls back to the local SMS path).

## Copy

Backend messages are pt-BR + a machine code; the frontend localizes by code (5 languages).
Pastoral language applies to every user-facing string: never blunt labels about family shape,
loss, health or money — propose gentler options when in doubt (workspace `AGENTS.md`).
