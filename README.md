# Cloud Discord

A Discord MCP (Model Context Protocol) server that runs on Cloudflare Workers. It gives an AI agent a Discord bot account to work through: 66 tools for messaging, catching up, a server pulse, search, moderation, forums, roles, files, voice messages and more.

You deploy it once to your own Cloudflare account and connect any MCP client to its URL (Claude Code, Claude Desktop, claude.ai, Cursor, and others). There's no server to keep running, and no database unless you turn on the optional [event queue](#event-queue), which lets an agent wake up when someone talks to it on Discord.

**What you need:** a Cloudflare account (the free tier works), Node.js 18+, and a Discord server where you can add a bot. Setup takes about 15 minutes.

## Contents

- [Setup](#setup)
- [Several agents on one deployment](#several-agents-on-one-deployment)
- [Configuration reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Tips for agents](#tips-for-agents)
- [Optional features](#optional-features): `/vibe`, voice notes, server pulse, event queue, direct file upload
- [Tool reference](#tool-reference)
- [Development](#development)

## Setup

### 1. Create the Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. On the **Bot** tab:
   - Click **Reset Token** and copy the token. Discord shows it once; you'll need it in step 4.
   - Under **Privileged Gateway Intents**, turn on:
     - **Message Content Intent**. Without it, messages the bot reads come back with empty text.
     - **Server Members Intent**. Without it, `discord_get_guild_members` fails.
3. On the **General Information** tab, copy the **Public Key**. You need it in step 3, and it's only used by the optional `/vibe` command.
4. On **OAuth2 > URL Generator**:
   - Scopes: `bot` and `applications.commands`
   - Bot permissions: `Administrator` is the simplest choice. For a narrower bot, pick only what you'll use: View Channels, Send Messages, Send Messages in Threads, Read Message History, Attach Files, Add Reactions, Pin Messages, Send Voice Messages, Manage Messages, Manage Threads, Create Polls, and the moderation and role permissions you need. (Since February 2026, pinning needs **Pin Messages**; Manage Messages alone no longer covers it.)
   - Open the generated URL and invite the bot to your server.

### 2. Clone and install

```bash
git clone https://github.com/nekyialabs/cloud-discord.git
cd cloud-discord
npm install
```

### 3. Set your secret path and public key

Your MCP URL contains a secret path, and anyone who has the URL can use every tool. Generate a long random value:

```bash
openssl rand -hex 24
```

Then edit `wrangler.toml`:

```toml
[vars]
MCP_SECRET_PATH = "the-value-you-generated"
DISCORD_PUBLIC_KEY = "your-public-key"   # or leave CHANGE_ME if you won't use /vibe
```

> **Public fork?** Don't commit a real `MCP_SECRET_PATH`. Delete that line from `wrangler.toml` and store it as a secret instead: `npx wrangler secret put MCP_SECRET_PATH`.

Until `MCP_SECRET_PATH` is set to a real value, the server answers every MCP request with 404.

### 4. Add secrets

Secrets are stored encrypted in Cloudflare and never go in your code. Each command prompts you to paste the value.

```bash
npx wrangler secret put DISCORD_BOT_TOKEN      # required
npx wrangler secret put ANTHROPIC_API_KEY      # optional, for /vibe
npx wrangler secret put ELEVENLABS_API_KEY     # optional, for voice notes
npx wrangler secret put ELEVENLABS_VOICE_ID    # optional, default voice for voice notes
```

The first `wrangler` command asks you to log in to Cloudflare in your browser.

### 5. Deploy

```bash
npm run deploy
```

Wrangler prints your Worker's address, like `https://cloud-discord.<your-subdomain>.workers.dev`. Your MCP URL is that address plus `/mcp/<your-secret-path>`.

### 6. Check it works

```bash
# Should print {"status":"ok","tools":66}
curl https://cloud-discord.<your-subdomain>.workers.dev/health

# Should print a JSON result naming "cloud-discord"
curl https://cloud-discord.<your-subdomain>.workers.dev/mcp/<your-secret-path> \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

If `/health` works but the second command returns `Not found`, the secret path in the URL doesn't match `MCP_SECRET_PATH`.

### 7. Connect your MCP client

Use your full MCP URL: `https://cloud-discord.<your-subdomain>.workers.dev/mcp/<your-secret-path>`.

**Claude Code.** From your project folder:

```bash
claude mcp add --transport http discord https://cloud-discord.<your-subdomain>.workers.dev/mcp/<your-secret-path>
```

Add `--scope user` to make it available in all your projects. Or put it in `.mcp.json` yourself:

```json
{
  "mcpServers": {
    "discord": {
      "type": "http",
      "url": "https://cloud-discord.<your-subdomain>.workers.dev/mcp/<your-secret-path>"
    }
  }
}
```

If you commit `.mcp.json`, the secret URL goes with it. For a shared repo, add the server with `--scope user` instead.

**claude.ai and Claude Desktop.** Go to **Settings > Connectors > Add custom connector** and paste the URL. Leave the OAuth fields empty; the secret path is the authentication. Custom connectors depend on your plan.

**Claude Desktop through its config file.** `claude_desktop_config.json` only starts local (stdio) servers, so bridge to the URL with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "discord": {
      "command": "npx",
      "args": ["mcp-remote", "https://cloud-discord.<your-subdomain>.workers.dev/mcp/<your-secret-path>"]
    }
  }
}
```

**Other clients** (Cursor and so on): add a remote or "Streamable HTTP" MCP server with the same URL.

## Several agents on one deployment

One Worker can serve several agents, each as its own Discord bot with its own name, avatar, roles and permissions. Each agent gets its own MCP URL and only ever uses its own bot token, so agents can't act as each other.

1. **Create a bot for each agent** (Setup, step 1), and invite each one to the servers it should be in.
2. **Describe the agents in a JSON file.** Copy `agents.example.json` to `agents.json` (it's gitignored) and give each agent an entry:

   ```json
   {
     "fable": {
       "secret_path": "output of openssl rand -hex 24",
       "discord_token": "fable's bot token",
       "elevenlabs_voice_id": "fable's voice"
     },
     "simon": {
       "secret_path": "a different random value",
       "discord_token": "simon's bot token"
     }
   }
   ```

   | Field | Required | Notes |
   |-------|----------|-------|
   | `secret_path` | yes | At least 16 characters, no `/`, different for every agent |
   | `discord_token` | yes | This agent's bot token |
   | `elevenlabs_voice_id` | no | This agent's voice for voice notes |
   | `elevenlabs_api_key` | no | Own ElevenLabs key; otherwise the shared `ELEVENLABS_API_KEY` is used |
   | `anthropic_api_key` | no | Own key for `/vibe`; otherwise the shared `ANTHROPIC_API_KEY` is used |
   | `discord_public_key` | for `/vibe` | This bot's public key (Developer Portal > General Information) |

   Agent names are lowercase letters, digits, `-` and `_`. The name `default` is reserved.
3. **Store it as one secret and deploy:**

   ```bash
   npx wrangler secret put AGENTS < agents.json
   npm run deploy
   ```

4. **Connect each agent to its own URL:** `https://cloud-discord.<your-subdomain>.workers.dev/mcp/<that agent's secret_path>`. When the agent connects, the server tells it which agent it is.

To add or change an agent, edit `agents.json` and run `npx wrangler secret put AGENTS < agents.json` again. You don't need to redeploy.

An entry with a problem (a short or repeated `secret_path`, a missing token) is skipped, never served, and the other agents keep working. `npm run tail` shows why an agent was skipped.

**The single-bot setup still works alongside this.** `DISCORD_BOT_TOKEN` with `MCP_SECRET_PATH` acts as an agent named `default`, so an existing deployment keeps its URL when you add more agents.

**`/vibe` for each bot:** register the command for each bot's application (see [/vibe](#vibe-slash-command)), and set that application's Interactions Endpoint URL to `https://cloud-discord.<your-subdomain>.workers.dev/interactions/<agent-name>`. The default bot keeps using `/interactions`.

## Configuration reference

| Name | Kind | Required | What it's for |
|------|------|----------|---------------|
| `DISCORD_BOT_TOKEN` | secret | yes | The bot's token from the Developer Portal |
| `MCP_SECRET_PATH` | var or secret | yes | The secret part of your MCP URL. The server returns 404 while it's unset or `CHANGE_ME` |
| `DISCORD_PUBLIC_KEY` | var | for `/vibe` | Verifies that interaction requests really come from Discord |
| `ANTHROPIC_API_KEY` | secret | for `/vibe` | Writes the vibe summary |
| `ELEVENLABS_API_KEY` | secret | for voice notes | Text-to-speech |
| `ELEVENLABS_VOICE_ID` | secret | no | Default voice, so `voice_id` can be left out of each call |
| `AGENTS` | secret | no | JSON describing extra agents; see [Several agents](#several-agents-on-one-deployment) |
| `AI` | Workers AI binding | for pulse mood | Lets `discord_server_pulse` write its optional mood reading; see [Server pulse](#server-pulse) |
| `PULSE_MODEL` | var | no | Workers AI model for the mood reading. Default `@cf/google/gemma-4-26b-a4b-it` |
| `PULSE_EXCLUDE_CHANNELS` | var | no | Comma-separated channel IDs or names the pulse never reads, for every agent |
| `EVENTS_DB` | D1 binding | for the event queue | Holds each agent's queue of mentions, replies and @everyone; see [Event queue](#event-queue) |
| `EVENTS_GUILD_ID` | var | for the event queue | The one server the queue watches |
| `EVENTS_EXCLUDE_CHANNELS` | var | no | Comma-separated channel IDs or names that never produce events |

For local development, put secrets in `.dev.vars` (copy `.dev.vars.example`). It's gitignored.

## Troubleshooting

| What you see | What it means | Fix |
|--------------|---------------|-----|
| `Not found` on the MCP URL | Wrong or missing secret path | Check the URL ends in `/mcp/<MCP_SECRET_PATH>` (or the agent's `secret_path`) exactly, and that it isn't `CHANGE_ME` |
| `Not found` for one agent only | Its `AGENTS` entry was skipped | Run `npm run tail`, reconnect, and look for an `[agents]` line saying why |
| `Missing Access` (code 50001) | The bot can't see that channel | Give the bot's role **View Channel** on the channel or its category. Private channels need an explicit overwrite |
| `Missing Permissions` (code 50013) | The bot can see it but isn't allowed to do that | Grant the permission, or move the bot's role higher. A bot can't manage roles or members ranked at or above its own highest role |
| Messages come back as `[no text content]` | Message Content Intent is off | Turn it on (Setup, step 1) |
| `discord_get_guild_members` fails | Server Members Intent is off | Turn it on (Setup, step 1) |
| `Unknown Channel` / `Unknown Message` (10003 / 10008) | Wrong ID, or it was deleted | IDs are long numbers; re-list to get fresh ones |
| `Cannot send messages to this user` (50007) | The user has DMs closed or shares no server with the bot | Nothing the bot can do; message them in a channel instead |
| Pinning fails with Missing Permissions | Pinning needs **Pin Messages** since February 2026 | Grant Pin Messages to the bot's role |
| Voice note arrives as a file, not a voice message | The bot lacks **Send Voice Messages** there | Grant it; the tool falls back to a file so nothing is lost |
| Forwarding fails with code 160014 | The bot can't read the original message's content | Give it Read Message History there, and keep Message Content Intent on |
| Search says the server is being indexed | First search in that server | Try again after the few seconds it names |
| `Rate limited; retry after Ns` | Discord asked the bot to slow down for longer than the server waits | Wait that long and try again |
| Voice note: `ElevenLabs API key not configured` | `ELEVENLABS_API_KEY` isn't set | `npx wrangler secret put ELEVENLABS_API_KEY` |
| Pulse mood says it's unavailable | No Workers AI binding | Add `[ai] binding = "AI"` to `wrangler.toml` and deploy |
| `/events` returns 503 `events not configured` | `EVENTS_DB` or `EVENTS_GUILD_ID` is missing | See [Event queue](#event-queue) |
| `/events` stays empty right after switching on | Expected: there's no backfill, and each channel starts from the first tick that sees it | Wait a minute, then mention the bot to test |
| `/events` never fills | The cron isn't running, or can't read the channels | `npm run tail` and look for one `[events]` line per agent each minute. No lines: run `npx wrangler triggers deploy` (needed once if you deploy with `versions deploy`). "0 channel(s) watched": check `EVENTS_GUILD_ID` and the bot's View Channel permission |
| Events from one channel never arrive | That bot can't read the channel (each agent reads with its own token), or it's excluded | Grant View Channel and Read Message History, or check `EVENTS_EXCLUDE_CHANNELS` |

To see live logs from your deployed Worker, run `npm run tail`.

## Tips for agents

The server sends these to MCP clients as instructions, and they're here for humans too:

- **Coming back after time away?** `discord_catch_up` with `since: "8h"` shows every channel and thread that moved, newest first, and marks messages that mention or reply to the bot with "→ you". It's one call instead of reading channels one by one.
- **Want the shape of things rather than the messages?** `discord_server_pulse` with `since: "24h"` shows who has been around and where, who replied to or mentioned whom, open loops (people who were addressed and haven't spoken in that channel since), and things said to the whole room that nobody has answered yet. It's a good place to find a conversation to join. Add `mood: true` for a short reading of the mood and what people are working on.
- **Looking for something specific?** `discord_search_messages` searches the whole server by text, author, channel or mention.
- **Everything is addressed by ID.** Start with `discord_list_servers` (guild IDs), then `discord_list_channels` (channel IDs), then `discord_read_messages` (each message line includes its ID). Humans can copy IDs in Discord after turning on **Settings > Advanced > Developer Mode**.
- **Threads and forum posts are channels.** Pass a thread's ID as `channel_id` to read or send in it.
- **Custom emoji** can be passed as `<:name:id>` or `name:id`; Unicode emoji are passed as-is.
- **Tools are annotated.** Read-only tools are marked `readOnlyHint`, and tools that delete, ban, kick, or change permissions are marked `destructiveHint`, so clients can ask before running them.
- **Mentions are safe by default.** User mentions ping, but @everyone, @here and role mentions don't unless a tool call sets `allow_mass_mentions: true`.
- **Long messages are fine.** Anything over Discord's 2000-character limit is split at paragraph or line breaks, with code blocks kept intact.
- **Woken by a Discord message?** If your session polls the [event queue](#event-queue), answer with `reply_to` set to the message ID you were given, so the answer sits in its thread and people (and `discord_server_pulse`) can see it was answered. For an @everyone, answer only if you have something real to add, because every agent got the same wake.
- **Images come back as images.** `discord_fetch_image` returns the picture itself, not a link, so a vision-capable model can look at it.

## Optional features

### `/vibe` slash command

Anyone in your server can type `/vibe` to get a one-paragraph read on what the channel is talking about and its mood. It reads the last 20 messages and summarizes them with Claude.

1. Set `DISCORD_PUBLIC_KEY` (step 3) and `ANTHROPIC_API_KEY` (step 4), and deploy.
2. Register the command once. The Application ID is on the Developer Portal's **General Information** tab:
   ```bash
   DISCORD_APP_ID=your_app_id DISCORD_BOT_TOKEN=your_token npx tsx src/register-commands.ts
   ```
3. In the Developer Portal, set **Interactions Endpoint URL** to `https://cloud-discord.<your-subdomain>.workers.dev/interactions` and save. Discord checks the endpoint right away, so the Worker must already be deployed with the right public key.

### Voice messages

`discord_send_voice_note` turns text into speech with [ElevenLabs](https://elevenlabs.io/) and posts it as a native Discord voice message: the playable bubble with a waveform, like one recorded on a phone. The audio is generated as Ogg/Opus at 48 kHz and 32 kbps, the same as Discord's own clients. The duration and waveform are read from the Ogg file itself, with no audio decoding in the Worker.

If the bot isn't allowed to send voice messages somewhere (it needs **Send Voice Messages**), the same audio is sent as an ordinary file instead. Pass `as_voice_message: false` to get an mp3 attachment.

1. Get an ElevenLabs API key and set it: `npx wrangler secret put ELEVENLABS_API_KEY`
2. Find a voice ID in the [Voice Lab](https://elevenlabs.io/app/voice-lab). Either set it as the default (`npx wrangler secret put ELEVENLABS_VOICE_ID`) or pass `voice_id` on each call.

Without the API key, only this tool returns an error; everything else works normally.

### Server pulse

`discord_server_pulse` works with nothing extra. Its counts, connections and open loops come from the messages themselves. The optional mood reading (`mood: true`) needs a [Workers AI](https://developers.cloudflare.com/workers-ai/) binding, which uses Cloudflare's free daily allowance rather than any API key. Add this to `wrangler.toml` and deploy:

```toml
[ai]
binding = "AI"
```

The default model is Gemma 4 26B-A4B with its reasoning turned off. A reading at full size (about 12,000 characters of messages) measured about 30 neurons, against 10,000 free each day. Set `PULSE_MODEL` to use another model. The reading is labelled as a model's reading in the output, because that's what it is.

If some channels should never end up in a pulse or a digest made from one (for example sign-ups, moderation or anything private), list them in `PULSE_EXCLUDE_CHANNELS`. Their threads are left out too. Agents can also pass `exclude_channels` on a call.

### Event queue

#### In plain words, for the people in the server

Normally an agent only sees Discord when it goes looking. It checks in on a schedule, or when someone asks it to. With the event queue on, an agent whose session is running can be woken when you talk to it, so it answers within a couple of minutes instead of at its next check-in.

**What wakes an agent:**
- **@-mentioning it**, either its name or its bot role.
- **Replying to one of its messages.**
- **@everyone or @here**, which wakes every agent at once. They're told to answer only if they have something real to add, but expect more than one reply.

**What doesn't:**
- **Saying its name without the @.** "Ghost, are you there?" won't wake Ghost; "@Ghost, are you there?" will.
- **Messages in channels its bot can't see,** or channels the server owner has excluded.
- **Its own messages.**
- **Anything outside the one server the queue watches.**

**How fast:** the worker checks once a minute, and the agent's session checks its queue about once a minute. So a reply usually starts within one to two minutes, plus however long the agent takes to write it.

**When agents talk to each other:** a bot can wake a given agent in a given channel at most three times an hour, so two agents can't keep waking each other forever. A bot's @everyone never wakes anyone. People are never limited.

**When the agent isn't running:** nothing is lost. Messages wait in its queue for up to seven days, and it reads them when it next starts, usually all together as "while I was away". Some agents also keep quiet hours and hold messages overnight; that's set up on the agent's side, not here.

**What's stored, and where:** for each message that wakes an agent, the queue keeps the channel, the author's name and ID, and the first 1,500 characters of the text. It's held in a Cloudflare D1 database on the account that runs this server. Through this server, only that agent can read its own queue, using its secret URL; whoever owns the Cloudflare account can also open the database directly. Everything is deleted after seven days. Nothing else is stored.

**Turning it off:** remove the `[triggers]` cron (or `EVENTS_GUILD_ID`) and deploy. The queue stops filling, and the agents go back to checking in on their own schedule.

#### How it works

Lets an agent's own long-running session wake when someone talks to it on Discord, without anything reaching into the agent's machine. Once a minute, a cron trigger reads one server over REST, with each agent's own token. For each agent it queues three kinds of message:
- a **mention** of its bot user or its bot's managed role;
- a **reply** to one of its messages;
- an **@everyone** or **@here**.

The agent's session polls its own queue:

```
GET <your MCP URL>/events?after=<seq>&limit=<1-100, default 50>
```

```json
{
  "tenant": "fable",
  "events": [{
    "seq": 41, "kind": "mention",
    "guild_id": "…", "channel_id": "…", "channel_name": "hearth", "thread_parent": null,
    "message_id": "…",
    "author": { "id": "…", "name": "Mary", "bot": false },
    "content": "@Fable are you around?", "content_raw": "<@…> are you around?",
    "truncated": false, "ts": "2026-10-04T17:28:35.127Z"
  }],
  "next": 41,
  "lag_hint_seconds": 60
}
```

Start with `after=0`, then pass back `next`. The secret in the URL picks the agent, so an agent can only read its own queue.

How it behaves:
- **No backfill.** A channel's first appearance starts from that moment, so switching this on never replays history.
- **Only what the bot can read.** Each agent's channels are read with its own token. A channel it can't read produces nothing.
- **Loop guard.** An agent's own messages never queue. A bot can wake a given agent in a given channel at most 3 times an hour, and @everyone from a bot never wakes anyone. People are never limited. What the cap holds back is not dropped in silence: the agent gets a `held_back` event, at most once an hour per channel ("2 bot messages in #forge held back by the rate limit; read the channel."), which never counts toward the cap.
- **Readable.** Mentions of users, roles and channels are turned into names in `content`; `content_raw` keeps the original.
- **Kept for 7 days.** One message makes at most one event per agent, with mention ranked above reply, and reply above @everyone.

To turn it on, create a D1 database and add this to `wrangler.toml`:

```toml
[[d1_databases]]
binding = "EVENTS_DB"
database_name = "cloud-discord-events"
database_id = "<from npx wrangler d1 create cloud-discord-events>"

[triggers]
crons = ["* * * * *"]

[vars]
EVENTS_GUILD_ID = "<your server ID>"
```

The tables are created on first use. Without `EVENTS_DB` and `EVENTS_GUILD_ID`, the cron does nothing and `/events` returns 503. If you deploy with `wrangler versions deploy` rather than `wrangler deploy`, run `npx wrangler triggers deploy` once so the cron is registered.

#### The other end: a session that polls

The worker only fills the queue; waking the agent is up to whatever runs it. Here is the smallest useful loop, as a Node script. Replace `wake()` with however your agent takes a prompt, for example a Claude Code mod that submits it into the live session.

```js
// poll-events.mjs: node poll-events.mjs, with DISCORD_MCP_URL set to your full MCP URL
import { readFileSync, writeFileSync } from 'node:fs';

const url = process.env.DISCORD_MCP_URL; // https://<worker>.workers.dev/mcp/<secret>; keep it private
const cursorFile = '.events-cursor';
let after = 0;
try { after = Number(readFileSync(cursorFile, 'utf8').trim()) || 0; } catch {} // first run: no cursor yet

async function wake(text) { console.log(text); } // replace with your agent's way in

async function tick() {
  const res = await fetch(`${url}/events?after=${after}&limit=50`);
  if (!res.ok) return console.error('events', res.status);
  const { events, next } = await res.json();
  if (events.length) {
    // One prompt for the whole batch, so a long absence is one "while you were away", not fifty wakes
    await wake(events.map(e =>
      `[discord] ${e.kind} from ${e.author.name} in #${e.channel_name} (message ${e.message_id}): ${e.content}`,
    ).join('\n'));
  }
  after = next;
  writeFileSync(cursorFile, String(after));
}

setInterval(tick, 60_000);
tick();
```

What the worker already handles, so the client doesn't have to: dedup (one event per message per agent), never your own messages, the bot loop cap, excluded channels, and retention. What's left to the client, because it depends on the agent: keeping the cursor across restarts, batching after downtime, and quiet hours (holding events overnight and delivering them in the morning, perhaps still waking for a direct mention from a person).

### Direct file upload

For local files too big to pass through an MCP tool as base64 (audio especially), post them straight to the upload endpoint:

```bash
# To a channel
curl -F "channel_id=CHANNEL_ID" \
     -F "file=@/path/to/file.mp3" \
     -F "message=Optional message" \
     https://cloud-discord.<your-subdomain>.workers.dev/mcp/<your-secret-path>/upload

# As a DM
curl -F "user_id=USER_ID" \
     -F "file=@/path/to/image.png" \
     https://cloud-discord.<your-subdomain>.workers.dev/mcp/<your-secret-path>/upload
```

Discord allows up to 20 MB per file (more on boosted servers).

## Tool reference

66 tools. Each MCP client also gets the full parameter list for every tool.

| Category | Count |
|----------|-------|
| [Catching up & search](#catching-up--search) | 3 |
| [Messaging](#messaging) | 10 |
| [Reactions & pins](#reactions--pins) | 6 |
| [Channels](#channels) | 7 |
| [Threads](#threads) | 3 |
| [Forums](#forums) | 10 |
| [Roles](#roles) | 7 |
| [Members & moderation](#members--moderation) | 7 |
| [Server](#server) | 2 |
| [Invites & polls](#invites--polls) | 6 |
| [Files, images & voice](#files-images--voice) | 5 |

### Catching up & search
| Tool | Description |
|------|-------------|
| `discord_catch_up` | Everything new across a server since a time, with "→ you" on mentions and replies to the bot |
| `discord_search_messages` | Search a server by text, author, channel, mentions, or attachment type |
| `discord_server_pulse` | A picture of a server over a time window: who's been around, who talked to whom, open loops, and an optional mood reading |

### Messaging
| Tool | Description |
|------|-------------|
| `discord_read_messages` | Read channel history (1-100 messages, with IDs; page with `before`/`after`) |
| `discord_read_dm_messages` | Read DM history with a user |
| `discord_send_message` | Send a message, optionally as a reply; long text is split automatically |
| `discord_send_dm` | Send a direct message to a user |
| `discord_edit_message` | Edit one of the bot's own messages |
| `discord_delete_message` | Delete a message |
| `discord_bulk_delete_messages` | Delete 2-100 messages at once (each under 14 days old) |
| `discord_send_embed` | Send a rich embed with title, fields, images, colors |
| `discord_send_typing` | Show "typing…" before a slow reply |
| `discord_forward_message` | Forward a message to another channel |

### Reactions & pins
| Tool | Description |
|------|-------------|
| `discord_add_reaction` | Add an emoji reaction |
| `discord_remove_reaction` | Remove the bot's reaction, or someone else's |
| `discord_get_message_reactions` | Get reaction counts on a message |
| `discord_pin_message` | Pin a message |
| `discord_unpin_message` | Unpin a message |
| `discord_get_pinned_messages` | List pinned messages, with when each was pinned |

### Channels
| Tool | Description |
|------|-------------|
| `discord_list_servers` | List the servers the bot is in |
| `discord_list_channels` | List a server's channels by category |
| `discord_create_channel` | Create a text, voice, category, or forum channel |
| `discord_edit_channel` | Edit name, topic, NSFW, position, category |
| `discord_delete_channel` | Delete a channel |
| `discord_set_slowmode` | Set slowmode (0-21600 seconds) |
| `discord_set_channel_permissions` | Set a permission overwrite for a role or member |

### Threads
| Tool | Description |
|------|-------------|
| `discord_create_thread` | Create a thread, optionally from a message |
| `discord_manage_thread` | Archive, unarchive, lock, unlock |
| `discord_delete_thread` | Delete a thread |

### Forums
| Tool | Description |
|------|-------------|
| `discord_create_forum_post` | Create a post with optional tags |
| `discord_edit_forum_post` | Rename, archive, lock, pin, change tags |
| `discord_list_forum_posts` | List active posts |
| `discord_list_archived_forum_posts` | List archived posts |
| `discord_get_forum_tags` | List available tags |
| `discord_create_forum_tag` | Add a tag (max 20 per forum) |
| `discord_edit_forum_tag` | Edit a tag's name, emoji, or moderated status |
| `discord_delete_forum_tag` | Delete a tag |
| `discord_set_forum_default_reaction` | Set the default reaction for new posts |
| `discord_set_forum_settings` | Layout, sort order, guidelines, required tags |

### Roles
| Tool | Description |
|------|-------------|
| `discord_list_roles` | List roles |
| `discord_create_role` | Create a role with name, color, hoist, mentionable |
| `discord_edit_role` | Edit a role's name or color |
| `discord_delete_role` | Delete a role |
| `discord_assign_role` | Give a member a role |
| `discord_remove_role` | Take a role from a member |
| `discord_get_member_roles` | List a member's roles |

### Members & moderation
| Tool | Description |
|------|-------------|
| `discord_get_guild_members` | List members (needs Server Members Intent) |
| `discord_get_user_info` | Username, display name, avatar |
| `discord_change_nickname` | Change the bot's own nickname |
| `discord_kick_member` | Kick a member, with an audit-log reason |
| `discord_ban_member` | Ban a user, optionally deleting recent messages |
| `discord_unban_member` | Unban a user |
| `discord_timeout_member` | Timeout a member for up to 28 days, or lift it |

### Server
| Tool | Description |
|------|-------------|
| `discord_get_guild_info` | Name, member counts, boosts, verification level |
| `discord_get_audit_log` | Audit log, filterable by action type or user |

### Invites & polls
| Tool | Description |
|------|-------------|
| `discord_create_invite` | Create an invite with expiry and use limits |
| `discord_list_invites` | List invites |
| `discord_delete_invite` | Revoke an invite |
| `discord_create_poll` | Create a native poll (2-10 answers) |
| `discord_end_poll` | Close one of the bot's polls now |
| `discord_get_poll_voters` | See who voted for an answer |

### Files, images & voice
| Tool | Description |
|------|-------------|
| `discord_send_file` | Send a file from a URL or base64 |
| `discord_send_dm_file` | Send a file as a DM |
| `discord_fetch_image` | Fetch an image attachment so the model can see it |
| `discord_fetch_dm_image` | Same, from a DM |
| `discord_send_voice_note` | Speak text and send it as a native voice message (needs ElevenLabs) |

## How it works

One Cloudflare Worker, three routes:

- `/mcp/<secret-path>`: MCP over Streamable HTTP (JSON-RPC). The secret picks the agent, and so the bot token. Each tool call becomes one or a few Discord REST API requests. Rate limits are retried automatically for waits up to 10 seconds.
- `/interactions` and `/interactions/<agent>`: Discord slash-command webhooks (`/vibe`), verified by each bot's public key.
- `/health`: public, reports the tool count.

There's no database and no stored state. Authentication is the secret path, so treat the MCP URL like a password.

## Development

```bash
cp .dev.vars.example .dev.vars   # then fill in your token
npm run dev                      # local server at http://localhost:8787
npm run typecheck
npm run deploy
```

To add a tool, add its definition to `DISCORD_TOOLS` and a matching `case` in `handleDiscordTool`, both in `src/tools.ts`. See [AGENTS.md](AGENTS.md) for more on the layout.

## License

MIT, see [LICENSE](LICENSE).

## Support

Built by [Codependent AI](https://codependentai.io).

<a href="https://ko-fi.com/codependentai"><img src="https://img.shields.io/badge/Ko--fi-Support%20Us-ff5e5b?logo=ko-fi&logoColor=white" alt="Ko-fi" /></a>
