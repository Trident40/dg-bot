# dg-discord — ArcaneMP Discord Bridge & Standalone Bot

A complete two-part Discord integration for **ArcaneMP (HogwartsMP) Foundations**. Connects your live game server directly to Discord with real-time House Cup leaderboards, Hogwarts audit logs, `/link` account verification with automatic House Discord roles, staff moderation slash commands, and MySQL offline queueing.

---

## What This Is

`dg-discord` packages both sides of the integration in one ZIP archive:

1. **In-Server Bridge Resource (`resources/dg-discord/` + `data/dg-discord.json`)**
   Runs inside ArcaneMP Foundations (priority `-850`), hosts a local HMAC-SHA256 HTTP/SSE API, creates MySQL tables via `hmp-mysql`, registers the in-game `/link` and `/unlink` commands, and listens to live Hogwarts events.
2. **Standalone Discord Bot (`bot/`)**
   An independent `discord.js` v14 Node.js bot that connects to the bridge over HTTP + Server-Sent Events (SSE) and automatically falls back to your shared MySQL database whenever the game server is offline or restarting.

### Included Features
- **Live Pinned Embeds**: Auto-updating `#server-status` player counter and `#house-cup` leaderboard synced from `hmp-houses`.
- **Account Linking & Auto House Roles**: Players run `/link` in-game to generate a 6-character code, verify with `/link <code>` in Discord, and automatically receive `@Verified Student` plus their Hogwarts House role (`Gryffindor`, `Slytherin`, `Ravenclaw`, or `Hufflepuff`). Roles re-sync automatically when sorted.
- **Staff Slash Commands**:
  - `/decree <title> <message>` — Broadcast a `dg-notify` Headmaster Decree scroll to all online students (queues in MySQL if offline)
  - `/howler <player> <message>` — Send a crimson shaking Howler scroll to an online student
  - `/points <house> <amount> <reason>` — Award or deduct House Cup points (queues if offline)
  - `/kick <player> <reason>` — Kick an online student via `hmp-headmaster`
  - `/ban <target> <reason>` / `/unban <discord_id>` — Enforce or lift bans in `hmp-headmaster` (queues if offline)
  - `/syncroles` — Bulk-sync Discord House roles for all linked students
- **Public Slash Commands**: `/status`, `/housecup`, `/online`, `/link <code>`
- **Live Discord Audit Logs**: Streams player joins/leaves (`hmp-core`), Sorting Hat ceremonies (`hmp-sorting`), Academy level-ups & N.E.W.T. graduations (`hmp-academy`), Ollivanders wand crafts (`hmp-ollivanders`), staff moderation (`hmp-headmaster`), and account linking events to `#audit-logs` and `#mod-logs`.

---

## How It Works

### 1. Live Bridge Transport (HMAC-SHA256 + SSE)
- `resources/dg-discord/` starts a local HTTP/SSE server (default `127.0.0.1:4190`).
- Every request between `bot/` and the server is signed with `X-DG-Timestamp` and `X-DG-Signature` (`HMAC-SHA256(timestamp.METHOD.path.body, BRIDGE_SECRET)`) and verified with `crypto.timingSafeEqual` within a `±60s` replay window.
- When events happen in-game (Sorting Hat reveal, Academy milestone, Ollivanders purchase, ban/kick, or House points update), the server immediately pushes SSE events (`audit`, `houseCup`, `roleSync`, `queueDrained`) to Discord in real time.

### 2. MySQL Offline Fallback & Action Queue (`hmp-mysql`)
On startup, `resources/dg-discord/` migrates 5 MySQL tables automatically:
- `dg_discord_links` — Maps `character_id` <-> `discord_id`, character name, and current House
- `dg_discord_link_codes` — One-time 6-character `/link` verification codes with expiration
- `dg_discord_action_queue` — Queues `/points`, `/decree`, `/ban`, and `/unban` commands issued while the game server is offline
- `dg_discord_house_snapshot` — Cached House Cup standings for offline `/housecup` queries
- `dg_discord_audit_log` — Persistent audit history

When the ArcaneMP server comes back online, it automatically drains `dg_discord_action_queue` in order and notifies Discord once queued actions execute.

