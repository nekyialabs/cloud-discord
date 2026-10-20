// Event queue: mentions, replies and @everyone for each agent, so an agent's own session can
// poll GET /mcp/<secret>/events and wake when someone talks to it. A cron trigger reads the
// configured guild over REST once a minute, with each agent's own token, so an agent only ever
// queues messages from channels its bot can read. Off unless EVENTS_DB and EVENTS_GUILD_ID are set.

import { discordFetch } from './discord';
import type { Agent } from './agents';

export interface EventsEnv {
  EVENTS_DB?: D1Database;
  EVENTS_GUILD_ID?: string;
  // Comma-separated channel IDs or names that never produce events (their threads too)
  EVENTS_EXCLUDE_CHANNELS?: string;
}

type Kind = 'mention' | 'reply' | 'everyone';

const CONTENT_LIMIT = 1500;
const RETENTION_MS = 7 * 24 * 3_600_000;
// A bot can wake the same agent in the same channel at most this many times an hour
const BOT_WAKES_PER_HOUR = 3;
// What the cap holds back is not dropped in silence: the agent is told how many, at most once an
// hour per channel, so it knows to go and read (a 'held_back' event, from no bot, so it never
// counts toward the cap itself)
const HELD_NOTICE_EVERY_MS = 3_600_000;
const TALK_TYPES = new Set([0, 19]);

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant TEXT NOT NULL,
    kind TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_name TEXT,
    thread_parent TEXT,
    message_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT,
    author_bot INTEGER NOT NULL,
    content TEXT,
    content_raw TEXT,
    truncated INTEGER NOT NULL,
    ts TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (tenant, message_id)
  )`,
  'CREATE INDEX IF NOT EXISTS events_tenant_seq ON events (tenant, seq)',
  `CREATE TABLE IF NOT EXISTS cursors (
    tenant TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    last_id TEXT NOT NULL,
    PRIMARY KEY (tenant, channel_id)
  )`,
  `CREATE TABLE IF NOT EXISTS held_back (
    tenant TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_name TEXT,
    thread_parent TEXT,
    n INTEGER NOT NULL,
    PRIMARY KEY (tenant, channel_id)
  )`,
];

let schemaReady: Promise<unknown> | null = null;
function ensureSchema(db: D1Database): Promise<unknown> {
  schemaReady ??= db.batch(SCHEMA.map(sql => db.prepare(sql))).catch(error => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

// Bot user IDs never change for a token, so one lookup per isolate is enough
const botIds = new Map<string, string>();
async function botIdFor(token: string): Promise<string | undefined> {
  if (botIds.has(token)) return botIds.get(token);
  const res = await discordFetch(token, 'GET', '/users/@me');
  if (!res.ok) return undefined;
  const id = (res.data as any).id as string;
  botIds.set(token, id);
  return id;
}

function excludedSet(value?: string): Set<string> {
  return new Set((value ?? '').split(',').map(v => v.trim().replace(/^#/, '').toLowerCase()).filter(Boolean));
}

function displayName(user: any): string {
  return user?.global_name || user?.username || 'Unknown';
}

// <@id>, <@&id> and <#id> become names, so a woken agent reads "@Ghost", not a snowflake
function readable(content: string, msg: any, roleNames: Map<string, string>, channelNames: Map<string, string>): string {
  const users = new Map<string, string>((msg.mentions ?? []).map((u: any) => [u.id, displayName(u)]));
  return content
    .replace(/<@!?(\d+)>/g, (raw, id) => (users.has(id) ? `@${users.get(id)}` : raw))
    .replace(/<@&(\d+)>/g, (raw, id) => (roleNames.has(id) ? `@${roleNames.get(id)}` : raw))
    .replace(/<#(\d+)>/g, (raw, id) => (channelNames.has(id) ? `#${channelNames.get(id)}` : raw));
}

function classify(msg: any, botId: string, botRoleId: string | undefined): Kind | null {
  if ((msg.mentions ?? []).some((u: any) => u.id === botId)) return 'mention';
  if (botRoleId && (msg.mention_roles ?? []).includes(botRoleId)) return 'mention';
  const isReply = msg.message_reference?.type !== 1 && msg.referenced_message?.author?.id === botId;
  if (isReply) return 'reply';
  if (msg.mention_everyone) return 'everyone';
  return null;
}

