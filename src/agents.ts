// Agents — one Worker, several bots. Each agent has its own Discord bot token and its own
// secret MCP URL, so agents never see each other's tokens or act as each other.
//
// Configured with one secret, AGENTS, holding a JSON object keyed by agent name:
//   { "fable": { "secret_path": "...", "discord_token": "...", "elevenlabs_voice_id": "..." } }
// The single-bot settings (DISCORD_BOT_TOKEN + MCP_SECRET_PATH) still work as the "default" agent.

import type { AiBinding } from './pulse';
import type { EventsEnv } from './events';

export interface AgentEnv extends EventsEnv {
  AGENTS?: string;
  DISCORD_BOT_TOKEN?: string;
  MCP_SECRET_PATH?: string;
  DISCORD_PUBLIC_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  // Workers AI, only for discord_server_pulse's optional mood reading
  AI?: AiBinding;
  PULSE_MODEL?: string;
  // Comma-separated channel IDs or names discord_server_pulse never reads, for every agent
  PULSE_EXCLUDE_CHANNELS?: string;
}

export interface Agent {
  name: string;
  secretPath: string;
  discordToken: string;
  discordPublicKey?: string;
  anthropicApiKey?: string;
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
}

export const DEFAULT_AGENT_NAME = 'default';
const MIN_SECRET_LENGTH = 16;
const AGENT_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

interface AgentEntry {
  secret_path?: unknown;
  discord_token?: unknown;
  discord_public_key?: unknown;
  anthropic_api_key?: unknown;
  elevenlabs_api_key?: unknown;
  elevenlabs_voice_id?: unknown;
}

function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value && value !== 'CHANGE_ME' ? value : undefined;
}

function usableSecret(value: unknown): value is string {
  return typeof value === 'string' && value !== 'CHANGE_ME' && value.length >= MIN_SECRET_LENGTH && !value.includes('/');
}

// Parse AGENTS plus the single-bot default. Bad entries are skipped and logged, never served:
// a typo in one agent's config must not open or break the others.
export function parseAgents(env: AgentEnv): { agents: Agent[]; errors: string[] } {
  const agents: Agent[] = [];
  const errors: string[] = [];

  // The default agent exists whenever there's a bot token, so /vibe works without MCP.
  // Without a real MCP_SECRET_PATH its secretPath is empty and no MCP URL reaches it.
  if (env.DISCORD_BOT_TOKEN) {
    agents.push({
      name: DEFAULT_AGENT_NAME,
      secretPath: env.MCP_SECRET_PATH && env.MCP_SECRET_PATH !== 'CHANGE_ME' ? env.MCP_SECRET_PATH : '',
      discordToken: env.DISCORD_BOT_TOKEN,
      discordPublicKey: optional(env.DISCORD_PUBLIC_KEY),
      anthropicApiKey: optional(env.ANTHROPIC_API_KEY),
      elevenLabsApiKey: optional(env.ELEVENLABS_API_KEY),
      elevenLabsVoiceId: optional(env.ELEVENLABS_VOICE_ID),
    });
  }

  if (!env.AGENTS) return { agents, errors };

  let parsed: unknown;
  try {
    parsed = JSON.parse(env.AGENTS);
  } catch {
    errors.push('AGENTS is not valid JSON');
    return { agents, errors };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push('AGENTS must be a JSON object keyed by agent name');
    return { agents, errors };
  }

  for (const [name, raw] of Object.entries(parsed as Record<string, AgentEntry>)) {
    if (!AGENT_NAME.test(name) || name === DEFAULT_AGENT_NAME) {
      errors.push(`agent "${name}": name must be lowercase letters, digits, - or _ (and not "default")`);
      continue;
    }
    if (!raw || typeof raw !== 'object') {
      errors.push(`agent "${name}": must be an object`);
      continue;
    }
    if (!usableSecret(raw.secret_path)) {
      errors.push(`agent "${name}": secret_path must be at least ${MIN_SECRET_LENGTH} characters with no "/"`);
      continue;
    }
    if (typeof raw.discord_token !== 'string' || !raw.discord_token) {
      errors.push(`agent "${name}": discord_token is missing`);
      continue;
    }
    if (agents.some(a => a.secretPath === raw.secret_path)) {
      errors.push(`agent "${name}": secret_path is already used by another agent`);
      continue;
    }
    // Per-agent keys fall back to the shared ones, so one ElevenLabs account can voice several agents
    agents.push({
      name,
      secretPath: raw.secret_path,
      discordToken: raw.discord_token,
      discordPublicKey: optional(raw.discord_public_key),
      anthropicApiKey: optional(raw.anthropic_api_key) ?? optional(env.ANTHROPIC_API_KEY),
      elevenLabsApiKey: optional(raw.elevenlabs_api_key) ?? optional(env.ELEVENLABS_API_KEY),
      elevenLabsVoiceId: optional(raw.elevenlabs_voice_id),
    });
  }

  return { agents, errors };
}

// Parsing runs once per isolate per config, not on every request
let cache: { key: string; result: ReturnType<typeof parseAgents> } | null = null;

export function loadAgents(env: AgentEnv): Agent[] {
  const key = [env.AGENTS, env.DISCORD_BOT_TOKEN, env.MCP_SECRET_PATH, env.DISCORD_PUBLIC_KEY,
    env.ANTHROPIC_API_KEY, env.ELEVENLABS_API_KEY, env.ELEVENLABS_VOICE_ID].join('\u0000');
  if (cache?.key !== key) {
    cache = { key, result: parseAgents(env) };
    for (const error of cache.result.errors) console.error(`[agents] ${error}`);
  }
  return cache.result.agents;
}

function sameSecret(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}

// Resolve /mcp/<secret>[/sub] to an agent and the remaining sub-path ('' or '/upload').
export function matchMcpPath(agents: Agent[], path: string): { agent: Agent; subPath: string } | null {
  if (!path.startsWith('/mcp/')) return null;
  const rest = path.slice('/mcp/'.length);

  let match: { agent: Agent; subPath: string } | null = null;
  for (const agent of agents) {
    if (!agent.secretPath) continue;
    // The default agent's secret may predate the no-"/" rule, so match it as a whole prefix
    const candidate = rest.length > agent.secretPath.length && rest[agent.secretPath.length] === '/'
      ? rest.slice(0, agent.secretPath.length)
      : rest;
    if (sameSecret(candidate, agent.secretPath) && !match) {
      match = { agent, subPath: rest.slice(agent.secretPath.length) };
    }
  }
  return match;
}

export function findAgentByName(agents: Agent[], name: string): Agent | undefined {
  return agents.find(a => a.name === name);
}
