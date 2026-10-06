import { validateSessionRole } from "../services/acting";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { findSessionByToken, revokeSession } from "../services/session";
import { authorizedClientSession, addClient, clientCount, removeClient, type RealtimeClient } from "../services/realtime";
import { loadCollections } from "../services/snapshot";
import { accessWindowClosed, canSwitchCamps, sessionUser } from "../middleware/auth";
import { activeCampId, withCamp } from "../services/campContext";

/**
 * GET /api/realtime?token=<jwt>  →  WebSocket
 *
 * Browsers can't send an Authorization header on a WebSocket upgrade, so the
 * session token travels in the query string. After the upgrade the server
 * sends `{ type: "snapshot", data }` with every collection the role can read,
 * then `{ type: "update", data }` whenever something changes.
 */
const realtime = new Hono();

realtime.get(
  "/",
  upgradeWebSocket(async (c) => {
    const token = c.req.query("token") ?? "";
    const session = token ? await findSessionByToken(token) : null;
    const unauthorized = () => ({
      onOpen(_evt: unknown, ws: { send: (s: string) => void; close: (code: number, reason: string) => void }) {
        ws.send(JSON.stringify({ type: "error", code: "UNAUTHORIZED", message: "Sessão inválida ou expirada." }));
        ws.close(4401, "unauthorized");
      },
    });
    if (!session) return unauthorized();

    try { await validateSessionRole(session); } catch { return unauthorized(); }
    const campId = session.campId;
    const history = campId !== activeCampId();
    const evicted = await withCamp(campId, async () => {
      if (history) {
        if (canSwitchCamps(session)) return false;
        await revokeSession(session._id);
        return true;
      }
      // the access window closed under an open session
      return accessWindowClosed(session);
    });
    if (evicted) return unauthorized();

    const user = sessionUser(session, history);
    const viewer = { sessionId: session._id, activeRole: user.activeRole, coreRole: user.coreRole, personId: user.personId };
    let client: RealtimeClient | null = null;
    return {
      async onOpen(_evt, ws) {
        await withCamp(campId, async () => {
          client = { ws, role: user.activeRole, coreRole: user.coreRole, personId: user.personId, sessionId: session._id, campId };
          addClient(client);
          try {
            if (!(await authorizedClientSession(client))) return;
            const data = await loadCollections(viewer);
            ws.send(JSON.stringify({ type: "snapshot", at: new Date().toISOString(), data }));
          } catch (err) {
            console.error("realtime: snapshot failed", err);
            ws.send(JSON.stringify({ type: "error", code: "SNAPSHOT_FAILED", message: "Não foi possível carregar os dados." }));
          }
          console.log(`🔌 ws +1 (${clientCount()} online) [${user.coreRole}]${history ? " (history)" : ""}`);
        });
      },
      onMessage(evt, ws) {
        // the client answers pings and may ask for a fresh snapshot
        const text = typeof evt.data === "string" ? evt.data : "";
        if (text === "refresh") {
          // the CURRENT key of this socket (a role / camp switch re-keys it — services/realtime.ts)
          const current = client;
          if (!current) return;
          const now = { sessionId: current.sessionId, activeRole: current.role, coreRole: current.coreRole, personId: current.personId };
          void withCamp(current.campId, async () =>
            (await authorizedClientSession(current) ? loadCollections(now) : Promise.reject(new Error("unauthorized")))
              .then((data) => ws.send(JSON.stringify({ type: "snapshot", at: new Date().toISOString(), data })))
              .catch(() => {}),
          );
        }
      },
      onClose() {
        if (client) removeClient(client);
        console.log(`🔌 ws -1 (${clientCount()} online)`);
      },
      onError() {
        if (client) removeClient(client);
      },
    };
  }),
);

export default realtime;