### 3. Security & Role Safety
- Secrets (`DISCORD_BOT_TOKEN`, `BRIDGE_SECRET`, MySQL credentials) stay strictly in `bot/.env` and server-side env / `data/dg-discord.json`.
- Root Admin Discord IDs are protected from remote `/kick` and `/ban` actions.
- Account re-linking atomically consumes codes and clears prior conflicting bindings before assigning updated House roles.

---

## Install Guide

### Prerequisites
- **Node.js 20+** and **MySQL 8+** (`hmp-mysql` configured on ArcaneMP)
- **ArcaneMP Foundations**: `hmp-lib`, `hmp-core`, `hmp-mysql`, `hmp-houses`
- Optional auto-hooked resources: `dg-notify`, `hmp-headmaster`, `hmp-sorting`, `hmp-academy`, `hmp-ollivanders`
- A Discord Bot Application from the Discord Developer Portal

### Step 1 — Set Up Your Discord Bot Application
1. Open your app in the **Discord Developer Portal** -> **Bot** -> enable **Server Members Intent** (required to assign Hogwarts House roles).
2. Copy your **Bot Token** and **Application (Client) ID**.
3. Under **OAuth2 -> URL Generator**, invite the bot to your server with:
   - Scopes: `bot`, `applications.commands`
   - Permissions: `Manage Roles`, `Send Messages`, `Embed Links`, `Read Message History`
4. In Discord **Server Settings -> Roles**, drag the bot's role **above** `@Verified Student` and all four House roles (`Gryffindor`, `Slytherin`, `Ravenclaw`, `Hufflepuff`).

### Step 2 — Install the ArcaneMP Bridge Resource
1. Extract `dg-discord.zip` and copy `resources/dg-discord/` and `data/dg-discord.json` into your ArcaneMP server root.
2. Generate a shared secret (at least 16 characters, 32+ recommended):

    openssl rand -hex 32

3. Set that secret on your server via **either**:
   - Environment variable `DG_DISCORD_BRIDGE_SECRET=...` *(recommended)*, **or**
   - `"secret"` inside `data/dg-discord.json`
4. Build the bridge resource:

    cd resources/dg-discord
    npm install
    npm run build

5. Restart your ArcaneMP server and verify the console logs:

    MySQL tables for dg-discord migrated and ready.
    Discord Bridge HTTP/SSE server listening on http://127.0.0.1:4190

### Step 3 — Configure & Run the Standalone Bot
1. Place the `bot/` directory on your host (same machine as your game server if using loopback `127.0.0.1:4190`).
2. Create `bot/.env` from the template:

    cd bot
    cp .env.example .env

3. Fill in `bot/.env`:
   - `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`
   - `BRIDGE_URL` (e.g. `http://127.0.0.1:4190`) and `BRIDGE_SECRET` (must match Step 2)
   - `MYSQL_ENABLED=true`, `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`
   - Channel IDs: `CHANNEL_STATUS_ID`, `CHANNEL_HOUSE_CUP_ID`, `CHANNEL_AUDIT_LOG_ID`, `CHANNEL_MOD_LOG_ID`, `CHANNEL_LINKING_ID`
   - Role & Staff IDs: `ROOT_ADMIN_DISCORD_IDS`, `STAFF_ROLE_IDS`, `ROLE_VERIFIED_STUDENT_ID`, `ROLE_GRYFFINDOR_ID`, `ROLE_SLYTHERIN_ID`, `ROLE_RAVENCLAW_ID`, `ROLE_HUFFLEPUFF_ID`
4. Install dependencies, register slash commands, build, and start:

    npm install
    npm run deploy-commands
    npm run build
    npm start

   For 24/7 hosting with PM2:

    pm2 start dist/index.js --name dg-discord-bot && pm2 save

---

## Export API (For Custom Server Resources)

Push custom audit embeds or trigger House Discord role syncs from any ArcaneMP server script:

    const Discord = Imports.get<any>("dg-discord");

    Discord?.pushAudit("academy", "House Duels Winner", "Lyra Blackwood won the Great Hall Dueling Cup!", "hmp-duels", [
      { name: "House", value: "Slytherin", inline: true },
    ]);

    Discord?.syncPlayerRoles(player, "slytherin");
