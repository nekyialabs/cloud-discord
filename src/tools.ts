// Discord MCP Tool definitions and REST API handlers

import { describeOggOpus } from './voice';
import { serverPulse, type AiBinding } from './pulse';
import { bytesToBase64, discordFetch, discordFetchForm, discordFetchMultipart, formatMessage, fetchImageAsBase64, parseSince, snowflakeFromTime, splitMessage, MESSAGE_LIMIT } from './discord';

// One block of a rich message. Which fields apply depends on type; the builder checks them.
const RICH_BLOCK_SCHEMA = {
  type: 'object' as const,
  properties: {
    type: { type: 'string', enum: ['text', 'separator', 'gallery', 'section', 'links'], description: 'text: markdown. separator: a gap, with a line unless divider is false. gallery: 1-10 images. section: text beside a thumbnail or a link button. links: a row of 1-5 link buttons' },
    content: { type: 'string', description: 'text: the markdown text' },
    divider: { type: 'boolean', description: 'separator: draw a line (default true)' },
    spacing: { type: 'string', enum: ['small', 'large'], description: 'separator: size of the gap (default small)' },
    items: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, description: { type: 'string', description: 'Alt text, up to 1024 characters' }, spoiler: { type: 'boolean' } }, required: ['url'] }, description: 'gallery: 1-10 images' },
    text: { type: 'string', description: 'section: the markdown text' },
    thumbnail_url: { type: 'string', description: 'section: small image beside the text (give this or link)' },
    link: { type: 'object', properties: { label: { type: 'string', description: 'Up to 80 characters' }, url: { type: 'string' } }, required: ['label', 'url'], description: 'section: a link button beside the text (give this or thumbnail_url)' },
    buttons: { type: 'array', items: { type: 'object', properties: { label: { type: 'string', description: 'Up to 80 characters' }, url: { type: 'string' } }, required: ['label', 'url'] }, description: 'links: 1-5 link buttons' },
  },
  required: ['type'],
};

// ============ TOOL DEFINITIONS ============

