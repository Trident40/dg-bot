# dg-discord — ArcaneMP Server Bridge & Standalone Discord Bot - FREE VERSION.

This is a stripped down version to what I run on my server. I've made this free for the ArcaneMP Community. 

Complete two-part Discord integration for **ArcaneMP (HogwartsMP) Foundations**:
1. **`resources/dg-discord/`** — Lightweight in-server HTTP/SSE bridge + MySQL migrations + in-game `/link` linking.
2. **`bot/`** — Standalone `discord.js` v14 Node.js bot with auto-updating Server Status & House Cup embeds, Staff slash commands, real-time Audit Logs, Hogwarts House role synchronization, and MySQL offline fallback queueing.

---

## Architecture & Security Highlights
- **HMAC-SHA256 Signed Local Bridge**: Every HTTP/SSE call between the bot and game server is signed with a shared secret + timestamp replay window (`±60s`) verified via `crypto.timingSafeEqual`. Binds to `127.0.0.1:4190` by default.
- **Zero Hardcoded Secrets**: Bot token, MySQL credentials, and bridge secret stay exclusively in `bot/.env` and server-side environment / `data/dg-discord.json`.
- **Hybrid Online/Offline Reliability**: Live commands execute immediately (<100ms) while the game server is online. If the server restarts or goes offline, `/housecup` reads the cached MySQL snapshot and staff actions (`/decree`, `/points`, `/ban`, `/unban`) queue safely in `dg_discord_action_queue` and execute automatically when the server returns.
- **Native Integration**: Dispatches parchment scrolls via `dg-notify`, reads/awards points via `hmp-houses`, enforces bans via `hmp-headmaster`, and persists links in `hmp-mysql`.

---

## Step 1 — Install the ArcaneMP Bridge Resource
1. Copy `resources/dg-discord/` and `data/dg-discord.json` into your ArcaneMP server root.
2. Generate a random 32+ character shared secret (e.g. `openssl rand -hex 32`) and set it in **either**:
   - Environment variable `DG_DISCORD_BRIDGE_SECRET`, **or**
   - `"secret"` inside `data/dg-discord.json`.
3. Build the bridge resource:
   ```bash
   cd resources/dg-discord
   npm install
   npm run build
   ```
4. Restart your ArcaneMP server. Verify the console prints:
   `Discord Bridge HTTP/SSE server listening on http://127.0.0.1:4190`

---

## Step 2 — Set Up & Run the Standalone Discord Bot
1. Create a Discord Application at the Discord Developer Portal -> **Bot** -> enable **Server Members Intent** (required for Hogwarts House role assignment).
2. Invite the bot to your Discord server with `bot` + `applications.commands` scopes and **Manage Roles**, **Send Messages**, and **Embed Links** permissions (ensure the bot's own role is positioned **above** your Gryffindor / Slytherin / Ravenclaw / Hufflepuff roles).
3. Configure `bot/.env`:
   ```bash
   cd bot
   cp .env.example .env
   ```
   Fill in `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `BRIDGE_SECRET` (matching Step 1), MySQL credentials, Channel IDs, and Role IDs.
4. Install dependencies, register slash commands, and launch:
   ```bash
   npm install
   npm run deploy-commands
   npm run build
   npm start
   ```
   *(Recommended for production: `pm2 start dist/index.js --name dg-discord-bot`)*

---

## Slash Commands Reference
- `/status` — Live Hogwarts player count & bridge state
- `/housecup` — Current House Cup standings (live or MySQL offline snapshot)
- `/online` — Online student roster
- `/link <code>` — Verify 6-character code from in-game `/link` & auto-assign Hogwarts House + Verified roles
- `/decree <title> <message>` — *(Staff)* Broadcast a `dg-notify` Headmaster Decree scroll (queues if offline)
- `/howler <player> <message>` — *(Staff)* Send a crimson Howler scroll to an online student
- `/points <house> <amount> <reason>` — *(Staff)* Award or deduct House Cup points (queues if offline)
- `/kick <player> <reason>` — *(Staff)* Kick an online student
- `/ban <target> <reason>` / `/unban <discord_id>` — *(Staff)* Enforce or lift bans via `hmp-headmaster`
- `/syncroles` — *(Staff)* Bulk-sync Hogwarts House roles for all linked students

---

## Bridge Exports (For Other Server Resources)
```ts
const Discord = Imports.get<any>("dg-discord");

// Push custom audit log embed straight to Discord
Discord.pushAudit("academy", "N.E.W.T. Graduation", "Lyra Blackwood graduated Year 7!", "hmp-academy", [
  { name: "Career Track", value: "Auror Office", inline: true },
]);

// Trigger immediate House Discord role sync when a student changes house
Discord.syncPlayerRoles(player, "slytherin");
```
