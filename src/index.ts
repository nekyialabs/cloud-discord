// Cloud Discord — Cloudflare Worker providing Discord REST API as MCP tools
// Secret-path authenticated: /mcp/<MCP_SECRET_PATH>

import { DISCORD_TOOLS, handleDiscordTool, toolAnnotations } from './tools';
import { discordFetch, discordFetchMultipart, formatMessage } from './discord';
import Anthropic from '@anthropic-ai/sdk';
import nacl from 'tweetnacl';
import { version } from '../package.json';
import { pollEvents, serveEvents } from './events';
import { Agent, AgentEnv, DEFAULT_AGENT_NAME, findAgentByName, loadAgents, matchMcpPath } from './agents';

type Env = AgentEnv;

export interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
}

// JSON-RPC types
interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  id?: string | number;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function jsonRpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

// MCP server info. The version comes from package.json so it can't drift from releases again
const SERVER_INFO = {
  name: 'cloud-discord',
  version,
};

// Protocol versions this server can speak; the newest is offered when the client asks for one we don't know
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// Sent to clients on initialize; agents read this before picking tools
const SERVER_INSTRUCTIONS = `Discord tools acting as one bot account.
- Every ID (guild, channel, message, user, role) is a numeric string. Find them with discord_list_servers, then discord_list_channels, then discord_read_messages; message lines include message IDs.
- Returning after time away? discord_catch_up shows everything new across a server since a time, and marks what mentions or replies to you.
- Want to know what a community is doing, or find a conversation to join? discord_server_pulse shows who has been around, who talked to whom, and who is still waiting for an answer.
- Woken by a Discord message? Answer with reply_to set to its message ID, so the reply sits in the thread and counts as an answer. For @everyone, answer only if you have something real to add: every agent was woken by the same message.
- Threads and forum posts are channels: pass a thread ID as channel_id to read or send in them.
- The bot can only see and act where its roles allow. "Missing Access" (50001) means it cannot see that channel; "Missing Permissions" (50013) means it lacks the permission or its role is too low.
- Delete, ban, kick and bulk-delete cannot be undone.`;

const SERVER_CAPABILITIES = {
  tools: {},
};

// Signature verification
async function verifyKey(
  request: Request,
  publicKeyHex: string,
): Promise<{ isValid: boolean; body: string }> {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.text();

  if (!signature || !timestamp) {
    return { isValid: false, body };
  }

  function hexToUint8Array(hex: string): Uint8Array {
    const arr = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      arr[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return arr;
  }

  try {
    const isVerified = nacl.sign.detached.verify(
      new TextEncoder().encode(timestamp + body),
      hexToUint8Array(signature),
      hexToUint8Array(publicKeyHex),
    );
    return { isValid: isVerified, body };
  } catch (err) {
    return { isValid: false, body };
  }
}

async function handleVibeCommand(interaction: any, agent: Agent) {
  try {
    const channelId = interaction.channel_id;
    const appId = interaction.application_id;
    const token = interaction.token;

    console.log(`[vibe] Starting vibe check for channel ${channelId} (agent ${agent.name})`);

    if (!agent.anthropicApiKey) {
      await updateInteractionResponse(appId, token, agent.discordToken, 'The vibe check isn\'t set up here yet (no Anthropic API key).');
      return;
    }

    // 1. Fetch last 20 messages
    console.log(`[vibe] Fetching messages...`);
    const res = await discordFetch(agent.discordToken, 'GET', `/channels/${channelId}/messages?limit=20`);
    if (!res.ok) {
      console.log(`[vibe] Fetch failed:`, res);
      throw new Error(`Failed to fetch messages: ${res.status}`);
    }

    const messages = res.data as any[];
    console.log(`[vibe] Fetched ${messages?.length || 0} messages.`);
    if (!messages || messages.length === 0) {
      console.log(`[vibe] No messages found, returning early.`);
      await updateInteractionResponse(appId, token, agent.discordToken, 'It\'s too quiet in here to catch a vibe.');
      return;
    }

    // 2. Format messages (oldest to newest)
    const formatted = messages.reverse().map(formatMessage).join('\n');
    console.log(`[vibe] Formatted trace length: ${formatted.length} chars`);

    // 3. Call Anthropic API
    console.log(`[vibe] Initializing Anthropic...`);
    const anthropic = new Anthropic({
      apiKey: agent.anthropicApiKey,
    });

    console.log(`[vibe] Calling Anthropic API...`);

    const aiResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      temperature: 0.7,
      system: `Analyze the following recent chat log and provide a concise summary of what the chat is currently about, along with a read on the 'vibe'.

Instructions:
- Be direct and observant. No fluff.
- Summarize what they are talking about in 1-2 sentences, then state the vibe.
- Example: "They are debugging a deployment script that keeps 404ing. The vibe is frustrated but focused."`,
      messages: [
        { role: 'user', content: `Here is the recent chat history:\n\n${formatted}\n\nWhat's going on and what's the vibe?` }
      ]
    });

    console.log(`[vibe] Anthropic API returned success.`);
    const vibeSummary = (aiResponse.content[0] as any).text;

    // 4. Update Interaction
    console.log(`[vibe] Updating interaction response...`);
    await updateInteractionResponse(appId, token, agent.discordToken, `**Current Vibe:** ${vibeSummary}`);
    console.log(`[vibe] Done.`);
  } catch (error: any) {
    console.error('[vibe] Error in handleVibeCommand:', error);
    await updateInteractionResponse(interaction.application_id, interaction.token, agent.discordToken, `Uh oh, the vibe check failed: ${error.message || 'Unknown error'}`);
  }
}

