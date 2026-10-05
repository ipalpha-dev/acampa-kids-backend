/**
 * Prints Acampa's message template catalog as JSON — the bodies the
 * provisioning Job POSTs to projects-api (`POST /projects/:id/message-templates`,
 * CONTRACTS §11) for a fresh project. No database, no network.
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
