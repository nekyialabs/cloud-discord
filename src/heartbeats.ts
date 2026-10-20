// Heartbeats: a dead man's switch for machines the house runs. A machine checks in with
// POST /heartbeat/<name> (Authorization: Bearer <HEARTBEAT_KEY>) every few minutes. The cron
// notices when one goes quiet for longer than its limit and posts in a channel, as one agent's
// bot: once when it goes quiet, again every few hours while it stays quiet, and once when it
// is back. Nothing is opened on the machine itself; it only sends. Off unless HEARTBEATS,
// HEARTBEAT_KEY, HEARTBEAT_CHANNEL_ID and EVENTS_DB are set.

import { discordFetch } from './discord';
import type { Agent } from './agents';

export interface HeartbeatEnv {
  EVENTS_DB?: D1Database;
  // Comma-separated name:minutes, e.g. "vale:15": what checks in, and how long silence may last
  HEARTBEATS?: string;
  // Shared secret a machine checks in with
  HEARTBEAT_KEY?: string;
  // Where the alerts go, and which agent's bot posts them (the first agent when unset)
  HEARTBEAT_CHANNEL_ID?: string;
  HEARTBEAT_AGENT?: string;
  // IANA time zone the alerts give times in (UTC when unset)
  HEARTBEAT_TIMEZONE?: string;
}

// While a machine stays quiet, it is said again this often
const REMIND_EVERY_MS = 6 * 3_600_000;

const SCHEMA = `CREATE TABLE IF NOT EXISTS heartbeats (
  name TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL,
  alerted_at INTEGER
)`;

let schemaReady: Promise<unknown> | null = null;
function ensureSchema(db: D1Database): Promise<unknown> {
  schemaReady ??= db.prepare(SCHEMA).run().catch(error => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

/** The configured heartbeats, name to allowed silence in ms. Malformed entries are skipped. */
export function parseHeartbeats(value?: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of (value ?? '').split(',')) {
    const m = part.trim().match(/^([a-z0-9_-]+):(\d+)$/i);
    if (m && Number(m[2]) > 0) out.set(m[1].toLowerCase(), Number(m[2]) * 60_000);
  }
  return out;
}

function clock(ms: number, timeZone?: string): string {
  const zone = timeZone || 'UTC';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })
      .format(new Date(ms)) + (zone === 'UTC' ? ' UTC' : '');
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
}

function span(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hours`;
}

export const HEARTBEAT_QUIET = (name: string, silent: number, lastSeen: string): string =>
  `⚠️ **${name}** has not checked in for ${span(silent)} (last at ${lastSeen}). It, or what runs on it, may be down.`;
export const HEARTBEAT_STILL_QUIET = (name: string, silent: number, lastSeen: string): string =>
  `⚠️ **${name}** is still silent: ${span(silent)} now (last at ${lastSeen}).`;
export const HEARTBEAT_BACK = (name: string, silent: number): string =>
  `✅ **${name}** is checking in again, after ${span(silent)} of silence.`;

function sameKey(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function poster(env: HeartbeatEnv, agents: Agent[]): Agent | undefined {
  return env.HEARTBEAT_AGENT ? agents.find(a => a.name === env.HEARTBEAT_AGENT) : agents[0];
}

async function post(env: HeartbeatEnv, agents: Agent[], content: string): Promise<boolean> {
  const agent = poster(env, agents);
  if (!agent || !env.HEARTBEAT_CHANNEL_ID) return false;
  const res = await discordFetch(agent.discordToken, 'POST', `/channels/${env.HEARTBEAT_CHANNEL_ID}/messages`, { content });
  if (!res.ok) console.error(`[heartbeats] post failed (${res.status})`);
  return res.ok;
}

function configured(env: HeartbeatEnv): boolean {
  return !!(env.EVENTS_DB && env.HEARTBEAT_KEY && env.HEARTBEAT_CHANNEL_ID && parseHeartbeats(env.HEARTBEATS).size);
}

// POST /heartbeat/<name>: the machine is alive. Says so in the channel if it had gone quiet.
export async function receiveHeartbeat(env: HeartbeatEnv, agents: Agent[], request: Request, name: string, now = Date.now()): Promise<Response> {
  if (!configured(env)) return new Response('Not found', { status: 404 });
  const auth = request.headers.get('Authorization') ?? '';
  if (!sameKey(auth, `Bearer ${env.HEARTBEAT_KEY}`)) return new Response('Unauthorized', { status: 401 });
  const key = name.toLowerCase();
  if (!parseHeartbeats(env.HEARTBEATS).has(key)) return new Response('Not found', { status: 404 });
  const db = env.EVENTS_DB!;
  await ensureSchema(db);
  const row = await db.prepare('SELECT last_seen, alerted_at FROM heartbeats WHERE name = ?').bind(key).first<{ last_seen: number; alerted_at: number | null }>();
  await db.prepare(
    'INSERT INTO heartbeats (name, last_seen, alerted_at) VALUES (?, ?, NULL) ON CONFLICT (name) DO UPDATE SET last_seen = excluded.last_seen, alerted_at = NULL',
  ).bind(key, now).run();
  if (row?.alerted_at) await post(env, agents, HEARTBEAT_BACK(key, now - row.last_seen));
  return Response.json({ ok: true, name: key });
}

// One cron tick: say which configured machines have gone quiet. A machine never seen is not
// said: it starts being watched with its first check-in.
export async function checkHeartbeats(env: HeartbeatEnv, agents: Agent[], now = Date.now()): Promise<number> {
  if (!configured(env)) return 0;
  const db = env.EVENTS_DB!;
  await ensureSchema(db);
  let said = 0;
  for (const [name, limit] of parseHeartbeats(env.HEARTBEATS)) {
    const row = await db.prepare('SELECT last_seen, alerted_at FROM heartbeats WHERE name = ?').bind(name).first<{ last_seen: number; alerted_at: number | null }>();
    if (!row) continue;
    const silent = now - row.last_seen;
    if (silent <= limit) continue;
    if (row.alerted_at && now - row.alerted_at < REMIND_EVERY_MS) continue;
    const lastSeen = clock(row.last_seen, env.HEARTBEAT_TIMEZONE);
    const text = row.alerted_at ? HEARTBEAT_STILL_QUIET(name, silent, lastSeen) : HEARTBEAT_QUIET(name, silent, lastSeen);
    // Marked only once said, so a failed post is tried again next minute
    if (await post(env, agents, text)) {
      await db.prepare('UPDATE heartbeats SET alerted_at = ? WHERE name = ?').bind(now, name).run();
      said++;
    }
  }
  return said;
}
