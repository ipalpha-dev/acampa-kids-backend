/**
 * Prints Acampa's message template catalog as JSON — the default copy of
 * Acampa's OWN templates, created and edited by the app owner in the IPAlpha
 * Developers portal (templates with `appId` = Acampa; the project's templates
 * are edited in Oikos). notifications-api sends Acampa's own slug first, else
 * the project's. No database, no network.
 *
 *   bun scripts/templates-json.ts > acampa-templates.json
 */
import { TEMPLATE_DEFAULTS } from "../src/messages/templates";

console.log(
  JSON.stringify(
    TEMPLATE_DEFAULTS.map((t) => ({ slug: t.slug, name: t.name, channel: t.channel, ...(t.subject ? { subject: t.subject } : {}), body: t.body, variables: t.variables })),
    null,
    2,
  ),
);