async function updateInteractionResponse(appId: string, token: string, botToken: string, content: string) {
  await discordFetch(botToken, 'PATCH', `/webhooks/${appId}/${token}/messages/@original`, { content });
}

export default {
  // Cron trigger: fill each agent's event queue (does nothing unless EVENTS_DB and EVENTS_GUILD_ID are set)
  async scheduled(_controller: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(pollEvents(env, loadAgents(env).filter(a => a.secretPath)));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Discord Interactions Webhook — /interactions for the default bot, /interactions/<agent> for the others
    const interactionsMatch = path.match(/^\/interactions(?:\/([a-z0-9_-]+))?$/);
    if (interactionsMatch && request.method === 'POST') {
      const agent = findAgentByName(loadAgents(env), interactionsMatch[1] ?? DEFAULT_AGENT_NAME);
      if (!agent?.discordPublicKey) {
        return new Response('Not found', { status: 404 });
      }
      const { isValid, body } = await verifyKey(request, agent.discordPublicKey);
      if (!isValid) {
        return new Response('Bad request signature', { status: 401 });
      }

      const interaction = JSON.parse(body);

      // type 1: PING
      if (interaction.type === 1) {
        return Response.json({ type: 1 });
      }

      // type 2: Slash Command
      if (interaction.type === 2 && interaction.data?.name === 'vibe') {
        // Acknowledge the command and defer the response
        ctx.waitUntil(handleVibeCommand(interaction, agent));
        return Response.json({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
      }

      // We will handle type 2 (Commands) here later
      return new Response('Unhandled interaction type', { status: 400 });
    }

    // Health check (public)
    if (path === '/health') {
      return Response.json({ status: 'ok', tools: DISCORD_TOOLS.length });
    }

    // Secret path check — all MCP endpoints require /mcp/<SECRET>, and the secret picks the agent.
    // Unset or CHANGE_ME secrets never match, so an unconfigured deploy isn't open.
    const matched = matchMcpPath(loadAgents(env), path);
    if (!matched) {
      return new Response('Not found', { status: 404 });
    }
    const { agent, subPath } = matched;

    // Event queue for this agent's own session to poll: mentions, replies and @everyone
    if (subPath === '/events' && request.method === 'GET') {
      return serveEvents(env, agent, url);
    }

    // Direct file upload endpoint — bypasses MCP, accepts multipart/form-data
    // Usage: curl -F "channel_id=123" -F "file=@/path/to/file.mp3" -F "message=optional text" URL/mcp/<secret>/upload
    // For DMs: curl -F "user_id=123" -F "file=@/path/to/file.mp3" URL/mcp/<secret>/upload
    if (subPath === '/upload' && request.method === 'POST') {
      try {
        const formData = await request.formData();
        const channelId = formData.get('channel_id') as string | null;
        const userId = formData.get('user_id') as string | null;
        const message = formData.get('message') as string | null;
        const file = formData.get('file') as File | null;

        if (!file) {
          return Response.json({ error: 'Missing "file" field' }, { status: 400 });
        }
        if (!channelId && !userId) {
          return Response.json({ error: 'Must provide "channel_id" or "user_id"' }, { status: 400 });
        }

        // Resolve target channel (DM if user_id, otherwise channel_id)
        let targetChannelId = channelId;
        if (!targetChannelId && userId) {
          const dmRes = await discordFetch(agent.discordToken, 'POST', '/users/@me/channels', { recipient_id: userId });
          if (!dmRes.ok) {
            return Response.json({ error: `Failed to open DM: ${JSON.stringify(dmRes.data)}` }, { status: 500 });
          }
          targetChannelId = (dmRes.data as any).id;
        }

        const buffer = await file.arrayBuffer();
        const fileData = new Uint8Array(buffer);
        const fileName = file.name || 'file';
        const contentType = file.type || 'application/octet-stream';

        const payload: any = {
          attachments: [{ id: 0, filename: fileName }],
        };
        if (message) payload.content = message;

        const res = await discordFetchMultipart(
          agent.discordToken, 'POST',
          `/channels/${targetChannelId}/messages`,
          payload, fileData, fileName, contentType,
        );

        if (!res.ok) {
          return Response.json({ error: `Discord API error`, details: res.data }, { status: 500 });
        }

        return Response.json({
          ok: true,
          message_id: (res.data as any).id,
          file_name: fileName,
          size: fileData.byteLength,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return Response.json({ error: errMsg }, { status: 500 });
      }
    }

    // CORS headers for MCP
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // GET — MCP Streamable HTTP requires responding to GET
    if (request.method === 'GET') {
      return new Response('MCP endpoint active', {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'text/plain' },
      });
    }

    // DELETE — stateless, nothing to close
    if (request.method === 'DELETE') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // POST — main MCP JSON-RPC handler
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    let body: JsonRpcRequest;
    try {
      body = await request.json() as JsonRpcRequest;
    } catch {
      return Response.json(
        jsonRpcError(null, -32700, 'Parse error'),
        { status: 400, headers: corsHeaders },
      );
    }

    const id = body.id ?? null;

    // Notifications (no id) get no JSON-RPC response — just acknowledge them
    if (typeof body.method === 'string' && body.method.startsWith('notifications/')) {
      return new Response(null, { status: 202, headers: corsHeaders });
    }

    try {
      let result: unknown;

      switch (body.method) {
        case 'initialize': {
          const requested = (body.params as { protocolVersion?: string } | undefined)?.protocolVersion;
          result = {
            protocolVersion: requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
              ? requested
              : SUPPORTED_PROTOCOL_VERSIONS[0],
            serverInfo: SERVER_INFO,
            capabilities: SERVER_CAPABILITIES,
            instructions: agent.name === DEFAULT_AGENT_NAME
              ? SERVER_INSTRUCTIONS
              : `This connection acts as the bot for agent "${agent.name}".\n${SERVER_INSTRUCTIONS}`,
          };
          break;
        }

        case 'ping':
          result = {};
          break;

        case 'tools/list':
          result = {
            tools: DISCORD_TOOLS.map(t => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              annotations: toolAnnotations(t.name),
            })),
          };
          break;

        case 'tools/call': {
          const params = body.params as { name: string; arguments?: Record<string, unknown> };
          if (!params?.name) {
            return Response.json(
              jsonRpcError(id, -32602, 'Missing tool name'),
              { headers: corsHeaders },
            );
          }

          try {
            const toolResult = await handleDiscordTool(
              agent.discordToken,
              params.name,
              params.arguments || {},
              { elevenLabsApiKey: agent.elevenLabsApiKey, elevenLabsVoiceId: agent.elevenLabsVoiceId, ai: env.AI, pulseModel: env.PULSE_MODEL, pulseExcludeChannels: env.PULSE_EXCLUDE_CHANNELS },
            );
            result = {
              content: typeof toolResult === 'string' ? [{ type: 'text', text: toolResult }] : toolResult,
            };
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            result = {
              content: [{ type: 'text', text: `Error: ${errMsg}` }],
              isError: true,
            };
          }
          break;
        }

        default:
          return Response.json(
            jsonRpcError(id, -32601, `Method not found: ${body.method}`),
            { headers: corsHeaders },
          );
      }

      return Response.json(jsonRpcResult(id, result), { headers: corsHeaders });

    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return Response.json(
        jsonRpcError(id, -32603, `Internal error: ${errMsg}`),
        { status: 500, headers: corsHeaders },
      );
    }
  },
};
