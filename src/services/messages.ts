import { config } from "../config";
import { emailSlug, hasEmailTwin, templateDefault, TEMPLATE_SLUGS, type TemplateKey } from "../messages/templates";
import { recordSms } from "../models/smsUsage";
import { campEditionId } from "./acting";
import { coreClient, ipalphaEnabled } from "./ipalpha";
import { MESSAGE_RECIPIENTS_MAX, type MessageAudience, type MessageRecipient, type MessageStatus } from "./ipalpha/coreClient";

/**
 * Every SMS / e-mail Acampa sends goes through notifications-api by personId
 * with a project template (CONTRACTS §13): core resolves the contact and the
 * language, renders and delivers, and logs the access for the person. Acampa
 * never sees a phone or an e-mail address.
 *
 * `{link}` (APP_URL) is filled in here when the template uses it and the
 * caller did not. `{name}` (each recipient's own first name) and
 * `{birthdayNames}` are filled by core — Acampa never sends them. Where Acampa
 * cannot read the member list (a role of the edition, today's birthdays),
 * `sendToRoles` hands core an `audience` and shared variables only — core
 * resolves the people, Acampa never sees them.
 * Best effort: a failure is logged (counts only) and never thrown into the
 * write that triggered it.
 */
export interface SendInput {
  personId: string;
  variables?: Record<string, string | number>;
}

export type SendSummary = Record<MessageStatus, number>;

/** filled by notifications-api per recipient (decision: apps never send names) */
const CORE_FILLED = new Set(["name", "birthdayNames"]);
/** notifications-api cap on `audience.excludePersonIds` */
const EXCLUDE_MAX = 1000;

export function appLink(): string {
  return config.appUrl || "";
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function sendSlug(slug: string, recipients: MessageRecipient[], editionId: string | null): Promise<SendSummary> {
  const summary: SendSummary = { sent: 0, notMember: 0, noContact: 0, failed: 0 };
  for (const batch of chunks(recipients, MESSAGE_RECIPIENTS_MAX)) {
    const results = await coreClient().sendTemplate({ templateSlug: slug, recipients: batch, ...(editionId ? { editionId } : {}) });
    for (const r of results) summary[r.status]++;
  }
  return summary;
}

/** Sends one catalog message (and its e-mail twin, when the catalog has one) to every recipient. */
export async function sendMessage(key: TemplateKey, recipients: SendInput[], label: string = key): Promise<SendSummary | null> {
  const unique = [...new Map(recipients.filter((r) => r.personId).map((r) => [r.personId, r])).values()];
  if (unique.length === 0 || !ipalphaEnabled()) return null;
  const slug = TEMPLATE_SLUGS[key];
  const vars = templateDefault(slug)?.variables ?? [];
  try {
    const full: MessageRecipient[] = unique.map((r) => ({ personId: r.personId, variables: appVariables(vars, r.variables) }));
    const editionId = await campEditionId();
    const sms = await sendSlug(slug, full, editionId);
    void recordSms({ at: new Date(), templateSlug: slug, channel: "sms", sent: sms.sent });
    if (hasEmailTwin(slug)) {
      const mail = await sendSlug(emailSlug(slug), full, editionId);
      void recordSms({ at: new Date(), templateSlug: emailSlug(slug), channel: "email", sent: mail.sent });
    }
    console.log(`[messages] ${label}: ${sms.sent} sent, ${sms.noContact} without contact, ${sms.notMember} not members, ${sms.failed} failed`);
    return sms;
  } catch (err) {
    console.error(`[messages] ${label} failed (${err instanceof Error ? err.message : "error"})`);
    return null;
  }
}

/** The variables Acampa sends: the caller's, `{link}`, every other declared one ("" when unset) — never the ones core fills. */
function appVariables(declared: readonly string[], given: Record<string, string | number> = {}): Record<string, string> {
  const v: Record<string, string> = {};
  for (const [k, val] of Object.entries(given)) if (!CORE_FILLED.has(k)) v[k] = String(val);
  if (declared.includes("link") && v.link === undefined) v.link = appLink();
  // notifications-api refuses the whole batch when a declared variable is missing (§18): never leave one out
  for (const k of declared) if (!CORE_FILLED.has(k)) v[k] ??= "";
  return v;
}

/**
 * Sends one catalog message (and its e-mail twin) to the members of `roles` in the camp's edition (+ project-wide),
 * minus `excludePersonIds`; with `birthdayOf` core sends only to those who see a birthday kid of those roles
 * (`{birthdayNames}`). Variables are shared by everyone. Returns how many messages core
 * accepted, null on failure.
 */
export async function sendToRoles(
  key: TemplateKey,
  roles: string[],
  opts: { birthdayOf?: string[]; excludePersonIds?: string[]; variables?: Record<string, string | number> } = {},
  label: string = key,
): Promise<number | null> {
  if (roles.length === 0 || !ipalphaEnabled()) return null;
  const slug = TEMPLATE_SLUGS[key];
  try {
    const editionId = await campEditionId();
    const exclude = [...new Set(opts.excludePersonIds ?? [])].slice(0, EXCLUDE_MAX);
    const audience: MessageAudience = {
      roles,
      ...(editionId ? { editionId } : {}),
      ...(opts.birthdayOf?.length ? { birthdayOf: { roles: opts.birthdayOf } } : {}),
      ...(exclude.length ? { excludePersonIds: exclude } : {}),
    };
    const shared = (s: string) => appVariables(templateDefault(s)?.variables ?? [], opts.variables);
    const { accepted } = await coreClient().sendTemplateToAudience({ templateSlug: slug, audience, variables: shared(slug) });
    void recordSms({ at: new Date(), templateSlug: slug, channel: "sms", sent: accepted });
    if (hasEmailTwin(slug)) {
      const mail = await coreClient().sendTemplateToAudience({ templateSlug: emailSlug(slug), audience, variables: shared(emailSlug(slug)) });
      void recordSms({ at: new Date(), templateSlug: emailSlug(slug), channel: "email", sent: mail.accepted });
    }
    console.log(`[messages] ${label}: ${accepted} accepted for ${roles.length} role(s)`);
    return accepted;
  } catch (err) {
    console.error(`[messages] ${label} failed (${err instanceof Error ? err.message : "error"})`);
    return null;
  }
}

/** pt-BR preview of a catalog message with the given variables (settings / rooms-apply previews). */
export function previewMessage(key: TemplateKey, variables: Record<string, string | number>): string {
  const body = templateDefault(TEMPLATE_SLUGS[key])?.body["pt-BR"] ?? "";
  return body.replace(/\{(\w+)\}/g, (_, k: string) => (variables[k] !== undefined ? String(variables[k]) : k === "link" ? appLink() : `{${k}}`));
}