export const DISCORD_TOOLS = [
  // === MESSAGING ===
  {
    name: 'discord_read_messages',
    description: 'Read recent messages from a channel, oldest first. Each line includes the message ID, which you need to reply, react, pin, edit or delete. Use before/after with a message ID to page.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID to read from' },
        limit: { type: 'number', description: 'Number of messages to fetch (1-100)', default: 50 },
        before: { type: 'string', description: 'Only messages before this message ID (page back through history)' },
        after: { type: 'string', description: 'Only messages after this message ID' },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'discord_read_dm_messages',
    description: 'Read recent DM messages with a user, oldest first, with message IDs. Use before/after to page.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        user_id: { type: 'string', description: 'The user ID to read DMs from' },
        limit: { type: 'number', description: 'Number of messages to fetch (1-100)', default: 50 },
        before: { type: 'string', description: 'Only messages before this message ID (page back through history)' },
        after: { type: 'string', description: 'Only messages after this message ID' },
      },
      required: ['user_id'],
    },
  },
  {
    name: 'discord_send_message',
    description: 'Send a message to a channel or thread. Longer than 2000 characters is split at paragraph or line breaks, keeping code blocks intact. Set reply_to to a message ID to reply to it. User mentions (<@id>) ping; @everyone, @here and roles only ping if allow_mass_mentions is true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID to send to' },
        content: { type: 'string', description: 'The message content. Over 2000 characters is split into several messages' },
        reply_to: { type: 'string', description: 'Message ID to reply to (optional)' },
        allow_mass_mentions: { type: 'boolean', description: 'Let @everyone, @here and role mentions ping. Off by default: they show as text but notify nobody', default: false },
      },
      required: ['channel_id', 'content'],
    },
  },
  {
    name: 'discord_send_dm',
    description: 'Send a direct message to a user. Longer than 2000 characters is split into several messages. Fails if the user shares no server with the bot or has DMs closed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        user_id: { type: 'string', description: 'The user ID to DM' },
        content: { type: 'string', description: 'The message content. Over 2000 characters is split into several messages' },
      },
      required: ['user_id', 'content'],
    },
  },
  {
    name: 'discord_edit_message',
    description: 'Edit a message. Only works on messages the bot itself sent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        message_id: { type: 'string', description: 'The message ID to edit' },
        new_content: { type: 'string', description: 'The new message content' },
      },
      required: ['channel_id', 'message_id', 'new_content'],
    },
  },
  {
    name: 'discord_delete_message',
    description: 'Delete a message. Deleting someone else\'s message needs Manage Messages. Cannot be undone.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        message_id: { type: 'string', description: 'The message ID to delete' },
      },
      required: ['channel_id', 'message_id'],
    },
  },
  {
    name: 'discord_bulk_delete_messages',
    description: 'Bulk delete 2-100 messages from one channel. Messages older than 14 days are rejected. Requires Manage Messages. Cannot be undone.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        message_ids: { type: 'array', items: { type: 'string' }, description: 'Array of message IDs to delete (2-100)' },
      },
      required: ['channel_id', 'message_ids'],
    },
  },
  {
    name: 'discord_send_embed',
    description: 'Send a rich embed (title, description, fields, images, color) to a channel. Description max 4096 characters, up to 25 fields.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        title: { type: 'string', description: 'Embed title' },
        description: { type: 'string', description: 'Embed description (supports markdown)' },
        color: { type: 'string', description: 'Hex color (e.g., #FF0000)' },
        fields: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' }, inline: { type: 'boolean' } }, required: ['name', 'value'] }, description: 'Embed fields' },
        footer: { type: 'string', description: 'Footer text' },
        thumbnail_url: { type: 'string', description: 'Thumbnail image URL' },
        image_url: { type: 'string', description: 'Large image URL' },
        url: { type: 'string', description: 'URL the title links to' },
        content: { type: 'string', description: 'Optional text content outside the embed' },
        allow_mass_mentions: { type: 'boolean', description: 'Let @everyone, @here and role mentions ping. Off by default: they show as text but notify nobody', default: false },

      },
      required: ['channel_id'],
    },
  },

  {
    name: 'discord_catch_up',
    description: 'Catch up on a whole server in one call: every channel and active thread with messages since a time, newest channels first, each with its recent messages (oldest first). Messages that mention or reply to the bot are flagged "→ you". Use this when returning after time away instead of reading channels one by one.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild/server ID' },
        since: { type: 'string', description: 'How far back: a relative time like 30m, 2h, 1d, or an ISO time', default: '12h' },
        per_channel: { type: 'number', description: 'Max messages to show per channel (1-50)', default: 15 },
        max_channels: { type: 'number', description: 'Max channels/threads to include (1-25)', default: 10 },
      },
      required: ['guild_id'],
    },
  },
  {
    name: 'discord_server_pulse',
    description: 'A picture of a whole server over a time window instead of its messages: who has been around and where, who replied to or mentioned whom (and who never got a reply back), the busiest channels, open loops (people addressed who have not said anything in that channel since), and things said to the whole room that nobody has answered. Set mood to add a short reading of the mood and what people are working on, written by a Workers AI model and labelled as a reading. Use it to see what the community is doing, find conversations to join, or write a digest; use discord_catch_up when you need the messages themselves.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild/server ID' },
        since: { type: 'string', description: 'How far back: a relative time like 12h, 1d, 7d, or an ISO time', default: '24h' },
        mood: { type: 'boolean', description: 'Add a short mood and what-people-are-working-on reading from a Workers AI model (needs the AI binding)', default: false },
        quiet_hours: { type: 'number', description: 'How long a message said to the room must sit unanswered before it is listed (0-72 hours)', default: 2 },
        exclude_channels: { type: 'array', items: { type: 'string' }, description: 'Channel IDs or names to leave out (their threads too), e.g. private or admin channels. Added to any the deployment already excludes.' },
        per_channel: { type: 'number', description: 'Max messages to read per channel (1-300)', default: 100 },
        max_channels: { type: 'number', description: 'Max channels/threads to include, busiest-recent first (1-50)', default: 25 },
      },
      required: ['guild_id'],
    },
  },
  {
    name: 'discord_send_typing',
    description: 'Show "<bot> is typing…" in a channel for about 10 seconds, or until the bot sends a message there. Use it before a reply that takes a while to write.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel or thread ID' },
      },
      required: ['channel_id'],
    },
  },

  // === REACTIONS ===
  {
    name: 'discord_add_reaction',
    description: 'Add an emoji reaction to a message',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        message_id: { type: 'string', description: 'The message ID' },
        emoji: { type: 'string', description: 'A Unicode emoji (e.g. 👍), or a custom emoji as <:name:id> or name:id' },
      },
      required: ['channel_id', 'message_id', 'emoji'],
    },
  },
  {
    name: 'discord_remove_reaction',
    description: 'Remove a reaction from a message. Omit user_id to remove the bot\'s own reaction.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        message_id: { type: 'string', description: 'The message ID' },
        emoji: { type: 'string', description: 'A Unicode emoji (e.g. 👍), or a custom emoji as <:name:id> or name:id' },
        user_id: { type: 'string', description: 'User ID to remove reaction for (omit for bot\'s own)' },
      },
      required: ['channel_id', 'message_id', 'emoji'],
    },
  },
  {
    name: 'discord_get_message_reactions',
    description: 'Get reaction counts on a message',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        message_id: { type: 'string', description: 'The message ID' },
      },
      required: ['channel_id', 'message_id'],
    },
  },

  // === PINS ===
  {
    name: 'discord_pin_message',
    description: 'Pin a message. Requires the Pin Messages permission',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        message_id: { type: 'string', description: 'The message ID to pin' },
      },
      required: ['channel_id', 'message_id'],
    },
  },
  {
    name: 'discord_unpin_message',
    description: 'Unpin a message. Requires the Pin Messages permission',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        message_id: { type: 'string', description: 'The message ID to unpin' },
      },
      required: ['channel_id', 'message_id'],
    },
  },
  {
    name: 'discord_get_pinned_messages',
    description: 'List pinned messages in a channel, most recently pinned first, with when each was pinned',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        limit: { type: 'number', description: 'How many pins (1-50)', default: 50 },
        before: { type: 'string', description: 'Only pins pinned before this ISO time (use the last pinned_at shown to page)' },
      },
      required: ['channel_id'],
    },
  },

  // === CHANNELS ===
  {
    name: 'discord_list_channels',
    description: 'List a server\'s channels grouped by category, with channel IDs. Start here to find a channel_id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild/server ID' },
      },
      required: ['guild_id'],
    },
  },
  {
    name: 'discord_list_servers',
    description: 'List the servers the bot is in, with guild IDs. Start here to find a guild_id.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'discord_create_channel',
    description: 'Create a new channel in a guild',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        name: { type: 'string', description: 'Channel name' },
        type: { type: 'string', description: 'Channel type: text, voice, category, forum', default: 'text' },
        category_id: { type: 'string', description: 'Parent category ID (optional)' },
        topic: { type: 'string', description: 'Channel topic (optional)' },
      },
      required: ['guild_id', 'name'],
    },
  },
  {
    name: 'discord_edit_channel',
    description: 'Edit channel properties (name, topic, NSFW, etc.)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        name: { type: 'string', description: 'New channel name' },
        topic: { type: 'string', description: 'New channel topic' },
        nsfw: { type: 'boolean', description: 'Set NSFW flag' },
        position: { type: 'number', description: 'Channel position' },
        parent_id: { type: 'string', description: 'Move to category (category ID or null to remove)' },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'discord_delete_channel',
    description: 'Delete a channel and all its messages. Cannot be undone.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID to delete' },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'discord_set_slowmode',
    description: 'Set slowmode rate limit for a channel (0 to disable)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        seconds: { type: 'number', description: 'Slowmode delay in seconds (0-21600). 0 = disabled.' },
      },
      required: ['channel_id', 'seconds'],
    },
  },
  {
    name: 'discord_set_channel_permissions',
    description: 'Set a permission overwrite for a role or member on a channel. allow/deny are permission bitfields as decimal strings, e.g. VIEW_CHANNEL=1024, SEND_MESSAGES=2048, READ_MESSAGE_HISTORY=65536; add values to combine. Replaces any existing overwrite for that role or member.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        overwrite_id: { type: 'string', description: 'The role or user ID' },
        type: { type: 'number', description: '0 = role, 1 = member' },
        allow: { type: 'string', description: 'Bitwise permission flags to allow (as string)' },
        deny: { type: 'string', description: 'Bitwise permission flags to deny (as string)' },
      },
      required: ['channel_id', 'overwrite_id', 'type'],
    },
  },

  // === THREADS ===
  {
    name: 'discord_create_thread',
    description: 'Create a thread in a channel',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        name: { type: 'string', description: 'Thread name' },
        message_id: { type: 'string', description: 'Message ID to create thread from (optional)' },
        auto_archive_duration: { type: 'number', description: 'Auto-archive after minutes: 60, 1440, 4320, 10080', default: 1440 },
      },
      required: ['channel_id', 'name'],
    },
  },
  {
    name: 'discord_manage_thread',
    description: 'Archive/unarchive or lock/unlock a thread',
    inputSchema: {
      type: 'object' as const,
      properties: {
        thread_id: { type: 'string', description: 'The thread ID' },
        archived: { type: 'boolean', description: 'Set archived state' },
        locked: { type: 'boolean', description: 'Set locked state' },
      },
      required: ['thread_id'],
    },
  },
  {
    name: 'discord_delete_thread',
    description: 'Delete a thread and its messages. Cannot be undone.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        thread_id: { type: 'string', description: 'The thread ID to delete' },
      },
      required: ['thread_id'],
    },
  },

  // === FORUM ===
  {
    name: 'discord_create_forum_post',
    description: 'Create a post (a thread with a first message) in a forum channel. Use discord_get_forum_tags for tag IDs; some forums require a tag.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The forum channel ID' },
        name: { type: 'string', description: 'Post title' },
        content: { type: 'string', description: 'Initial message content' },
        applied_tags: { type: 'array', items: { type: 'string' }, description: 'Array of tag IDs to apply' },
      },
      required: ['channel_id', 'name', 'content'],
    },
  },
  {
    name: 'discord_edit_forum_post',
    description: 'Edit a forum post (rename, archive, lock, pin, change tags)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        thread_id: { type: 'string', description: 'The forum post/thread ID' },
        name: { type: 'string', description: 'New post title' },
        archived: { type: 'boolean', description: 'Set archived state' },
        locked: { type: 'boolean', description: 'Set locked state' },
        pinned: { type: 'boolean', description: 'Pin/unpin the post in the forum' },
        applied_tags: { type: 'array', items: { type: 'string' }, description: 'Replace tags (array of tag IDs)' },
        auto_archive_duration: { type: 'number', description: 'Auto-archive minutes: 60, 1440, 4320, 10080' },
      },
      required: ['thread_id'],
    },
  },
  {
    name: 'discord_list_forum_posts',
    description: 'List active threads/posts in a forum channel',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The forum channel ID' },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'discord_list_archived_forum_posts',
    description: 'List archived (closed) threads/posts in a forum channel',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The forum channel ID' },
        limit: { type: 'number', description: 'Max posts to return (1-100)', default: 25 },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'discord_get_forum_tags',
    description: 'Get available tags for a forum channel',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The forum channel ID' },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'discord_create_forum_tag',
    description: 'Add a new tag to a forum channel (max 20 tags)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The forum channel ID' },
        name: { type: 'string', description: 'Tag name' },
        emoji_name: { type: 'string', description: 'Unicode emoji for the tag (optional)' },
        emoji_id: { type: 'string', description: 'Custom emoji ID for the tag (optional)' },
        moderated: { type: 'boolean', description: 'Only moderators can apply this tag', default: false },
      },
      required: ['channel_id', 'name'],
    },
  },
  {
    name: 'discord_edit_forum_tag',
    description: 'Edit an existing tag on a forum channel',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The forum channel ID' },
        tag_id: { type: 'string', description: 'The tag ID to edit' },
        name: { type: 'string', description: 'New tag name' },
        emoji_name: { type: 'string', description: 'New Unicode emoji' },
        emoji_id: { type: 'string', description: 'New custom emoji ID' },
        moderated: { type: 'boolean', description: 'Only moderators can apply' },
      },
      required: ['channel_id', 'tag_id'],
    },
  },
  {
    name: 'discord_delete_forum_tag',
    description: 'Delete a tag from a forum channel. It is removed from every post that had it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The forum channel ID' },
        tag_id: { type: 'string', description: 'The tag ID to delete' },
      },
      required: ['channel_id', 'tag_id'],
    },
  },
  {
    name: 'discord_set_forum_default_reaction',
    description: 'Set the default reaction emoji for new forum posts',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The forum channel ID' },
        emoji_name: { type: 'string', description: 'Unicode emoji (optional)' },
        emoji_id: { type: 'string', description: 'Custom emoji ID (optional, set both to null to clear)' },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'discord_set_forum_settings',
    description: 'Configure forum channel settings (layout, sort order, post guidelines)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The forum channel ID' },
        topic: { type: 'string', description: 'Forum guidelines/topic text' },
        default_sort_order: { type: 'number', description: '0 = latest activity, 1 = creation date' },
        default_forum_layout: { type: 'number', description: '0 = not set, 1 = list view, 2 = gallery view' },
        default_auto_archive_duration: { type: 'number', description: 'Default auto-archive minutes: 60, 1440, 4320, 10080' },
        default_thread_rate_limit: { type: 'number', description: 'Default slowmode for new posts (seconds, 0-21600)' },
        require_tag: { type: 'boolean', description: 'Require a tag when creating posts' },
      },
      required: ['channel_id'],
    },
  },

  // === ROLES ===
  {
    name: 'discord_list_roles',
    description: 'List all roles in a guild',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
      },
      required: ['guild_id'],
    },
  },
  {
    name: 'discord_create_role',
    description: 'Create a new role',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        name: { type: 'string', description: 'Role name' },
        color: { type: 'string', description: 'Role color (hex, e.g., #FF0000)' },
        hoist: { type: 'boolean', description: 'Display separately in member list', default: false },
        mentionable: { type: 'boolean', description: 'Allow mentioning this role', default: false },
      },
      required: ['guild_id', 'name'],
    },
  },
  {
    name: 'discord_edit_role',
    description: 'Edit a role',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        role_id: { type: 'string', description: 'The role ID' },
        name: { type: 'string', description: 'New role name' },
        color: { type: 'string', description: 'New color (hex)' },
      },
      required: ['guild_id', 'role_id'],
    },
  },
  {
    name: 'discord_delete_role',
    description: 'Delete a role from the server. Cannot be undone.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        role_id: { type: 'string', description: 'The role ID to delete' },
      },
      required: ['guild_id', 'role_id'],
    },
  },
  {
    name: 'discord_assign_role',
    description: 'Give a role to a member. The bot\'s highest role must be above the role being assigned.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        user_id: { type: 'string', description: 'The user ID' },
        role_id: { type: 'string', description: 'The role ID to assign' },
      },
      required: ['guild_id', 'user_id', 'role_id'],
    },
  },
  {
    name: 'discord_remove_role',
    description: 'Remove a role from a member. The bot\'s highest role must be above that role.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        user_id: { type: 'string', description: 'The user ID' },
        role_id: { type: 'string', description: 'The role ID to remove' },
      },
      required: ['guild_id', 'user_id', 'role_id'],
    },
  },
  {
    name: 'discord_get_member_roles',
    description: 'Get all roles of a member',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        user_id: { type: 'string', description: 'The user ID' },
      },
      required: ['guild_id', 'user_id'],
    },
  },

  // === MEMBERS & MODERATION ===
  {
    name: 'discord_get_guild_members',
    description: 'List server members with user IDs. Requires the Server Members privileged intent enabled on the bot.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        limit: { type: 'number', description: 'Max members to fetch (1-1000)', default: 100 },
      },
      required: ['guild_id'],
    },
  },
  {
    name: 'discord_change_nickname',
    description: 'Change the bot nickname in a guild',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        nickname: { type: 'string', description: 'New nickname (empty to reset)' },
      },
      required: ['guild_id'],
    },
  },
  {
    name: 'discord_get_user_info',
    description: 'Get a user\'s username, display name, bot flag and avatar URL',
    inputSchema: {
      type: 'object' as const,
      properties: {
        user_id: { type: 'string', description: 'The user ID' },
      },
      required: ['user_id'],
    },
  },
  {
    name: 'discord_kick_member',
    description: 'Kick a member from a server (they can rejoin with an invite). Requires Kick Members. The reason is shown in the audit log.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        user_id: { type: 'string', description: 'The user ID to kick' },
        reason: { type: 'string', description: 'Reason for the kick (shown in audit log)' },
      },
      required: ['guild_id', 'user_id'],
    },
  },
  {
    name: 'discord_ban_member',
    description: 'Ban a user from a server, optionally deleting their recent messages. Requires Ban Members. The reason is shown in the audit log.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        user_id: { type: 'string', description: 'The user ID to ban' },
        reason: { type: 'string', description: 'Reason for the ban (shown in audit log)' },
        delete_message_seconds: { type: 'number', description: 'Delete messages from this user in the last N seconds (0-604800)', default: 0 },
      },
      required: ['guild_id', 'user_id'],
    },
  },
  {
    name: 'discord_unban_member',
    description: 'Unban a user from a guild. Requires BAN_MEMBERS permission.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        user_id: { type: 'string', description: 'The user ID to unban' },
      },
      required: ['guild_id', 'user_id'],
    },
  },
  {
    name: 'discord_timeout_member',
    description: 'Timeout (mute) a member for up to 28 days, or set duration_seconds to 0 to lift a timeout. Requires Moderate Members.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        user_id: { type: 'string', description: 'The user ID' },
        duration_seconds: { type: 'number', description: 'Timeout duration in seconds (0 to remove, max 2419200 = 28 days)' },
        reason: { type: 'string', description: 'Reason for the timeout' },
      },
      required: ['guild_id', 'user_id', 'duration_seconds'],
    },
  },

  // === SERVER / GUILD ===
  {
    name: 'discord_get_guild_info',
    description: 'Get detailed information about a guild/server',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
      },
      required: ['guild_id'],
    },
  },
  {
    name: 'discord_get_audit_log',
    description: 'Read the server audit log, newest first. Requires View Audit Log. Common action_type values: 20 kick, 22 ban, 25 member role update, 72 message delete.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        action_type: { type: 'number', description: 'Filter by action type (optional)' },
        user_id: { type: 'string', description: 'Filter by user who performed action (optional)' },
        limit: { type: 'number', description: 'Number of entries (1-100)', default: 25 },
      },
      required: ['guild_id'],
    },
  },

  // === INVITES ===
  {
    name: 'discord_create_invite',
    description: 'Create an invite for a channel',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        max_age: { type: 'number', description: 'Invite duration in seconds (0 = never expires)', default: 86400 },
        max_uses: { type: 'number', description: 'Max number of uses (0 = unlimited)', default: 0 },
        unique: { type: 'boolean', description: 'Create a unique invite (won\'t reuse existing)', default: false },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'discord_list_invites',
    description: 'List all invites for a guild',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
      },
      required: ['guild_id'],
    },
  },
  {
    name: 'discord_delete_invite',
    description: 'Revoke an invite by its code (the part after discord.gg/)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        invite_code: { type: 'string', description: 'The invite code (not the full URL)' },
      },
      required: ['invite_code'],
    },
  },

  // === IMAGES ===
  {
    name: 'discord_fetch_image',
    description: 'Fetch an image from a message attachment and return it as viewable image content',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        message_id: { type: 'string', description: 'The message ID with the image' },
        attachment_index: { type: 'number', description: 'Which attachment (0-indexed)', default: 0 },
      },
      required: ['channel_id', 'message_id'],
    },
  },
  {
    name: 'discord_fetch_dm_image',
    description: 'Fetch an image from a DM message and return it as viewable image content',
    inputSchema: {
      type: 'object' as const,
      properties: {
        user_id: { type: 'string', description: 'The user ID' },
        message_id: { type: 'string', description: 'The message ID with the image' },
        attachment_index: { type: 'number', description: 'Which attachment (0-indexed)', default: 0 },
      },
      required: ['user_id', 'message_id'],
    },
  },

  // === FILES ===
  {
    name: 'discord_send_file',
    description: 'Send a file/image/audio attachment to a channel. Provide EITHER file_url (preferred) OR file_base64.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        file_url: { type: 'string', description: 'Public URL of the file to fetch and send (preferred). Discord allows up to 20 MB per file (more on boosted servers).' },
        file_base64: { type: 'string', description: 'File content as base64 (fallback for small files)' },
        file_name: { type: 'string', description: 'File name with extension (e.g., audio.mp3, image.png)' },
        content_type: { type: 'string', description: 'MIME type when using base64 (e.g., audio/mpeg)', default: 'application/octet-stream' },
        message: { type: 'string', description: 'Optional message to send with the file' },
      },
      required: ['channel_id', 'file_name'],
    },
  },
  {
    name: 'discord_send_dm_file',
    description: 'Send a file/image/audio attachment as a DM. Provide EITHER file_url (preferred) OR file_base64.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        user_id: { type: 'string', description: 'The user ID to DM' },
        file_url: { type: 'string', description: 'Public URL of the file to fetch and send (preferred). Discord allows up to 20 MB per file (more on boosted servers).' },
        file_base64: { type: 'string', description: 'File content as base64 (fallback for small files)' },
        file_name: { type: 'string', description: 'File name with extension' },
        content_type: { type: 'string', description: 'MIME type when using base64', default: 'application/octet-stream' },
        message: { type: 'string', description: 'Optional message to send with the file' },
      },
      required: ['user_id', 'file_name'],
    },
  },

  // === VOICE ===
  {
    name: 'discord_send_voice_note',
    description: 'Speak text with ElevenLabs and send it as a native Discord voice message (the playable waveform bubble), to a channel or a DM. Provide channel_id OR user_id. Voice messages can\'t carry text, so any message is sent just before it. Falls back to a normal audio attachment if a voice message isn\'t possible (for example without Send Voice Messages permission).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Text to speak' },
        channel_id: { type: 'string', description: 'Channel ID to send to (use this OR user_id)' },
        user_id: { type: 'string', description: 'User ID to DM (use this OR channel_id)' },
        voice_id: { type: 'string', description: 'ElevenLabs voice ID (optional if ELEVENLABS_VOICE_ID is set)' },
        message: { type: 'string', description: 'Optional text message, sent just before the voice note' },
        as_voice_message: { type: 'boolean', description: 'Send as a native voice message (true) or as an mp3 attachment (false)', default: true },
      },
      required: ['text'],
    },
  },

  // === POLLS ===
  {
    name: 'discord_create_poll',
    description: 'Create a native Discord poll with 2-10 answers',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        question: { type: 'string', description: 'The poll question' },
        answers: { type: 'array', items: { type: 'string' }, description: 'Array of answer options (2-10)' },
        duration_hours: { type: 'number', description: 'Poll duration in hours (1-168)', default: 24 },
        allow_multiselect: { type: 'boolean', description: 'Allow multiple selections', default: false },
      },
      required: ['channel_id', 'question', 'answers'],
    },
  },
  {
    name: 'discord_end_poll',
    description: 'Close one of the bot\'s own polls now and return the final results. Only works on polls the bot created.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        message_id: { type: 'string', description: 'The poll message ID' },
      },
      required: ['channel_id', 'message_id'],
    },
  },
  {
    name: 'discord_get_poll_voters',
    description: 'List who voted for one answer of a poll. Answer IDs start at 1 in the order the answers were given.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        message_id: { type: 'string', description: 'The poll message ID' },
        answer_id: { type: 'number', description: 'The answer ID (1 = first answer)' },
        limit: { type: 'number', description: 'Max voters (1-100)', default: 100 },
      },
      required: ['channel_id', 'message_id', 'answer_id'],
    },
  },

  // === SEARCH & FORWARD ===
  {
    name: 'discord_search_messages',
    description: 'Search a server\'s messages by text, author, channel or mentions, newest first by default. Needs Read Message History and the Message Content intent. A server being searched for the first time may need indexing; the tool then says to try again shortly.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild/server ID' },
        content: { type: 'string', description: 'Text to search for' },
        author_id: { type: 'string', description: 'Only messages by this user' },
        channel_id: { type: 'string', description: 'Only messages in this channel' },
        mentions: { type: 'string', description: 'Only messages that mention this user' },
        has: { type: 'string', description: 'Only messages that have: link, embed, file, image, video, sound, sticker, poll' },
        limit: { type: 'number', description: 'Results per page (1-25)', default: 25 },
        offset: { type: 'number', description: 'Skip this many results (for paging)', default: 0 },
        oldest_first: { type: 'boolean', description: 'Sort oldest first instead of newest first', default: false },
      },
      required: ['guild_id'],
    },
  },
  {
    name: 'discord_forward_message',
    description: 'Forward a message to another channel (shows as "Forwarded" with the original inside). The bot must be able to read the original. Polls can\'t be forwarded.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from_channel_id: { type: 'string', description: 'Channel the original message is in' },
        message_id: { type: 'string', description: 'The message to forward' },
        to_channel_id: { type: 'string', description: 'Where to forward it' },
      },
      required: ['from_channel_id', 'message_id', 'to_channel_id'],
    },
  },

  // === RICH MESSAGES ===
  {
    name: 'discord_send_rich_message',
    description: 'Send a Components V2 message built from simple blocks: text (markdown), separators, image galleries, sections (text with a thumbnail or a link button beside it) and rows of link buttons. Sent without content or embeds; a message can\'t be turned back into a plain one afterwards. Limits: 40 components in total (a section is 3, a links row is 1 plus its buttons, the accent_color container is 1) and 4000 characters of text in total. User mentions (<@id>) ping; @everyone, @here and roles only ping if allow_mass_mentions is true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID to send to' },
        blocks: { type: 'array', items: RICH_BLOCK_SCHEMA, description: 'The message, top to bottom' },
        accent_color: { type: 'string', description: 'Hex color (e.g., #B3261E). Wraps everything in one container with a colored bar down its side' },
        reply_to: { type: 'string', description: 'Message ID to reply to (optional)' },
        allow_mass_mentions: { type: 'boolean', description: 'Let @everyone, @here and role mentions ping. Off by default: they show as text but notify nobody', default: false },
      },
      required: ['channel_id', 'blocks'],
    },
  },
  {
    name: 'discord_edit_rich_message',
    description: 'Replace the contents of a Components V2 message the bot sent, using the same blocks as discord_send_rich_message. A plain message can be converted this way, but it can\'t be converted back.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel_id: { type: 'string', description: 'The channel ID' },
        message_id: { type: 'string', description: 'The message ID to edit' },
        blocks: { type: 'array', items: RICH_BLOCK_SCHEMA, description: 'The new message, top to bottom' },
        accent_color: { type: 'string', description: 'Hex color (e.g., #B3261E). Wraps everything in one container with a colored bar down its side' },
      },
      required: ['channel_id', 'message_id', 'blocks'],
    },
  },

  // === PROFILE (the bot itself) ===
  {
    name: 'discord_get_my_profile',
    description: 'Show the bot\'s own profile: username, display name, avatar and banner. With guild_id, also its nickname and server avatar and banner in that server.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'A server to show the bot\'s server profile for (optional)' },
      },
    },
  },
  {
    name: 'discord_set_my_profile',
    description: 'Change the bot\'s own profile in one server: nickname, server avatar, server banner and bio. Only the fields you give change. Images come from a URL or base64 (PNG, JPEG, GIF or WebP, under 10 MB); clear_avatar / clear_banner go back to the global one. Nickname needs Change Nickname. Only ever acts on the bot itself.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        nickname: { type: 'string', description: 'New nickname (empty to reset)' },
        avatar_url: { type: 'string', description: 'Public URL of the new server avatar' },
        avatar_base64: { type: 'string', description: 'New server avatar as base64 (fallback for small images)' },
        banner_url: { type: 'string', description: 'Public URL of the new server banner' },
        banner_base64: { type: 'string', description: 'New server banner as base64 (fallback for small images)' },
        bio: { type: 'string', description: 'New server bio (empty to clear)' },
        clear_avatar: { type: 'boolean', description: 'Remove the server avatar', default: false },
        clear_banner: { type: 'boolean', description: 'Remove the server banner', default: false },
        reason: { type: 'string', description: 'Reason for the change (shown in audit log)' },
      },
      required: ['guild_id'],
    },
  },
  {
    name: 'discord_set_my_global_profile',
    description: 'Change the bot\'s own account-wide profile: username, avatar and banner. This shows in every server the bot is in. Discord heavily rate-limits username changes (only a couple an hour), so don\'t retry in a loop. Images come from a URL or base64 (PNG, JPEG, GIF or WebP, under 10 MB). Only the fields you give change. Only ever acts on the bot itself.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        username: { type: 'string', description: 'New username' },
        avatar_url: { type: 'string', description: 'Public URL of the new avatar' },
        avatar_base64: { type: 'string', description: 'New avatar as base64 (fallback for small images)' },
        banner_url: { type: 'string', description: 'Public URL of the new banner' },
        banner_base64: { type: 'string', description: 'New banner as base64 (fallback for small images)' },
        clear_avatar: { type: 'boolean', description: 'Remove the avatar (back to the default one)', default: false },
        clear_banner: { type: 'boolean', description: 'Remove the banner', default: false },
      },
    },
  },

  // === SCHEDULED EVENTS ===
  {
    name: 'discord_list_events',
    description: 'List a server\'s scheduled events with IDs, times, status and where they happen',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        with_user_count: { type: 'boolean', description: 'Include how many people are interested in each', default: false },
      },
      required: ['guild_id'],
    },
  },
  {
    name: 'discord_create_event',
    description: 'Create a scheduled event (visible to the whole server). With channel_id it happens in that voice or stage channel. Without one it is an external event, which needs both location and end_time. Needs Create Events (a stage channel also needs Manage Channels, Mute Members and Move Members).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        name: { type: 'string', description: 'Event name (1-100 characters)' },
        start_time: { type: 'string', description: 'When it starts, ISO 8601 (e.g. 2026-11-05T19:00:00Z). Must be in the future' },
        end_time: { type: 'string', description: 'When it ends, ISO 8601. Required for external events' },
        description: { type: 'string', description: 'Event description (up to 1000 characters)' },
        channel_id: { type: 'string', description: 'A voice or stage channel to hold it in (leave out for an external event)' },
        location: { type: 'string', description: 'Where an external event happens, e.g. a URL or place (1-100 characters)' },
        image_url: { type: 'string', description: 'Public URL of a cover image' },
        image_base64: { type: 'string', description: 'Cover image as base64 (fallback for small images)' },
      },
      required: ['guild_id', 'name', 'start_time'],
    },
  },
  {
    name: 'discord_edit_event',
    description: 'Edit a scheduled event, or change its status: active starts a scheduled event, completed ends an active one, canceled cancels a scheduled one. Only the fields you give change. Completed and canceled events can\'t be changed again.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        event_id: { type: 'string', description: 'The event ID' },
        name: { type: 'string', description: 'New name (1-100 characters)' },
        start_time: { type: 'string', description: 'New start, ISO 8601' },
        end_time: { type: 'string', description: 'New end, ISO 8601' },
        description: { type: 'string', description: 'New description (up to 1000 characters)' },
        location: { type: 'string', description: 'New location (external events only, 1-100 characters)' },
        status: { type: 'string', description: 'active, completed or canceled' },
      },
      required: ['guild_id', 'event_id'],
    },
  },
  {
    name: 'discord_delete_event',
    description: 'Delete a scheduled event. Cannot be undone. To keep a record, set its status to canceled with discord_edit_event instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        event_id: { type: 'string', description: 'The event ID to delete' },
      },
      required: ['guild_id', 'event_id'],
    },
  },
  {
    name: 'discord_get_event_users',
    description: 'List who is interested in a scheduled event',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        event_id: { type: 'string', description: 'The event ID' },
        limit: { type: 'number', description: 'Max people (1-100)', default: 100 },
      },
      required: ['guild_id', 'event_id'],
    },
  },

  // === EMOJI ===
  {
    name: 'discord_list_emojis',
    description: 'List custom emoji with the ready-to-paste form for messages (<:name:id>, or <a:name:id> for animated). With guild_id, that server\'s emoji; without it, the emoji owned by the bot\'s application, which the bot can use in any server.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID (leave out for the bot\'s own application emoji)' },
      },
    },
  },
  {
    name: 'discord_create_emoji',
    description: 'Add a custom emoji, to a server if guild_id is given (needs Create Expressions) or else to the bot\'s application. The image comes from a URL or base64 (PNG, JPEG, GIF or WebP, up to 256 KiB; 128x128 is ideal).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Emoji name: 2-32 letters, digits or underscores' },
        image_url: { type: 'string', description: 'Public URL of the image' },
        image_base64: { type: 'string', description: 'Image as base64 (fallback for small images)' },
        guild_id: { type: 'string', description: 'The guild ID (leave out to add it to the bot\'s application instead)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'discord_delete_emoji',
    description: 'Delete a custom emoji, from a server if guild_id is given (needs Create Expressions for its own, Manage Expressions for others\') or else from the bot\'s application. Cannot be undone.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        emoji_id: { type: 'string', description: 'The emoji ID' },
        guild_id: { type: 'string', description: 'The guild ID (leave out for an application emoji)' },
      },
      required: ['emoji_id'],
    },
  },

  // === STICKERS ===
  {
    name: 'discord_list_stickers',
    description: 'List a server\'s custom stickers with IDs, tags and format',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
      },
      required: ['guild_id'],
    },
  },
  {
    name: 'discord_create_sticker',
    description: 'Add a custom sticker to a server. Needs Create Expressions. The file comes from file_url (preferred) or file_base64: PNG, APNG, GIF or Lottie JSON, up to 512 KiB, 320x320 pixels and 5 seconds if animated. Lottie only works on verified or partnered servers. Each server has a limited number of sticker slots.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        name: { type: 'string', description: 'Sticker name (2-30 characters)' },
        description: { type: 'string', description: 'Description (empty, or 2-100 characters)' },
        tags: { type: 'string', description: 'Keywords that suggest the sticker, comma separated (up to 200 characters)' },
        file_url: { type: 'string', description: 'Public URL of the sticker file (preferred)' },
        file_base64: { type: 'string', description: 'Sticker file as base64 (fallback for small files)' },
        file_name: { type: 'string', description: 'File name with extension: .png, .gif or .json' },
      },
      required: ['guild_id', 'name', 'description', 'tags', 'file_name'],
    },
  },
  {
    name: 'discord_delete_sticker',
    description: 'Delete a custom sticker from a server. Needs Create Expressions for its own, Manage Expressions for others\'. Cannot be undone.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        guild_id: { type: 'string', description: 'The guild ID' },
        sticker_id: { type: 'string', description: 'The sticker ID' },
      },
      required: ['guild_id', 'sticker_id'],
    },
  },
];

