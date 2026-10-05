# Acampa backend rewrite (CONTRACTS_ACAMPA §15) — progress

Temporary file for agents resuming the rewrite; deleted in the final commit.
Source of truth: `../../../CONTRACTS_ACAMPA.md` §10–§16, `../../../DECISIONS_ACAMPA.md` 13–37.

## Checklist (§15)

- [ ] 1. Core client (auth PAR/token/relay v2, projects app client + role tokens, persons names/count/data/registrations, notifications send-template) + fakes
- [ ] 2. Sessions `{personId, roles[], activeRole, campId, roleTokens (AES-256-GCM, SESSION_TOKEN_KEY), offline key, expiresAt sliding}`
- [ ] 3. Login: popup + SMS relay → per-role tokens → session; NOT_IN_PROJECT; 401 from core ends session; SUPER_ADMIN_PERSON_IDS; role switch re-checked live; offline-key endpoint
- [ ] 4. Role → scope mapping (§10 keys → scope flags); windows stay in settings; duty lists removed (bus vehicle keyed by personId)
- [ ] 5. `participants` collection replaces campers/staff person fields; personId everywhere (caretakerId, logs, doses, scores, occurrences, gallery, files, camps.createdBy, schedule, settings, parentContacts); name snapshots removed
- [ ] 6. People at use: names (app-names, paged ≤200), details/health via acting role token, counts via count endpoint, health-tag/name filters
- [ ] 7. Messages via §13 templates (`src/messages/templates.ts` catalog, settings proxy via projects:templates); Comtele/SendGrid/OTP removed
- [ ] 8. Imports (campers/staff spreadsheet, cross-camp copy, wizard sample) create persons/links/memberships in core; AI triage writes health through persons-api
- [ ] 9. Realtime snapshot without person data beyond role
- [ ] 10. Remove externalId, SUPER_ADMIN_PHONE, phone indexes, users, ensureRosterLogins, local OTP
- [ ] 11. Docs: API_CHANGES.md, README/AGENTS/.env.example/DEPLOYMENT

## Done

- Commit 1: core client (coreClient.ts), sessions (services/session.ts, sealed tokens, offline key),
  login popup + relay v2 (routes/ipalpha.ts, routes/auth.ts, services/login.ts), role→scope
  (services/scope.ts ROLE_FLAGS), participants (models/participants.ts, campers.ts, staff.ts),
  people service (services/people.ts, routes/people.ts), members (services/members.ts),
  templates catalog (messages/templates.ts) + messages.ts + notify.ts rewrite, settings
  template proxy, imports via core registration (services/coreRegistration.ts), worker →
  healthQueue, cross-camp copy by personId, wizard sample via core, users/OTP/comtele/
  emails/mail/handover removed, app.ts extracted, harness + auth tests.

## Left

- More feature tests: campers/staff lists (paging, names, health rules), templates routes,
  registration, health queue flush, messages, scope mapping, coreClient unit tests.
- Config cleanup (comtele/mail/otp/superAdminPhone/imports keys in config.ts), scripts/,
  .env.example, README/AGENTS/DEPLOYMENT, API_CHANGES.md.
