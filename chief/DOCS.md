# Chief

A Claude Code session that stays running on this box and answers your private
Discord bot, with your Claude connectors. It uses Anthropic's Discord channel
plugin (research preview) and your Claude plan; no API key.

## Set up (once)

1. Install and start the add-on. Leave auto-update off.
2. Open the **Chief** panel. It shows the Claude Code session.
3. Sign in to Claude when it asks (the link opens in your browser; paste the code back).
4. Type `/discord:configure` and your bot token. Then `/discord:access pair <code>`
   after you DM the bot, and `/discord:access policy allowlist`.
5. Type `/exit`. The session starts again in 5 seconds with Discord connected.

Only one place may run the bot at a time. Stop any other session using the same
token first, or both will answer.

The sign-in, token and allowlist live in this add-on's private storage (`/data`),
which is included in Home Assistant backups.