// ============ TOOL ANNOTATIONS ============
// Hints MCP clients use to decide what needs confirmation. Read-only tools never change
// anything; destructive tools remove or lock out something that can't simply be re-sent.

const DESTRUCTIVE_TOOLS = new Set([
  'discord_delete_message', 'discord_bulk_delete_messages', 'discord_delete_channel',
  'discord_delete_thread', 'discord_delete_forum_tag', 'discord_delete_role',
  'discord_remove_role', 'discord_kick_member', 'discord_ban_member',
  'discord_timeout_member', 'discord_delete_invite', 'discord_set_channel_permissions',
  'discord_delete_event', 'discord_delete_emoji', 'discord_delete_sticker',
]);

export function toolAnnotations(name: string) {
  const readOnly = /^discord_(read|get|list|fetch)_/.test(name) || name === 'discord_catch_up' || name === 'discord_search_messages' || name === 'discord_server_pulse';
  return {
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && DESTRUCTIVE_TOOLS.has(name),
    openWorldHint: true,
  };
}

// ============ CHANNEL TYPE MAP (Discord API integers) ============

const CHANNEL_TYPES: Record<string, number> = {
  text: 0,
  voice: 2,
  category: 4,
  forum: 15,
};

// Discord's reaction endpoints want custom emoji as name:id, not the <:name:id> chat form
function reactionEmoji(emoji: string): string {
  const custom = emoji.trim().match(/^<a?:(\w+):(\d+)>$/);
  return encodeURIComponent(custom ? `${custom[1]}:${custom[2]}` : emoji.trim());
}

