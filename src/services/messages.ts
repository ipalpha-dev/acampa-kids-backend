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
 * caller did not. `{name}` (each recipient's own first name), `{aboutName}`
 * (the person the message is about — `aboutPersonId`, a gentle generic when
 * the recipient may not see them) and `{birthdayNames}` are filled by core —
 * Acampa never sends a name. No variable ever goes empty. Where Acampa
 * cannot read the member list (a role of the edition, today's birthdays),
 * `sendToRoles` hands core an `audience` and shared variables only — core
 * resolves the people, Acampa never sees them.
 * Best effort: a failure is logged (counts only) and never thrown into the
 * write that triggered it.
 */
export interface SendInput {
  personId: string;
  variables?: Record<string, string | number>;
  /** the person the message is about (a kid, a team member): core fills `{aboutName}` as the recipient may see it */
  aboutPersonId?: string;
}

export type SendSummary = Record<MessageStatus, number>;

/** filled by notifications-api per recipient (decision: apps never send names) */
const CORE_FILLED = new Set(["name", "aboutName", "birthdayNames"]);
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

async function sendSlug(slug: string, recipients: MessageRecipient[], editionId: string | null, aboutPersonId?: string): Promise<SendSummary> {
  const summary: SendSummary = { sent: 0, notMember: 0, noContact: 0, failed: 0 };
  for (const batch of chunks(recipients, MESSAGE_RECIPIENTS_MAX)) {
    const results = await coreClient().sendTemplate({ templateSlug: slug, recipients: batch, ...(editionId ? { editionId } : {}), ...(aboutPersonId ? { aboutPersonId } : {}) });
    for (const r of results) summary[r.status]++;
  }
  return summary;
}

/** The e-mail twin after its SMS: a failure is logged and never undoes the SMS leg (no mark is lifted for it). */
async function sendTwin(label: string, send: () => Promise<number>, slug: string): Promise<void> {
  try {
    void recordSms({ at: new Date(), templateSlug: slug, channel: "email", sent: await send() });
  } catch (err) {
    console.error(`[messages] ${label} e-mail failed (${err instanceof Error ? err.message : "error"}) — the SMS went out`);
  }
}

/** Sends one catalog message (and its e-mail twin, when the catalog has one) to every recipient. */
export async function sendMessage(key: TemplateKey, recipients: SendInput[], label: string = key): Promise<SendSummary | null> {
  const unique = [...new Map(recipients.filter((r) => r.personId).map((r) => [r.personId, r])).values()];
  if (unique.length === 0 || !ipalphaEnabled()) return null;
  const slug = TEMPLATE_SLUGS[key];
  const byAbout = new Map<string, SendInput[]>();
  for (const r of unique) byAbout.set(r.aboutPersonId ?? "", [...(byAbout.get(r.aboutPersonId ?? "") ?? []), r]);
  const as = (s: string, list: SendInput[]): MessageRecipient[] => list.map((r) => ({ personId: r.personId, variables: appVariables(templateDefault(s)?.variables ?? [], r.variables) }));
  try {
    const editionId = await campEditionId();
    const sms: SendSummary = { sent: 0, notMember: 0, noContact: 0, failed: 0 };
    for (const [about, list] of byAbout) {
      const part = await sendSlug(slug, as(slug, list), editionId, about || undefined);
      for (const k of Object.keys(sms) as MessageStatus[]) sms[k] += part[k];
    }
    void recordSms({ at: new Date(), templateSlug: slug, channel: "sms", sent: sms.sent });
    if (hasEmailTwin(slug)) {
      await sendTwin(label, async () => {
        let sent = 0;
        for (const [about, list] of byAbout) sent += (await sendSlug(emailSlug(slug), as(emailSlug(slug), list), editionId, about || undefined)).sent;
        return sent;
      }, emailSlug(slug));
    }
    console.log(`[messages] ${label}: ${sms.sent} sent, ${sms.noContact} without contact, ${sms.notMember} not members, ${sms.failed} failed`);
    return sms;
  } catch (err) {
    console.error(`[messages] ${label} failed (${err instanceof Error ? err.message : "error"})`);
    return null;
  }
}

/** The variables Acampa sends: the caller's, `{link}`, every other declared one ("—" when unset, never empty) — never the ones core fills. */
function appVariables(declared: readonly string[], given: Record<string, string | number> = {}): Record<string, string> {
  const v: Record<string, string> = {};
  for (const [k, val] of Object.entries(given)) if (!CORE_FILLED.has(k) && String(val).trim()) v[k] = String(val);
  if (declared.includes("link") && v.link === undefined && appLink()) v.link = appLink();
  // notifications-api refuses the whole batch when a declared variable is missing (§18): never leave one out, never empty
  for (const k of declared) if (!CORE_FILLED.has(k)) v[k] ??= "—";
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
  opts: { birthdayOf?: string[]; excludePersonIds?: string[]; variables?: Record<string, string | number>; aboutPersonId?: string } = {},
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
    const about = opts.aboutPersonId ? { aboutPersonId: opts.aboutPersonId } : {};
    const { accepted } = await coreClient().sendTemplateToAudience({ templateSlug: slug, audience, variables: shared(slug), ...about });
    void recordSms({ at: new Date(), templateSlug: slug, channel: "sms", sent: accepted });
    if (hasEmailTwin(slug)) await sendTwin(label, async () => (await coreClient().sendTemplateToAudience({ templateSlug: emailSlug(slug), audience, variables: shared(emailSlug(slug)), ...about })).accepted, emailSlug(slug));
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