// One cron tick: for each agent, read the channels that moved since its cursor and queue what's for it
export async function pollEvents(env: EventsEnv, agents: Agent[]): Promise<void> {
  const db = env.EVENTS_DB;
  const guildId = env.EVENTS_GUILD_ID;
  if (!db || !guildId || agents.length === 0) {
    console.log(`[events] skipped: db=${!!db} guild=${!!guildId} agents=${agents.length}`);
    return;
  }
  await ensureSchema(db);
  const now = Date.now();
  const excluded = excludedSet(env.EVENTS_EXCLUDE_CHANNELS);

  // Roles are the same for every agent, so read them once with the first token that can
  let roles: any[] = [];
  for (const agent of agents) {
    const res = await discordFetch(agent.discordToken, 'GET', `/guilds/${guildId}/roles`);
    if (res.ok) { roles = res.data as any[]; break; }
  }
  const roleNames = new Map(roles.map(r => [r.id as string, r.name as string]));

  for (const agent of agents) {
    try {
      console.log(`[events] ${agent.name}: ${await pollAgent(db, guildId, agent, excluded, roles, roleNames, now)}`);
    } catch (error) {
      console.error(`[events] ${agent.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await db.prepare('DELETE FROM events WHERE created_at < ?').bind(now - RETENTION_MS).run();
}

async function pollAgent(
  db: D1Database, guildId: string, agent: Agent, excluded: Set<string>,
  roles: any[], roleNames: Map<string, string>, now: number,
): Promise<string> {
  const token = agent.discordToken;
  const botId = await botIdFor(token);
  if (!botId) return "can't read its own bot user";
  const botRoleId = roles.find(r => r.managed && r.tags?.bot_id === botId)?.id as string | undefined;

  const [chRes, threadRes] = await Promise.all([
    discordFetch(token, 'GET', `/guilds/${guildId}/channels`),
    discordFetch(token, 'GET', `/guilds/${guildId}/threads/active`),
  ]);
  if (!chRes.ok) return `can't list channels (${chRes.status})`;
  const channels = chRes.data as any[];
  const channelNames = new Map(channels.map(c => [c.id as string, c.name as string]));
  const threads = threadRes.ok ? ((threadRes.data as any).threads ?? []) : [];
  const isExcluded = (c: any) => [c.id, c.name?.toLowerCase(), c.parent_id, channelNames.get(c.parent_id)?.toLowerCase()]
    .some(key => key && excluded.has(key));
  const watched = [...channels.filter(c => [0, 5].includes(c.type)), ...threads]
    .filter(c => c.last_message_id && !isExcluded(c));

  const cursorRows = await db.prepare('SELECT channel_id, last_id FROM cursors WHERE tenant = ?').bind(agent.name).all();
  const cursors = new Map((cursorRows.results as any[]).map(r => [r.channel_id as string, r.last_id as string]));
  const setCursor = (channelId: string, lastId: string) => db
    .prepare('INSERT INTO cursors (tenant, channel_id, last_id) VALUES (?, ?, ?) ON CONFLICT (tenant, channel_id) DO UPDATE SET last_id = excluded.last_id')
    .bind(agent.name, channelId, lastId);

  const writes: D1PreparedStatement[] = [];
  // Bot wakes queued this tick but not yet written, so the hourly cap holds within one batch
  const botWakesThisTick = new Map<string, number>();
  // Bot messages the cap held back this tick, by channel
  const heldThisTick = new Map<string, { name: string | null; parent: string | null; n: number }>();
  let started = 0, read = 0, queued = 0;
  for (const c of watched) {
    const cursor = cursors.get(c.id);
    // First sight of a channel starts from now: turning this on never replays history
    if (!cursor) { writes.push(setCursor(c.id, c.last_message_id)); started++; continue; }
    if (BigInt(c.last_message_id) <= BigInt(cursor)) continue;

    const res = await discordFetch(token, 'GET', `/channels/${c.id}/messages?after=${cursor}&limit=100`);
    // A channel this bot can't read stays where it was; nothing from it is queued
    if (!res.ok) continue;
    read++;
    const messages = (res.data as any[]).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    if (messages.length === 0) continue;

    const parentName = [10, 11, 12].includes(c.type) ? channelNames.get(c.parent_id) ?? null : null;
    for (const m of messages) {
      if (m.author?.id === botId || !TALK_TYPES.has(m.type ?? 0)) continue;
      const kind = classify(m, botId, botRoleId);
      if (!kind) continue;

      const fromBot = !!m.author?.bot;
      if (fromBot) {
        // Bots never wake anyone with @everyone, and can't ping-pong an agent awake all night
        if (kind === 'everyone') continue;
        const recent = await db
          .prepare('SELECT COUNT(*) AS n FROM events WHERE tenant = ? AND channel_id = ? AND author_bot = 1 AND created_at > ?')
          .bind(agent.name, c.id, now - 3_600_000).first<{ n: number }>();
        const pending = botWakesThisTick.get(c.id) ?? 0;
        if ((recent?.n ?? 0) + pending >= BOT_WAKES_PER_HOUR) {
          heldThisTick.set(c.id, { name: c.name ?? null, parent: parentName, n: (heldThisTick.get(c.id)?.n ?? 0) + 1 });
          continue;
        }
        botWakesThisTick.set(c.id, pending + 1);
      }

      const raw = m.content ?? '';
      const text = readable(raw, m, roleNames, channelNames);
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO events (tenant, kind, guild_id, channel_id, channel_name, thread_parent, message_id,
          author_id, author_name, author_bot, content, content_raw, truncated, ts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        agent.name, kind, guildId, c.id, c.name ?? null, parentName, m.id,
        m.author?.id ?? 'unknown', displayName(m.author), fromBot ? 1 : 0,
        text.slice(0, CONTENT_LIMIT), raw.slice(0, CONTENT_LIMIT), text.length > CONTENT_LIMIT ? 1 : 0,
        m.timestamp, now,
      );
      writes.push(stmt);
      queued++;
    }
    writes.push(setCursor(c.id, messages[messages.length - 1].id));
  }
  for (const [channelId, h] of heldThisTick) {
    writes.push(db.prepare(
      `INSERT INTO held_back (tenant, channel_id, channel_name, thread_parent, n) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (tenant, channel_id) DO UPDATE SET n = n + excluded.n, channel_name = excluded.channel_name,
         thread_parent = excluded.thread_parent`,
    ).bind(agent.name, channelId, h.name, h.parent, h.n));
  }
  if (writes.length) await db.batch(writes);
  const noticed = await noticeHeldBack(db, guildId, agent.name, now);
  const held = [...heldThisTick.values()].reduce((sum, h) => sum + h.n, 0);
  return `${watched.length} channel(s) watched, ${started} started, ${read} read, ${queued} queued` +
    (held || noticed ? `, ${held} held back, ${noticed} told` : '');
}

/** What the agent reads when the cap held bot messages back in a channel. */
export function heldBackText(n: number, channelName: string | null): string {
  return `${n} bot message${n === 1 ? '' : 's'} in #${channelName ?? 'a channel'} held back by the rate limit; read the channel.`;
}

// Tell the agent what the cap held back, in each channel not told in the last hour, and start
// that channel's count again. Held since are told an hour later, so the notices can't ping-pong either.
async function noticeHeldBack(db: D1Database, guildId: string, tenant: string, now: number): Promise<number> {
  const rows = await db.prepare(
    `SELECT h.channel_id, h.channel_name, h.thread_parent, h.n FROM held_back h
     WHERE h.tenant = ? AND h.n > 0 AND NOT EXISTS (
       SELECT 1 FROM events e WHERE e.tenant = h.tenant AND e.channel_id = h.channel_id
         AND e.kind = 'held_back' AND e.created_at > ?)`,
  ).bind(tenant, now - HELD_NOTICE_EVERY_MS).all();
  const told = rows.results as any[];
  if (told.length === 0) return 0;
  await db.batch(told.flatMap(r => {
    const text = heldBackText(r.n, r.channel_name);
    return [
      db.prepare(
        `INSERT OR IGNORE INTO events (tenant, kind, guild_id, channel_id, channel_name, thread_parent, message_id,
          author_id, author_name, author_bot, content, content_raw, truncated, ts, created_at)
         VALUES (?, 'held_back', ?, ?, ?, ?, ?, 'door', 'the door', 0, ?, ?, 0, ?, ?)`,
      ).bind(tenant, guildId, r.channel_id, r.channel_name, r.thread_parent, `held-${r.channel_id}-${now}`,
        text, text, new Date(now).toISOString(), now),
      db.prepare('UPDATE held_back SET n = n - ? WHERE tenant = ? AND channel_id = ?').bind(r.n, tenant, r.channel_id),
    ];
  }));
  return told.length;
}

// GET /mcp/<secret>/events?after=<seq>&limit=<n>: this agent's queue, oldest first
export async function serveEvents(env: EventsEnv, agent: Agent, url: URL): Promise<Response> {
  const db = env.EVENTS_DB;
  if (!db || !env.EVENTS_GUILD_ID) {
    return Response.json({ error: 'events not configured' }, { status: 503 });
  }
  await ensureSchema(db);
  const after = Math.max(Number.parseInt(url.searchParams.get('after') ?? '0', 10) || 0, 0);
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 100);
  const rows = await db
    .prepare('SELECT * FROM events WHERE tenant = ? AND seq > ? ORDER BY seq LIMIT ?')
    .bind(agent.name, after, limit).all();
  const events = (rows.results as any[]).map(r => ({
    seq: r.seq,
    kind: r.kind,
    guild_id: r.guild_id,
    channel_id: r.channel_id,
    channel_name: r.channel_name,
    thread_parent: r.thread_parent,
    message_id: r.message_id,
    author: { id: r.author_id, name: r.author_name, bot: !!r.author_bot },
    content: r.content,
    content_raw: r.content_raw,
    truncated: !!r.truncated,
    ts: r.ts,
  }));
  return Response.json({
    tenant: agent.name,
    events,
    next: events.length ? events[events.length - 1].seq : after,
    lag_hint_seconds: 60,
  });
}