function parseColor(color?: string): number | undefined {
  if (!color) return undefined;
  if (color.startsWith('#')) return parseInt(color.slice(1), 16);
  return parseInt(color, 16);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Resolve file data from either URL or base64
async function resolveFileData(args: Record<string, unknown>): Promise<{ data: Uint8Array; contentType: string }> {
  if (args.file_url) {
    const res = await fetch(args.file_url as string);
    if (!res.ok) throw new Error(`Failed to fetch file from URL: ${res.status}`);
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') || 'application/octet-stream',
    };
  }
  if (args.file_base64) {
    return {
      data: base64ToUint8Array(args.file_base64 as string),
      contentType: (args.content_type as string) || 'application/octet-stream',
    };
  }
  throw new Error('Must provide either file_url or file_base64');
}

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

// Servers and callers often get the content type wrong, so read it from the file's first bytes
function sniffImageType(b: Uint8Array): string | undefined {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return undefined;
}

// Turn `<prefix>_url` or `<prefix>_base64` into a data URI for Discord's image fields.
// Undefined if neither was given.
async function imageDataUri(args: Record<string, unknown>, prefix: string, maxBytes = IMAGE_MAX_BYTES): Promise<string | undefined> {
  const url = args[`${prefix}_url`];
  const b64 = args[`${prefix}_base64`];
  if (!url && !b64) return undefined;
  const { data } = await resolveFileData({
    file_url: url,
    file_base64: typeof b64 === 'string' ? b64.replace(/^data:[^,]*,/, '') : b64,
  });
  const mime = sniffImageType(data);
  if (!mime) throw new Error(`${prefix} must be a PNG, JPEG, GIF or WebP image`);
  if (data.length > maxBytes) throw new Error(`${prefix} is ${Math.ceil(data.length / 1024)} KiB; the limit is ${Math.floor(maxBytes / 1024)} KiB`);
  return `data:${mime};base64,${bytesToBase64(data)}`;
}

// ============ RICH MESSAGES (Components V2) ============

const COMPONENTS_V2 = 1 << 15; // IS_COMPONENTS_V2
const MAX_RICH_COMPONENTS = 40;
const MAX_RICH_TEXT = 4000;

// Turn the simple blocks into real components, checking Discord's limits first so a
// mistake comes back as a clear message instead of a bare 400. Shared by send and edit.
function buildRichComponents(args: Record<string, unknown>): any[] {
  const blocks = args.blocks as any[];
  if (!Array.isArray(blocks) || blocks.length === 0) throw new Error('blocks must be a non-empty array');
  let count = 0;
  let textLength = 0;

  const textDisplay = (where: string, content: unknown) => {
    if (typeof content !== 'string' || !content.trim()) throw new Error(`${where} needs non-empty text`);
    count++;
    textLength += content.length;
    return { type: 10, content };
  };
  const linkButton = (where: string, link: any) => {
    if (!link?.label || !link?.url) throw new Error(`${where} needs a label and a url`);
    if (link.label.length > 80) throw new Error(`${where}: button label is over 80 characters`);
    if (link.url.length > 512) throw new Error(`${where}: button url is over 512 characters`);
    count++;
    return { type: 2, style: 5, label: link.label, url: link.url };
  };

  let components: any[] = blocks.map((block, i) => {
    const where = `Block ${i + 1} (${block?.type})`;
    switch (block?.type) {
      case 'text':
        return textDisplay(where, block.content);
      case 'separator':
        if (block.spacing !== undefined && block.spacing !== 'small' && block.spacing !== 'large') throw new Error(`${where}: spacing must be small or large`);
        count++;
        return { type: 14, divider: block.divider ?? true, spacing: block.spacing === 'large' ? 2 : 1 };
      case 'gallery': {
        if (!Array.isArray(block.items) || block.items.length < 1 || block.items.length > 10) throw new Error(`${where} needs 1-10 items`);
        count++;
        return {
          type: 12,
          items: block.items.map((item: any) => {
            if (!item?.url) throw new Error(`${where}: every item needs a url`);
            if (item.description && item.description.length > 1024) throw new Error(`${where}: an item description is over 1024 characters`);
            const media: any = { media: { url: item.url } };
            if (item.description) media.description = item.description;
            if (item.spoiler) media.spoiler = true;
            return media;
          }),
        };
      }
      case 'section': {
        // Discord requires exactly one accessory beside a section's text
        if (!block.thumbnail_url === !block.link) throw new Error(`${where} needs exactly one of thumbnail_url or link`);
        const section = textDisplay(where, block.text);
        count++; // the section itself
        if (block.thumbnail_url) count++;
        const accessory = block.thumbnail_url ? { type: 11, media: { url: block.thumbnail_url } } : linkButton(`${where} link`, block.link);
        return { type: 9, components: [section], accessory };
      }
      case 'links': {
        if (!Array.isArray(block.buttons) || block.buttons.length < 1 || block.buttons.length > 5) throw new Error(`${where} needs 1-5 buttons`);
        count++; // the action row
        return { type: 1, components: block.buttons.map((b: any) => linkButton(`${where} button`, b)) };
      }
      default:
        throw new Error(`${where}: unknown block type. Use text, separator, gallery, section or links`);
    }
  });

  if (args.accent_color) {
    if (!/^#?[0-9a-f]{6}$/i.test(args.accent_color as string)) throw new Error('accent_color must be a hex color like #B3261E');
    count++;
    components = [{ type: 17, accent_color: parseColor(args.accent_color as string), components }];
  }

  if (count > MAX_RICH_COMPONENTS) throw new Error(`Too many components: these blocks make ${count}, and a message holds ${MAX_RICH_COMPONENTS} (a section counts 3, a links row 1 plus its buttons)`);
  if (textLength > MAX_RICH_TEXT) throw new Error(`Too much text: ${textLength} characters, and a message holds ${MAX_RICH_TEXT} in total`);
  return components;
}

// ============ PROFILES, EVENTS, EMOJI ============

function cdnImage(path: string, hash: string): string {
  return `https://cdn.discordapp.com/${path}/${hash}.${hash.startsWith('a_') ? 'gif' : 'png'}`;
}

// Emoji exist per application as well as per guild; the application's ID comes from the bot itself
async function botApplicationId(token: string): Promise<string> {
  const res = await discordFetch(token, 'GET', '/applications/@me');
  if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
  return (res.data as any).id;
}

function emojiTag(emoji: any): string {
  return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
}

function isoTime(value: unknown, field: string): string {
  const ms = Date.parse(value as string);
  if (Number.isNaN(ms)) throw new Error(`Can't read ${field} "${value}" as a time. Use ISO 8601, like 2026-11-05T19:00:00Z.`);
  return new Date(ms).toISOString();
}

const EVENT_STATUS: Record<string, number> = { active: 2, completed: 3, canceled: 4 };
const EVENT_STATUS_NAMES: Record<number, string> = { 1: 'scheduled', 2: 'active', 3: 'completed', 4: 'canceled' };
const EVENT_ENTITY_NAMES: Record<number, string> = { 1: 'stage', 2: 'voice', 3: 'external' };
const STICKER_FORMAT_NAMES: Record<number, string> = { 1: 'PNG', 2: 'APNG', 3: 'Lottie', 4: 'GIF' };
const STICKER_MAX_BYTES = 512 * 1024;
const EMOJI_MAX_BYTES = 256 * 1024;

export interface ToolExtras {
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
  ai?: AiBinding;
  pulseModel?: string;
  pulseExcludeChannels?: string;
}

// MCP content blocks a tool can return instead of plain text
export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

function auditReason(args: Record<string, unknown>): Record<string, string> | undefined {
  return args.reason ? { 'X-Audit-Log-Reason': encodeURIComponent(args.reason as string) } : undefined;
}

// Bots ping everything they mention by default. Keep @everyone/@here and role pings off unless asked
function allowedMentions(args: Record<string, unknown>) {
  return args.allow_mass_mentions
    ? { parse: ['users', 'roles', 'everyone'], replied_user: true }
    : { parse: ['users'], replied_user: true };
}

// Send text that may be over the 2000 limit as consecutive messages; only the first is a reply
async function sendText(token: string, channelId: string, content: string, args: Record<string, unknown>): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, piece] of splitMessage(content).entries()) {
    const body: any = { content: piece, allowed_mentions: allowedMentions(args) };
    if (i === 0 && args.reply_to) body.message_reference = { message_id: args.reply_to, fail_if_not_exists: false };
    const res = await discordFetch(token, 'POST', `/channels/${channelId}/messages`, body);
    if (!res.ok) {
      const sent = ids.length ? ` (after sending ${ids.length} part(s): ${ids.join(', ')})` : '';
      throw new Error(`Discord API error${sent}: ${JSON.stringify(res.data)}`);
    }
    ids.push((res.data as any).id);
  }
  return ids;
}

function sentSummary(kind: string, ids: string[]): string {
  return ids.length === 1 ? `${kind} sent (ID: ${ids[0]})` : `${kind} sent in ${ids.length} parts (IDs: ${ids.join(', ')})`;
}

function messageQuery(args: Record<string, unknown>): string {
  const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 100);
  const params = new URLSearchParams({ limit: String(limit) });
  if (args.before) params.set('before', String(args.before));
  if (args.after) params.set('after', String(args.after));
  return params.toString();
}

// Discord audit log action types for readable output
const AUDIT_ACTION_NAMES: Record<number, string> = {
  1: 'GUILD_UPDATE', 10: 'CHANNEL_CREATE', 11: 'CHANNEL_UPDATE', 12: 'CHANNEL_DELETE',
  13: 'CHANNEL_OVERWRITE_CREATE', 14: 'CHANNEL_OVERWRITE_UPDATE', 15: 'CHANNEL_OVERWRITE_DELETE',
  20: 'MEMBER_KICK', 22: 'MEMBER_BAN_ADD', 23: 'MEMBER_BAN_REMOVE', 24: 'MEMBER_UPDATE',
  25: 'MEMBER_ROLE_UPDATE', 26: 'MEMBER_MOVE', 27: 'MEMBER_DISCONNECT',
  30: 'ROLE_CREATE', 31: 'ROLE_UPDATE', 32: 'ROLE_DELETE',
  40: 'INVITE_CREATE', 41: 'INVITE_UPDATE', 42: 'INVITE_DELETE',
  50: 'WEBHOOK_CREATE', 51: 'WEBHOOK_UPDATE', 52: 'WEBHOOK_DELETE',
  72: 'MESSAGE_DELETE', 73: 'MESSAGE_BULK_DELETE', 74: 'MESSAGE_PIN', 75: 'MESSAGE_UNPIN',
  110: 'THREAD_CREATE', 111: 'THREAD_UPDATE', 112: 'THREAD_DELETE',
  140: 'AUTO_MODERATION_RULE_CREATE', 141: 'AUTO_MODERATION_RULE_UPDATE', 142: 'AUTO_MODERATION_RULE_DELETE',
  143: 'AUTO_MODERATION_BLOCK_MESSAGE',
};

// ============ TOOL HANDLER ============

export async function handleDiscordTool(token: string, name: string, args: Record<string, unknown>, extras?: ToolExtras): Promise<string | ToolContent[]> {
  switch (name) {
    // === MESSAGING ===
    case 'discord_read_messages': {
      const res = await discordFetch(token, 'GET', `/channels/${args.channel_id}/messages?${messageQuery(args)}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const msgs = (res.data as any[]).reverse();
      if (msgs.length === 0) return 'No messages found';
      return msgs.map(formatMessage).join('\n\n');
    }

    case 'discord_read_dm_messages': {
      const dmRes = await discordFetch(token, 'POST', '/users/@me/channels', { recipient_id: args.user_id });
      if (!dmRes.ok) throw new Error(`Failed to open DM: ${JSON.stringify(dmRes.data)}`);
      const dmChannelId = (dmRes.data as any).id;
      const res = await discordFetch(token, 'GET', `/channels/${dmChannelId}/messages?${messageQuery(args)}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const msgs = (res.data as any[]).reverse();
      if (msgs.length === 0) return 'No DM messages found';
      return msgs.map(formatMessage).join('\n\n');
    }

    case 'discord_send_message': {
      const ids = await sendText(token, args.channel_id as string, args.content as string, args);
      return sentSummary('Message', ids);
    }

    case 'discord_send_dm': {
      const dmRes = await discordFetch(token, 'POST', '/users/@me/channels', { recipient_id: args.user_id });
      if (!dmRes.ok) throw new Error(`Failed to open DM: ${JSON.stringify(dmRes.data)}`);
      const dmChannelId = (dmRes.data as any).id;
      const ids = await sendText(token, dmChannelId, args.content as string, args);
      return sentSummary('DM', ids);
    }

    case 'discord_edit_message': {
      const res = await discordFetch(token, 'PATCH', `/channels/${args.channel_id}/messages/${args.message_id}`, { content: args.new_content });
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Message ${args.message_id} edited`;
    }

    case 'discord_delete_message': {
      const res = await discordFetch(token, 'DELETE', `/channels/${args.channel_id}/messages/${args.message_id}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Message ${args.message_id} deleted`;
    }

    case 'discord_bulk_delete_messages': {
      const ids = args.message_ids as string[];
      if (ids.length < 2 || ids.length > 100) throw new Error('Must provide 2-100 message IDs');
      const res = await discordFetch(token, 'POST', `/channels/${args.channel_id}/messages/bulk-delete`, { messages: ids });
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Bulk deleted ${ids.length} messages`;
    }

    case 'discord_send_embed': {
      const embed: any = {};
      if (args.title) embed.title = args.title;
      if (args.description) embed.description = args.description;
      if (args.url) embed.url = args.url;
      if (args.footer) embed.footer = { text: args.footer };
      if (args.thumbnail_url) embed.thumbnail = { url: args.thumbnail_url };
      if (args.image_url) embed.image = { url: args.image_url };
      if (args.fields) embed.fields = args.fields;
      const color = parseColor(args.color as string | undefined);
      if (color !== undefined) embed.color = color;
      const body: any = { embeds: [embed], allowed_mentions: allowedMentions(args) };
      if (args.content) body.content = args.content;
      const res = await discordFetch(token, 'POST', `/channels/${args.channel_id}/messages`, body);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Embed sent (ID: ${(res.data as any).id})`;
    }

    case 'discord_catch_up': {
      const sinceMs = parseSince((args.since as string) || '12h');
      const sinceId = BigInt(snowflakeFromTime(sinceMs));
      const perChannel = Math.min(Math.max(Number(args.per_channel) || 15, 1), 50);
      const maxChannels = Math.min(Math.max(Number(args.max_channels) || 10, 1), 25);

      const [chRes, threadRes, meRes] = await Promise.all([
        discordFetch(token, 'GET', `/guilds/${args.guild_id}/channels`),
        discordFetch(token, 'GET', `/guilds/${args.guild_id}/threads/active`),
        discordFetch(token, 'GET', '/users/@me'),
      ]);
      if (!chRes.ok) throw new Error(`Discord API error: ${JSON.stringify(chRes.data)}`);
      const channels = chRes.data as any[];
      const names = new Map(channels.map(c => [c.id, c.name]));
      const threads = threadRes.ok ? ((threadRes.data as any).threads ?? []) : [];
      const botId = meRes.ok ? (meRes.data as any).id : undefined;

      // Text, announcement and voice-chat channels plus active threads; last_message_id says which moved
      const active = [...channels.filter(c => [0, 2, 5].includes(c.type)), ...threads]
        .filter(c => c.last_message_id && BigInt(c.last_message_id) > sinceId)
        .sort((a, b) => (BigInt(b.last_message_id) > BigInt(a.last_message_id) ? 1 : -1));
      if (active.length === 0) return `Nothing new since ${new Date(sinceMs).toISOString()}.`;
      const shown = active.slice(0, maxChannels);

      const sections = await Promise.all(shown.map(async c => {
        const label = c.parent_id && names.has(c.parent_id) && [10, 11, 12].includes(c.type)
          ? `thread "${c.name}" in #${names.get(c.parent_id)}`
          : `#${c.name}`;
        const res = await discordFetch(token, 'GET', `/channels/${c.id}/messages?limit=${perChannel}`);
        if (!res.ok) {
          const code = (res.data as any)?.code;
          return { mentions: 0, text: `## ${label} (${c.id})\n  (can't read: ${code === 50001 ? 'Missing Access' : `error ${res.status}`})` };
        }
        const fresh = (res.data as any[]).filter(m => BigInt(m.id) > sinceId).reverse();
        let mentions = 0;
        const lines = fresh.map(m => {
          const forYou = botId && (m.mentions?.some((u: any) => u.id === botId) || m.referenced_message?.author?.id === botId);
          if (forYou) mentions++;
          return (forYou ? '→ you ' : '') + formatMessage(m);
        });
        const more = fresh.length === perChannel ? ` (showing latest ${perChannel}; there may be more)` : '';
        return { mentions, text: `## ${label} (${c.id}): ${fresh.length} new${more}\n${lines.join('\n')}` };
      }));

      const totalMentions = sections.reduce((n, s) => n + s.mentions, 0);
      const header = [
        `Since ${new Date(sinceMs).toISOString()}: ${active.length} channel(s) with new messages${active.length > shown.length ? `, showing the ${shown.length} most recent` : ''}.`,
        totalMentions ? `${totalMentions} message(s) mention or reply to you, marked "→ you".` : 'Nothing mentions or replies to you.',
      ].join('\n');
      return [header, ...sections.map(s => s.text)].join('\n\n');
    }

    case 'discord_server_pulse': {
      return serverPulse(token, args, { ai: extras?.ai, model: extras?.pulseModel, excludeChannels: extras?.pulseExcludeChannels });
    }

    case 'discord_send_typing': {
      const res = await discordFetch(token, 'POST', `/channels/${args.channel_id}/typing`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Typing in ${args.channel_id}`;
    }

    // === REACTIONS ===
    case 'discord_add_reaction': {
      const emoji = reactionEmoji(args.emoji as string);
      const res = await discordFetch(token, 'PUT', `/channels/${args.channel_id}/messages/${args.message_id}/reactions/${emoji}/@me`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Reacted with ${args.emoji}`;
    }

    case 'discord_remove_reaction': {
      const emoji = reactionEmoji(args.emoji as string);
      const target = args.user_id ? args.user_id : '@me';
      const res = await discordFetch(token, 'DELETE', `/channels/${args.channel_id}/messages/${args.message_id}/reactions/${emoji}/${target}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Removed ${args.emoji} reaction`;
    }

    case 'discord_get_message_reactions': {
      const res = await discordFetch(token, 'GET', `/channels/${args.channel_id}/messages/${args.message_id}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const msg = res.data as any;
      if (!msg.reactions || msg.reactions.length === 0) return 'No reactions on this message';
      return msg.reactions.map((r: any) => `${r.emoji.name}: ${r.count} reaction(s)`).join('\n');
    }

    // === PINS ===
    case 'discord_pin_message': {
      const res = await discordFetch(token, 'PUT', `/channels/${args.channel_id}/messages/pins/${args.message_id}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Message ${args.message_id} pinned`;
    }

    case 'discord_unpin_message': {
      const res = await discordFetch(token, 'DELETE', `/channels/${args.channel_id}/messages/pins/${args.message_id}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Message ${args.message_id} unpinned`;
    }

    case 'discord_get_pinned_messages': {
      const params = new URLSearchParams({ limit: String(Math.min(Math.max(Number(args.limit) || 50, 1), 50)) });
      if (args.before) params.set('before', String(args.before));
      const res = await discordFetch(token, 'GET', `/channels/${args.channel_id}/messages/pins?${params}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const data = res.data as { items: { pinned_at: string; message: any }[]; has_more: boolean };
      if (!data.items?.length) return 'No pinned messages';
      const lines = data.items.map(p => `pinned_at ${p.pinned_at}\n${formatMessage(p.message)}`);
      const more = data.has_more ? `\n\nMore pins exist: pass before="${data.items[data.items.length - 1].pinned_at}" to see older ones.` : '';
      return lines.join('\n\n') + more;
    }

    // === CHANNELS ===
    case 'discord_list_channels': {
      const res = await discordFetch(token, 'GET', `/guilds/${args.guild_id}/channels`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const channels = res.data as any[];

      const categories = channels.filter(ch => ch.type === 4);
      const lines: string[] = [];

      for (const cat of categories) {
        lines.push(`[Category] ${cat.name} (${cat.id})`);
        const children = channels.filter(ch => ch.parent_id === cat.id).sort((a, b) => a.position - b.position);
        for (const ch of children) {
          const typeLabel = ch.type === 2 ? 'voice' : ch.type === 15 ? 'forum' : '#';
          lines.push(`  ${typeLabel} ${ch.name} (${ch.id})`);
        }
      }

      const uncategorized = channels.filter(ch => !ch.parent_id && ch.type !== 4);
      if (uncategorized.length > 0) {
        lines.push('[No category]');
        for (const ch of uncategorized) {
          const typeLabel = ch.type === 2 ? 'voice' : ch.type === 15 ? 'forum' : '#';
          lines.push(`  ${typeLabel} ${ch.name} (${ch.id})`);
        }
      }

      return lines.join('\n');
    }

    case 'discord_list_servers': {
      const res = await discordFetch(token, 'GET', '/users/@me/guilds');
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const guilds = res.data as any[];
      return guilds.map(g => `${g.name} (${g.id})`).join('\n');
    }

    case 'discord_create_channel': {
      const body: any = {
        name: args.name,
        type: CHANNEL_TYPES[(args.type as string) || 'text'] ?? 0,
      };
      if (args.category_id) body.parent_id = args.category_id;
      if (args.topic) body.topic = args.topic;
      const res = await discordFetch(token, 'POST', `/guilds/${args.guild_id}/channels`, body);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const ch = res.data as any;
      return `Channel created: ${ch.name} (ID: ${ch.id})`;
    }

    case 'discord_edit_channel': {
      const body: any = {};
      if (args.name) body.name = args.name;
      if (args.topic !== undefined) body.topic = args.topic;
      if (args.nsfw !== undefined) body.nsfw = args.nsfw;
      if (args.position !== undefined) body.position = args.position;
      if (args.parent_id !== undefined) body.parent_id = args.parent_id || null;
      const res = await discordFetch(token, 'PATCH', `/channels/${args.channel_id}`, body);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Channel ${args.channel_id} updated`;
    }

    case 'discord_delete_channel': {
      const res = await discordFetch(token, 'DELETE', `/channels/${args.channel_id}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Channel ${args.channel_id} deleted`;
    }

    case 'discord_set_slowmode': {
      const seconds = Math.min(Math.max((args.seconds as number) || 0, 0), 21600);
      const res = await discordFetch(token, 'PATCH', `/channels/${args.channel_id}`, { rate_limit_per_user: seconds });
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return seconds === 0 ? `Slowmode disabled on ${args.channel_id}` : `Slowmode set to ${seconds}s on ${args.channel_id}`;
    }

    case 'discord_set_channel_permissions': {
      const body: any = { type: args.type };
      if (args.allow) body.allow = args.allow;
      if (args.deny) body.deny = args.deny;
      const res = await discordFetch(token, 'PUT', `/channels/${args.channel_id}/permissions/${args.overwrite_id}`, body);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Permission overwrite set on channel ${args.channel_id}`;
    }

    // === THREADS ===
    case 'discord_create_thread': {
      const body: any = {
        name: args.name,
        auto_archive_duration: args.auto_archive_duration || 1440,
      };

      let res;
      if (args.message_id) {
        res = await discordFetch(token, 'POST', `/channels/${args.channel_id}/messages/${args.message_id}/threads`, body);
      } else {
        body.type = 11; // PUBLIC_THREAD
        res = await discordFetch(token, 'POST', `/channels/${args.channel_id}/threads`, body);
      }
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const thread = res.data as any;
      return `Thread created: ${thread.name} (ID: ${thread.id})`;
    }

    case 'discord_manage_thread': {
      const body: any = {};
      if (args.archived !== undefined) body.archived = args.archived;
      if (args.locked !== undefined) body.locked = args.locked;
      const res = await discordFetch(token, 'PATCH', `/channels/${args.thread_id}`, body);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Thread ${args.thread_id} updated`;
    }

    case 'discord_delete_thread': {
      const res = await discordFetch(token, 'DELETE', `/channels/${args.thread_id}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Thread ${args.thread_id} deleted`;
    }

    // === FORUM ===
    case 'discord_create_forum_post': {
      const body: any = {
        name: args.name,
        message: { content: args.content, allowed_mentions: allowedMentions(args) },
        auto_archive_duration: 1440,
      };
      if (args.applied_tags) body.applied_tags = args.applied_tags;
      const res = await discordFetch(token, 'POST', `/channels/${args.channel_id}/threads`, body);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const thread = res.data as any;
      return `Forum post created: ${thread.name} (ID: ${thread.id})`;
    }

    case 'discord_edit_forum_post': {
      const body: any = {};
      if (args.name) body.name = args.name;
      if (args.archived !== undefined) body.archived = args.archived;
      if (args.locked !== undefined) body.locked = args.locked;
      if (args.applied_tags) body.applied_tags = args.applied_tags;
      if (args.auto_archive_duration) body.auto_archive_duration = args.auto_archive_duration;
      // Forum pin uses flags — bit 1 (value 2) = PINNED
      if (args.pinned !== undefined) {
        const chRes = await discordFetch(token, 'GET', `/channels/${args.thread_id}`);
        if (!chRes.ok) throw new Error(`Discord API error: ${JSON.stringify(chRes.data)}`);
        const currentFlags = (chRes.data as any).flags || 0;
        body.flags = (args.pinned as boolean) ? (currentFlags | 2) : (currentFlags & ~2);
      }
      const res = await discordFetch(token, 'PATCH', `/channels/${args.thread_id}`, body);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Forum post ${args.thread_id} updated`;
    }

    case 'discord_list_forum_posts': {
      // Get active threads for the guild, then filter by parent channel
      const chRes = await discordFetch(token, 'GET', `/channels/${args.channel_id}`);
      if (!chRes.ok) throw new Error(`Discord API error: ${JSON.stringify(chRes.data)}`);
      const channel = chRes.data as any;
      const guildId = channel.guild_id;

      const res = await discordFetch(token, 'GET', `/guilds/${guildId}/threads/active`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const data = res.data as any;
      const threads = (data.threads || []).filter((t: any) => t.parent_id === args.channel_id);
      if (threads.length === 0) return 'No active forum posts';
      return threads.map((t: any) => {
        const tags = t.applied_tags?.length ? ` [tags: ${t.applied_tags.join(', ')}]` : '';
        const pinned = (t.flags & 2) ? ' [PINNED]' : '';
        return `${t.name} (ID: ${t.id})${pinned}${tags} — ${t.message_count || 0} messages`;
      }).join('\n');
    }

    case 'discord_list_archived_forum_posts': {
      const limit = Math.min((args.limit as number) || 25, 100);
      const res = await discordFetch(token, 'GET', `/channels/${args.channel_id}/threads/archived/public?limit=${limit}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const data = res.data as any;
      const threads = data.threads || [];
      if (threads.length === 0) return 'No archived forum posts';
      return threads.map((t: any) => {
        const tags = t.applied_tags?.length ? ` [tags: ${t.applied_tags.join(', ')}]` : '';
        const locked = t.thread_metadata?.locked ? ' [LOCKED]' : '';
        return `${t.name} (ID: ${t.id})${locked}${tags} — ${t.message_count || 0} messages`;
      }).join('\n');
    }

    case 'discord_get_forum_tags': {
      const res = await discordFetch(token, 'GET', `/channels/${args.channel_id}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const ch = res.data as any;
      const tags = ch.available_tags || [];
      if (tags.length === 0) return 'No tags configured on this forum';
      return tags.map((t: any) => {
        const emoji = t.emoji_name || (t.emoji_id ? `<:tag:${t.emoji_id}>` : '');
        const mod = t.moderated ? ' [mod-only]' : '';
        return `${emoji ? emoji + ' ' : ''}${t.name} (ID: ${t.id})${mod}`;
      }).join('\n');
    }

    case 'discord_create_forum_tag': {
      // Get current tags, append new one, update channel
      const chRes = await discordFetch(token, 'GET', `/channels/${args.channel_id}`);
      if (!chRes.ok) throw new Error(`Discord API error: ${JSON.stringify(chRes.data)}`);
      const ch = chRes.data as any;
      const tags = ch.available_tags || [];
      if (tags.length >= 20) throw new Error('Forum already has maximum 20 tags');
      const newTag: any = { name: args.name, moderated: args.moderated ?? false };
      if (args.emoji_name) newTag.emoji_name = args.emoji_name;
      if (args.emoji_id) newTag.emoji_id = args.emoji_id;
      tags.push(newTag);
      const res = await discordFetch(token, 'PATCH', `/channels/${args.channel_id}`, { available_tags: tags });
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      // Find the created tag (it'll have an ID now)
      const updated = res.data as any;
      const created = (updated.available_tags || []).find((t: any) => t.name === args.name);
      return `Tag created: ${args.name}${created?.id ? ` (ID: ${created.id})` : ''}`;
    }

    case 'discord_edit_forum_tag': {
      const chRes = await discordFetch(token, 'GET', `/channels/${args.channel_id}`);
      if (!chRes.ok) throw new Error(`Discord API error: ${JSON.stringify(chRes.data)}`);
      const ch = chRes.data as any;
      const tags = (ch.available_tags || []).map((t: any) => {
        if (t.id !== args.tag_id) return t;
        const updated = { ...t };
        if (args.name) updated.name = args.name;
        if (args.emoji_name !== undefined) updated.emoji_name = args.emoji_name || null;
        if (args.emoji_id !== undefined) updated.emoji_id = args.emoji_id || null;
        if (args.moderated !== undefined) updated.moderated = args.moderated;
        return updated;
      });
      const res = await discordFetch(token, 'PATCH', `/channels/${args.channel_id}`, { available_tags: tags });
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Tag ${args.tag_id} updated`;
    }

    case 'discord_delete_forum_tag': {
      const chRes = await discordFetch(token, 'GET', `/channels/${args.channel_id}`);
      if (!chRes.ok) throw new Error(`Discord API error: ${JSON.stringify(chRes.data)}`);
      const ch = chRes.data as any;
      const tags = (ch.available_tags || []).filter((t: any) => t.id !== args.tag_id);
      const res = await discordFetch(token, 'PATCH', `/channels/${args.channel_id}`, { available_tags: tags });
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Tag ${args.tag_id} deleted`;
    }

    case 'discord_set_forum_default_reaction': {
      const reaction: any = {};
      if (args.emoji_name) reaction.emoji_name = args.emoji_name;
      else reaction.emoji_name = null;
      if (args.emoji_id) reaction.emoji_id = args.emoji_id;
      else reaction.emoji_id = null;
      const res = await discordFetch(token, 'PATCH', `/channels/${args.channel_id}`, { default_reaction_emoji: reaction });
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Default forum reaction updated`;
    }

    case 'discord_set_forum_settings': {
      const body: any = {};
      if (args.topic !== undefined) body.topic = args.topic;
      if (args.default_sort_order !== undefined) body.default_sort_order = args.default_sort_order;
      if (args.default_forum_layout !== undefined) body.default_forum_layout = args.default_forum_layout;
      if (args.default_auto_archive_duration !== undefined) body.default_auto_archive_duration = args.default_auto_archive_duration;
      if (args.default_thread_rate_limit !== undefined) body.default_thread_rate_limit_per_user = args.default_thread_rate_limit;
      if (args.require_tag !== undefined) {
        // Bit 4 (value 16) = REQUIRE_TAG
        const chRes = await discordFetch(token, 'GET', `/channels/${args.channel_id}`);
        if (!chRes.ok) throw new Error(`Discord API error: ${JSON.stringify(chRes.data)}`);
        const currentFlags = (chRes.data as any).flags || 0;
        body.flags = (args.require_tag as boolean) ? (currentFlags | 16) : (currentFlags & ~16);
      }
      const res = await discordFetch(token, 'PATCH', `/channels/${args.channel_id}`, body);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Forum settings updated for ${args.channel_id}`;
    }

    // === ROLES ===
    case 'discord_list_roles': {
      const res = await discordFetch(token, 'GET', `/guilds/${args.guild_id}/roles`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const roles = res.data as any[];
      return roles.map(r => `@${r.name} [#${r.color.toString(16).padStart(6, '0')}] - ID: ${r.id}`).join('\n');
    }

    case 'discord_create_role': {
      const body: any = {
        name: args.name,
        hoist: args.hoist ?? false,
        mentionable: args.mentionable ?? false,
      };
      const color = parseColor(args.color as string | undefined);
      if (color !== undefined) body.color = color;
      const res = await discordFetch(token, 'POST', `/guilds/${args.guild_id}/roles`, body);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const role = res.data as any;
      return `Role created: @${role.name} (ID: ${role.id})`;
    }

    case 'discord_edit_role': {
      const body: any = {};
      if (args.name) body.name = args.name;
      const color = parseColor(args.color as string | undefined);
      if (color !== undefined) body.color = color;
      const res = await discordFetch(token, 'PATCH', `/guilds/${args.guild_id}/roles/${args.role_id}`, body);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Role ${args.role_id} updated`;
    }

    case 'discord_delete_role': {
      const res = await discordFetch(token, 'DELETE', `/guilds/${args.guild_id}/roles/${args.role_id}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Role ${args.role_id} deleted`;
    }

    case 'discord_assign_role': {
      const res = await discordFetch(token, 'PUT', `/guilds/${args.guild_id}/members/${args.user_id}/roles/${args.role_id}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Role ${args.role_id} assigned to user ${args.user_id}`;
    }

    case 'discord_remove_role': {
      const res = await discordFetch(token, 'DELETE', `/guilds/${args.guild_id}/members/${args.user_id}/roles/${args.role_id}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Role ${args.role_id} removed from user ${args.user_id}`;
    }

    case 'discord_get_member_roles': {
      const res = await discordFetch(token, 'GET', `/guilds/${args.guild_id}/members/${args.user_id}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const member = res.data as any;
      const rolesRes = await discordFetch(token, 'GET', `/guilds/${args.guild_id}/roles`);
      const allRoles = rolesRes.ok ? (rolesRes.data as any[]) : [];
      const roleMap = new Map(allRoles.map(r => [r.id, r.name]));
      const memberRoles = (member.roles as string[]).map(id => `@${roleMap.get(id) || id} (${id})`);
      return `Roles for ${member.user?.username || args.user_id}:\n${memberRoles.join('\n')}`;
    }

    // === MEMBERS & MODERATION ===
    case 'discord_get_guild_members': {
      const limit = Math.min((args.limit as number) || 100, 1000);
      const res = await discordFetch(token, 'GET', `/guilds/${args.guild_id}/members?limit=${limit}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const members = res.data as any[];
      return members.map(m => {
        const nick = m.nick ? ` (${m.nick})` : '';
        const roles = (m.roles as string[]).length;
        return `${m.user.username}${nick} - ${roles} roles - ID: ${m.user.id}`;
      }).join('\n');
    }

    case 'discord_change_nickname': {
      const botRes = await discordFetch(token, 'GET', '/users/@me');
      if (!botRes.ok) throw new Error(`Failed to get bot user`);
      const botId = (botRes.data as any).id;
      const res = await discordFetch(token, 'PATCH', `/guilds/${args.guild_id}/members/${botId}`, {
        nick: (args.nickname as string) || null,
      });
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return args.nickname ? `Nickname changed to: ${args.nickname}` : 'Nickname reset';
    }

    case 'discord_get_user_info': {
      const res = await discordFetch(token, 'GET', `/users/${args.user_id}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const user = res.data as any;
      const avatar = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : 'none (default avatar)';
      const display = user.global_name ? `\nDisplay name: ${user.global_name}` : '';
      return `Username: ${user.username}${display}\nID: ${user.id}\nBot: ${user.bot || false}\nAvatar: ${avatar}`;
    }

    case 'discord_kick_member': {
      const res = await discordFetch(token, 'DELETE', `/guilds/${args.guild_id}/members/${args.user_id}`, undefined, auditReason(args));
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `User ${args.user_id} kicked from guild${args.reason ? ` (reason: ${args.reason})` : ''}`;
    }

    case 'discord_ban_member': {
      const body: any = {};
      if (args.delete_message_seconds) body.delete_message_seconds = Math.min(args.delete_message_seconds as number, 604800);
      const res = await discordFetch(token, 'PUT', `/guilds/${args.guild_id}/bans/${args.user_id}`, body, auditReason(args));
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `User ${args.user_id} banned from guild${args.reason ? ` (reason: ${args.reason})` : ''}`;
    }

    case 'discord_unban_member': {
      const res = await discordFetch(token, 'DELETE', `/guilds/${args.guild_id}/bans/${args.user_id}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `User ${args.user_id} unbanned`;
    }

    case 'discord_timeout_member': {
      const duration = args.duration_seconds as number;
      let communicationDisabledUntil: string | null = null;
      if (duration > 0) {
        const until = new Date(Date.now() + Math.min(duration, 2419200) * 1000);
        communicationDisabledUntil = until.toISOString();
      }
      const res = await discordFetch(token, 'PATCH', `/guilds/${args.guild_id}/members/${args.user_id}`, {
        communication_disabled_until: communicationDisabledUntil,
      }, auditReason(args));
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return duration > 0
        ? `User ${args.user_id} timed out for ${duration}s`
        : `Timeout removed for user ${args.user_id}`;
    }

    // === SERVER / GUILD ===
    case 'discord_get_guild_info': {
      const res = await discordFetch(token, 'GET', `/guilds/${args.guild_id}?with_counts=true`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const g = res.data as any;
      const lines = [
        `Name: ${g.name}`,
        `ID: ${g.id}`,
        `Owner ID: ${g.owner_id}`,
        `Members: ~${g.approximate_member_count || 'unknown'}`,
        `Online: ~${g.approximate_presence_count || 'unknown'}`,
        `Boost Tier: ${g.premium_tier}`,
        `Boosts: ${g.premium_subscription_count || 0}`,
        `Verification Level: ${g.verification_level}`,
        `NSFW Level: ${g.nsfw_level}`,
        `Created: ${g.id ? new Date(Number(BigInt(g.id) >> 22n) + 1420070400000).toISOString() : 'unknown'}`,
      ];
      if (g.description) lines.push(`Description: ${g.description}`);
      if (g.vanity_url_code) lines.push(`Vanity URL: discord.gg/${g.vanity_url_code}`);
      return lines.join('\n');
    }

    case 'discord_get_audit_log': {
      let path = `/guilds/${args.guild_id}/audit-logs?limit=${Math.min((args.limit as number) || 25, 100)}`;
      if (args.action_type !== undefined) path += `&action_type=${args.action_type}`;
      if (args.user_id) path += `&user_id=${args.user_id}`;
      const res = await discordFetch(token, 'GET', path);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const log = res.data as any;
      const users = new Map((log.users || []).map((u: any) => [u.id, u.username]));
      const entries = (log.audit_log_entries || []).map((e: any) => {
        const who = users.get(e.user_id) || e.user_id;
        const action = AUDIT_ACTION_NAMES[e.action_type] || `ACTION_${e.action_type}`;
        const reason = e.reason ? ` — "${e.reason}"` : '';
        const target = e.target_id ? ` on ${e.target_id}` : '';
        return `[${e.id}] ${who}: ${action}${target}${reason}`;
      });
      return entries.length > 0 ? entries.join('\n') : 'No audit log entries found';
    }

    // === INVITES ===
    case 'discord_create_invite': {
      const body: any = {
        max_age: (args.max_age as number) ?? 86400,
        max_uses: (args.max_uses as number) ?? 0,
        unique: args.unique ?? false,
      };
      const res = await discordFetch(token, 'POST', `/channels/${args.channel_id}/invites`, body);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const inv = res.data as any;
      return `Invite created: https://discord.gg/${inv.code} (max uses: ${inv.max_uses || 'unlimited'}, expires: ${inv.max_age ? inv.max_age + 's' : 'never'})`;
    }

    case 'discord_list_invites': {
      const res = await discordFetch(token, 'GET', `/guilds/${args.guild_id}/invites`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const invites = res.data as any[];
      if (invites.length === 0) return 'No active invites';
      return invites.map(i => {
        const uses = `${i.uses}/${i.max_uses || 'inf'}`;
        const channel = i.channel?.name || i.channel_id;
        const creator = i.inviter?.username || 'unknown';
        return `discord.gg/${i.code} — #${channel} by ${creator} (${uses} uses)`;
      }).join('\n');
    }

    case 'discord_delete_invite': {
      const res = await discordFetch(token, 'DELETE', `/invites/${args.invite_code}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Invite ${args.invite_code} deleted`;
    }

    // === IMAGES ===
    case 'discord_fetch_image': {
      const res = await discordFetch(token, 'GET', `/channels/${args.channel_id}/messages/${args.message_id}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const msg = res.data as any;
      const attachments = msg.attachments || [];
      const idx = (args.attachment_index as number) || 0;
      if (attachments.length === 0) throw new Error('No attachments on this message');
      if (idx >= attachments.length) throw new Error(`Attachment index ${idx} out of range`);
      const attachment = attachments[idx];
      if (!attachment.content_type?.startsWith('image/')) throw new Error('Attachment is not an image');
      const image = await fetchImageAsBase64(attachment.url);
      return [
        { type: 'image', data: image.data, mimeType: image.mimeType },
        { type: 'text', text: `${attachment.filename} (${image.mimeType})` },
      ];
    }

    case 'discord_fetch_dm_image': {
      const dmRes = await discordFetch(token, 'POST', '/users/@me/channels', { recipient_id: args.user_id });
      if (!dmRes.ok) throw new Error(`Failed to open DM: ${JSON.stringify(dmRes.data)}`);
      const dmChannelId = (dmRes.data as any).id;
      const res = await discordFetch(token, 'GET', `/channels/${dmChannelId}/messages/${args.message_id}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const msg = res.data as any;
      const attachments = msg.attachments || [];
      const idx = (args.attachment_index as number) || 0;
      if (attachments.length === 0) throw new Error('No attachments on this message');
      if (idx >= attachments.length) throw new Error(`Attachment index ${idx} out of range`);
      const attachment = attachments[idx];
      if (!attachment.content_type?.startsWith('image/')) throw new Error('Attachment is not an image');
      const image = await fetchImageAsBase64(attachment.url);
      return [
        { type: 'image', data: image.data, mimeType: image.mimeType },
        { type: 'text', text: `${attachment.filename} (${image.mimeType})` },
      ];
    }

    // === FILES ===
    case 'discord_send_file': {
      const { data: fileData, contentType } = await resolveFileData(args);
      const fileName = args.file_name as string;
      const payload: any = { attachments: [{ id: 0, filename: fileName }], allowed_mentions: allowedMentions(args) };
      if (args.message) payload.content = args.message;
      const res = await discordFetchMultipart(token, 'POST', `/channels/${args.channel_id}/messages`, payload, fileData, fileName, contentType);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `File sent: ${fileName} (message ID: ${(res.data as any).id})`;
    }

    case 'discord_send_dm_file': {
      const dmRes = await discordFetch(token, 'POST', '/users/@me/channels', { recipient_id: args.user_id });
      if (!dmRes.ok) throw new Error(`Failed to open DM: ${JSON.stringify(dmRes.data)}`);
      const dmChannelId = (dmRes.data as any).id;
      const { data: fileData, contentType } = await resolveFileData(args);
      const fileName = args.file_name as string;
      const payload: any = { attachments: [{ id: 0, filename: fileName }] };
      if (args.message) payload.content = args.message;
      const res = await discordFetchMultipart(token, 'POST', `/channels/${dmChannelId}/messages`, payload, fileData, fileName, contentType);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `DM file sent: ${fileName} (message ID: ${(res.data as any).id})`;
    }

    // === VOICE ===
    case 'discord_send_voice_note': {
      if (!extras?.elevenLabsApiKey) throw new Error('ElevenLabs API key not configured');

      const voiceId = (args.voice_id as string) || extras.elevenLabsVoiceId;
      if (!voiceId) throw new Error('voice_id is required (or set ELEVENLABS_VOICE_ID) — get yours from https://elevenlabs.io/app/voice-lab');
      const text = args.text as string;
      if (!args.channel_id && !args.user_id) throw new Error('Must provide channel_id or user_id');

      const asVoiceMessage = args.as_voice_message !== false;

      const speak = (format: string) => fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${format}`, {
        method: 'POST',
        headers: {
          'xi-api-key': extras.elevenLabsApiKey!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_v3',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      });

      // Opus at 48 kHz / 32 kbps matches what Discord's own clients record.
      // If Opus is refused (some plans or voices), fall back to mp3 rather than failing.
      let ttsRes = await speak(asVoiceMessage ? 'opus_48000_32' : 'mp3_44100_128');
      let opusError = '';
      if (!ttsRes.ok && asVoiceMessage) {
        opusError = `ElevenLabs ${ttsRes.status}: ${(await ttsRes.text()).slice(0, 200)}`;
        ttsRes = await speak('mp3_44100_128');
      }

      if (!ttsRes.ok) {
        const errText = await ttsRes.text();
        const tried = opusError ? `Opus failed (${opusError}), then mp3 failed: ` : '';
        throw new Error(`${tried}ElevenLabs error ${ttsRes.status}: ${errText}`);
      }
      const opusFailure = opusError ? `Opus unavailable (${opusError}); sent mp3 instead. ` : '';

      const audioData = new Uint8Array(await ttsRes.arrayBuffer());

      // Resolve target channel
      let targetChannelId = args.channel_id as string | undefined;
      if (!targetChannelId && args.user_id) {
        const dmRes = await discordFetch(token, 'POST', '/users/@me/channels', { recipient_id: args.user_id });
        if (!dmRes.ok) throw new Error(`Failed to open DM: ${JSON.stringify(dmRes.data)}`);
        targetChannelId = (dmRes.data as any).id;
      }
      const channelPath = `/channels/${targetChannelId}/messages`;

      const voice = asVoiceMessage ? describeOggOpus(audioData) : null;
      if (voice) {
        // A voice message must be the audio alone, so any text goes first as its own message
        if (args.message) await sendText(token, targetChannelId!, args.message as string, args);
        const res = await discordFetchMultipart(token, 'POST', channelPath, {
          flags: 1 << 13, // IS_VOICE_MESSAGE
          attachments: [{ id: 0, filename: 'voice-message.ogg', duration_secs: voice.durationSecs, waveform: voice.waveform }],
        }, audioData, 'voice-message.ogg', 'audio/ogg');
        if (res.ok) return `Voice message sent (${voice.durationSecs}s, message ID: ${(res.data as any).id})`;

        // Not allowed as a voice message (e.g. no Send Voice Messages permission): send the same audio as a file
        const fallback = await discordFetchMultipart(token, 'POST', channelPath, { attachments: [{ id: 0, filename: 'voice-note.ogg' }] }, audioData, 'voice-note.ogg', 'audio/ogg');
        if (!fallback.ok) throw new Error(`Discord API error: ${JSON.stringify(fallback.data)}`);
        return `Sent as an audio file instead of a voice message (Discord said: ${JSON.stringify(res.data)}). Message ID: ${(fallback.data as any).id}`;
      }

      // mp3 requested, or the audio wasn't Ogg/Opus: a normal attachment
      const isOgg = audioData[0] === 0x4f && audioData[1] === 0x67;
      const fileName = isOgg ? 'voice-note.ogg' : 'voice-note.mp3';
      const payload: any = { attachments: [{ id: 0, filename: fileName }], allowed_mentions: allowedMentions(args) };
      if (args.message) payload.content = args.message;

      const res = await discordFetchMultipart(token, 'POST', channelPath, payload, audioData, fileName, isOgg ? 'audio/ogg' : 'audio/mpeg');
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `${opusFailure}Voice note sent as ${fileName} (${audioData.byteLength} bytes, message ID: ${(res.data as any).id})`;
    }

    // === POLLS ===
    case 'discord_create_poll': {
      const answers = (args.answers as string[]).map(text => ({ poll_media: { text } }));
      const body = {
        content: '',
        poll: {
          question: { text: args.question },
          answers,
          duration: Math.min(Math.max((args.duration_hours as number) || 24, 1), 168),
          allow_multiselect: args.allow_multiselect ?? false,
        },
      };
      const res = await discordFetch(token, 'POST', `/channels/${args.channel_id}/messages`, body);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Poll created: ${(res.data as any).id}`;
    }

    case 'discord_end_poll': {
      const res = await discordFetch(token, 'POST', `/channels/${args.channel_id}/polls/${args.message_id}/expire`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Poll closed.\n${formatMessage(res.data)}`;
    }

    case 'discord_get_poll_voters': {
      const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 100);
      const res = await discordFetch(token, 'GET', `/channels/${args.channel_id}/polls/${args.message_id}/answers/${args.answer_id}?limit=${limit}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const users = (res.data as any).users ?? [];
      if (users.length === 0) return 'No votes for this answer';
      return users.map((u: any) => `${u.global_name || u.username} (@${u.username}, ID: ${u.id})`).join('\n');
    }

    case 'discord_search_messages': {
      const params = new URLSearchParams();
      for (const key of ['content', 'author_id', 'channel_id', 'mentions', 'has'] as const) {
        if (args[key]) params.set(key, String(args[key]));
      }
      params.set('limit', String(Math.min(Math.max(Number(args.limit) || 25, 1), 25)));
      if (args.offset) params.set('offset', String(Math.min(Math.max(Number(args.offset), 0), 9975)));
      params.set('sort_order', args.oldest_first ? 'asc' : 'desc');
      const res = await discordFetch(token, 'GET', `/guilds/${args.guild_id}/messages/search?${params}`);
      if (res.status === 202) {
        const wait = (res.data as any)?.retry_after;
        return `Discord is still indexing this server for search. Try again${wait ? ` in about ${Math.ceil(wait)}s` : ' shortly'}.`;
      }
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const data = res.data as any;
      // Each result is an array whose matched message is the one flagged "hit" (or the only one)
      const hits = (data.messages ?? []).map((group: any) =>
        Array.isArray(group) ? (group.find((m: any) => m.hit) ?? group[0]) : group);
      if (hits.length === 0) return 'No messages found';
      const shown = Number(args.offset || 0) + hits.length;
      const header = `${data.total_results ?? hits.length} result(s); showing ${Number(args.offset || 0) + 1}-${shown}.`;
      return [header, ...hits.map((m: any) => `in channel ${m.channel_id}: ${formatMessage(m)}`)].join('\n\n');
    }

    case 'discord_forward_message': {
      const res = await discordFetch(token, 'POST', `/channels/${args.to_channel_id}/messages`, {
        message_reference: { type: 1, message_id: args.message_id, channel_id: args.from_channel_id },
      });
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Message forwarded (ID: ${(res.data as any).id})`;
    }

    // === RICH MESSAGES ===
    case 'discord_send_rich_message': {
      const body: any = { flags: COMPONENTS_V2, components: buildRichComponents(args), allowed_mentions: allowedMentions(args) };
      if (args.reply_to) body.message_reference = { message_id: args.reply_to, fail_if_not_exists: false };
      const res = await discordFetch(token, 'POST', `/channels/${args.channel_id}/messages`, body);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Rich message sent (ID: ${(res.data as any).id})`;
    }

    case 'discord_edit_rich_message': {
      const components = buildRichComponents(args);
      // Editing replaces the flags, so start from the message's current ones
      const current = await discordFetch(token, 'GET', `/channels/${args.channel_id}/messages/${args.message_id}`);
      if (!current.ok) throw new Error(`Discord API error: ${JSON.stringify(current.data)}`);
      const flags = ((current.data as any).flags || 0) | COMPONENTS_V2;
      // With the Components V2 flag set, content and embeds must be empty
      const res = await discordFetch(token, 'PATCH', `/channels/${args.channel_id}/messages/${args.message_id}`, {
        flags, content: null, embeds: [], components, allowed_mentions: allowedMentions(args),
      });
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Rich message ${args.message_id} edited`;
    }

    // === PROFILE ===
    case 'discord_get_my_profile': {
      const res = await discordFetch(token, 'GET', '/users/@me');
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const user = res.data as any;
      const lines = [
        `Username: ${user.username}`,
        ...(user.global_name ? [`Display name: ${user.global_name}`] : []),
        `ID: ${user.id}`,
        `Avatar: ${user.avatar ? cdnImage(`avatars/${user.id}`, user.avatar) : 'none (default avatar)'}`,
        `Banner: ${user.banner ? cdnImage(`banners/${user.id}`, user.banner) : 'none'}`,
      ];
      if (args.guild_id) {
        const memberRes = await discordFetch(token, 'GET', `/guilds/${args.guild_id}/members/${user.id}`);
        if (!memberRes.ok) throw new Error(`Discord API error: ${JSON.stringify(memberRes.data)}`);
        const member = memberRes.data as any;
        const base = `guilds/${args.guild_id}/users/${user.id}`;
        lines.push(
          `In server ${args.guild_id}:`,
          `  Nickname: ${member.nick ?? 'none'}`,
          `  Server avatar: ${member.avatar ? cdnImage(`${base}/avatars`, member.avatar) : 'none (uses the global avatar)'}`,
          `  Server banner: ${member.banner ? cdnImage(`${base}/banners`, member.banner) : 'none (uses the global banner)'}`,
        );
        // Discord's member object doesn't list a bio, so this only shows if the response carries one
        if (member.bio) lines.push(`  Bio: ${member.bio}`);
      }
      return lines.join('\n');
    }

    case 'discord_set_my_profile': {
      const body: any = {};
      if (args.nickname !== undefined) body.nick = (args.nickname as string) || null;
      if (args.bio !== undefined) body.bio = (args.bio as string) || null;
      for (const field of ['avatar', 'banner'] as const) {
        const image = await imageDataUri(args, field);
        if (image && args[`clear_${field}`]) throw new Error(`Give a new ${field} or clear_${field}, not both`);
        if (image) body[field] = image;
        else if (args[`clear_${field}`]) body[field] = null;
      }
      if (Object.keys(body).length === 0) throw new Error('Nothing to change: give a nickname, bio, avatar or banner (or clear_avatar / clear_banner)');
      const res = await discordFetch(token, 'PATCH', `/guilds/${args.guild_id}/members/@me`, body, auditReason(args));
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const changed = Object.entries(body).map(([key, value]) => `${key === 'nick' ? 'nickname' : key}${value === null ? ' cleared' : ''}`);
      return `Profile updated in guild ${args.guild_id}: ${changed.join(', ')}`;
    }

    case 'discord_set_my_global_profile': {
      const body: any = {};
      if (args.username !== undefined) body.username = args.username;
      for (const field of ['avatar', 'banner'] as const) {
        const image = await imageDataUri(args, field);
        if (image && args[`clear_${field}`]) throw new Error(`Give a new ${field} or clear_${field}, not both`);
        if (image) body[field] = image;
        else if (args[`clear_${field}`]) body[field] = null;
      }
      if (Object.keys(body).length === 0) throw new Error('Nothing to change: give a username, avatar or banner (or clear_avatar / clear_banner)');
      const res = await discordFetch(token, 'PATCH', '/users/@me', body);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const changed = Object.entries(body).map(([key, value]) => `${key}${value === null ? ' cleared' : ''}`);
      return `Global profile updated: ${changed.join(', ')}`;
    }

    // === SCHEDULED EVENTS ===
    case 'discord_list_events': {
      const res = await discordFetch(token, 'GET', `/guilds/${args.guild_id}/scheduled-events${args.with_user_count ? '?with_user_count=true' : ''}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const events = res.data as any[];
      if (events.length === 0) return 'No scheduled events';
      return events.map(e => {
        const where = e.entity_type === 3 ? `external: ${e.entity_metadata?.location ?? '?'}` : `${EVENT_ENTITY_NAMES[e.entity_type] ?? 'channel'} channel ${e.channel_id}`;
        const ends = e.scheduled_end_time ? ` to ${e.scheduled_end_time}` : '';
        const interested = e.user_count !== undefined ? `, ${e.user_count} interested` : '';
        return `${e.name} (ID: ${e.id}) — ${EVENT_STATUS_NAMES[e.status] ?? e.status}, ${e.scheduled_start_time}${ends}, ${where}${interested}`;
      }).join('\n');
    }

    case 'discord_create_event': {
      const start = isoTime(args.start_time, 'start_time');
      if (Date.parse(start) <= Date.now()) throw new Error('start_time must be in the future');
      const end = args.end_time ? isoTime(args.end_time, 'end_time') : undefined;
      if (end && Date.parse(end) <= Date.parse(start)) throw new Error('end_time must be after start_time');
      const body: any = { name: args.name, privacy_level: 2, scheduled_start_time: start };
      if (args.channel_id) {
        if (args.location) throw new Error('Give channel_id (a voice or stage event) or location (an external event), not both');
        const chRes = await discordFetch(token, 'GET', `/channels/${args.channel_id}`);
        if (!chRes.ok) throw new Error(`Discord API error: ${JSON.stringify(chRes.data)}`);
        const type = (chRes.data as any).type;
        if (type !== 2 && type !== 13) throw new Error(`Channel ${args.channel_id} isn't a voice or stage channel; events can only be held in those`);
        body.channel_id = args.channel_id;
        body.entity_type = type === 13 ? 1 : 2;
      } else {
        // External events have no channel, so Discord needs to be told where and until when
        if (!args.location || !end) throw new Error('Without a channel_id this is an external event, which needs both location and end_time');
        body.entity_type = 3;
        body.entity_metadata = { location: args.location };
      }
      if (end) body.scheduled_end_time = end;
      if (args.description) body.description = args.description;
      const image = await imageDataUri(args, 'image');
      if (image) body.image = image;
      const res = await discordFetch(token, 'POST', `/guilds/${args.guild_id}/scheduled-events`, body);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const event = res.data as any;
      return `Event created: ${event.name} (ID: ${event.id}), ${EVENT_ENTITY_NAMES[event.entity_type] ?? 'event'}, starts ${event.scheduled_start_time}`;
    }

    case 'discord_edit_event': {
      const body: any = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.start_time !== undefined) body.scheduled_start_time = isoTime(args.start_time, 'start_time');
      if (args.end_time !== undefined) body.scheduled_end_time = isoTime(args.end_time, 'end_time');
      if (args.description !== undefined) body.description = args.description;
      if (args.status !== undefined) {
        const status = EVENT_STATUS[String(args.status).toLowerCase()];
        if (!status) throw new Error('status must be active, completed or canceled');
        body.status = status;
      }
      if (args.location !== undefined) {
        // Discord silently drops a location on voice and stage events, so say so instead
        const current = await discordFetch(token, 'GET', `/guilds/${args.guild_id}/scheduled-events/${args.event_id}`);
        if (!current.ok) throw new Error(`Discord API error: ${JSON.stringify(current.data)}`);
        if ((current.data as any).entity_type !== 3) throw new Error('location only applies to external events; this one is held in a channel');
        body.entity_metadata = { location: args.location };
      }
      if (Object.keys(body).length === 0) throw new Error('Nothing to change');
      const res = await discordFetch(token, 'PATCH', `/guilds/${args.guild_id}/scheduled-events/${args.event_id}`, body);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Event ${args.event_id} updated (now ${EVENT_STATUS_NAMES[(res.data as any).status] ?? 'updated'})`;
    }

    case 'discord_delete_event': {
      const res = await discordFetch(token, 'DELETE', `/guilds/${args.guild_id}/scheduled-events/${args.event_id}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Event ${args.event_id} deleted`;
    }

    case 'discord_get_event_users': {
      const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 100);
      const res = await discordFetch(token, 'GET', `/guilds/${args.guild_id}/scheduled-events/${args.event_id}/users?limit=${limit}&with_member=true`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const entries = res.data as any[];
      if (entries.length === 0) return 'Nobody is interested yet';
      return entries.map(e => `${e.member?.nick || e.user.global_name || e.user.username} (@${e.user.username}, ID: ${e.user.id})`).join('\n');
    }

    // === EMOJI ===
    case 'discord_list_emojis': {
      let emojis: any[];
      if (args.guild_id) {
        const res = await discordFetch(token, 'GET', `/guilds/${args.guild_id}/emojis`);
        if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
        emojis = res.data as any[];
      } else {
        const res = await discordFetch(token, 'GET', `/applications/${await botApplicationId(token)}/emojis`);
        if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
        emojis = (res.data as any).items ?? [];
      }
      if (emojis.length === 0) return 'No custom emoji';
      return emojis.map(e => `${e.name} (ID: ${e.id}) — ${emojiTag(e)}${e.available === false ? ' [unavailable]' : ''}`).join('\n');
    }

    case 'discord_create_emoji': {
      if (!/^[A-Za-z0-9_]{2,32}$/.test(String(args.name))) throw new Error('Emoji name must be 2-32 letters, digits or underscores');
      const image = await imageDataUri(args, 'image', EMOJI_MAX_BYTES);
      if (!image) throw new Error('Must provide either image_url or image_base64');
      const path = args.guild_id ? `/guilds/${args.guild_id}/emojis` : `/applications/${await botApplicationId(token)}/emojis`;
      const res = await discordFetch(token, 'POST', path, { name: args.name, image });
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const emoji = res.data as any;
      return `Emoji created: ${emojiTag(emoji)} (ID: ${emoji.id})`;
    }

    case 'discord_delete_emoji': {
      const path = args.guild_id ? `/guilds/${args.guild_id}/emojis` : `/applications/${await botApplicationId(token)}/emojis`;
      const res = await discordFetch(token, 'DELETE', `${path}/${args.emoji_id}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Emoji ${args.emoji_id} deleted`;
    }

    // === STICKERS ===
    case 'discord_list_stickers': {
      const res = await discordFetch(token, 'GET', `/guilds/${args.guild_id}/stickers`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const stickers = res.data as any[];
      if (stickers.length === 0) return 'No custom stickers';
      return stickers.map(s => {
        const about = s.description ? ` — ${s.description}` : '';
        return `${s.name} (ID: ${s.id}) [${STICKER_FORMAT_NAMES[s.format_type] ?? s.format_type}]${about} (tags: ${s.tags})${s.available === false ? ' [unavailable]' : ''}`;
      }).join('\n');
    }

    case 'discord_create_sticker': {
      const name = String(args.name);
      const description = String(args.description ?? '');
      const tags = String(args.tags ?? '');
      if (name.length < 2 || name.length > 30) throw new Error('Sticker name must be 2-30 characters');
      if (description && (description.length < 2 || description.length > 100)) throw new Error('Sticker description must be empty or 2-100 characters');
      if (!tags || tags.length > 200) throw new Error('Sticker tags must be 1-200 characters');
      const fileName = args.file_name as string;
      const ext = fileName.match(/\.(png|apng|gif|json)$/i)?.[1].toLowerCase();
      if (!ext) throw new Error('file_name must end in .png, .apng, .gif or .json (PNG, APNG, GIF or Lottie)');
      const { data } = await resolveFileData(args);
      if (data.length > STICKER_MAX_BYTES) throw new Error(`Sticker file is ${Math.ceil(data.length / 1024)} KiB; the limit is 512 KiB`);
      const contentType = ext === 'gif' ? 'image/gif' : ext === 'json' ? 'application/json' : 'image/png';
      const res = await discordFetchForm(token, 'POST', `/guilds/${args.guild_id}/stickers`, { name, description, tags }, { field: 'file', data, fileName, contentType });
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      const sticker = res.data as any;
      return `Sticker created: ${sticker.name} (ID: ${sticker.id})`;
    }

    case 'discord_delete_sticker': {
      const res = await discordFetch(token, 'DELETE', `/guilds/${args.guild_id}/stickers/${args.sticker_id}`);
      if (!res.ok) throw new Error(`Discord API error: ${JSON.stringify(res.data)}`);
      return `Sticker ${args.sticker_id} deleted`;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
