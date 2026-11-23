/**
 * dg-discord — ArcaneMP Foundations Discord Bridge (Server Entrypoint)
 *
 * Provides:
 * - HMAC-SHA256 authenticated local HTTP API + SSE real-time event stream for the standalone Discord bot
 * - Shared MySQL persistence (links, one-time link codes, offline staff action queue, house snapshots, audit log)
 * - Automatic integration with dg-notify, hmp-houses, hmp-academy, hmp-headmaster, hmp-ollivanders, and hmp-core
 */

import http = require("http");
import crypto = require("crypto");
import fs = require("fs");
import path = require("path");

declare const PlayerManager: {
  getAll(): BridgePlayer[];
  getById?(id: number): BridgePlayer | undefined;
};

declare const Events: {
  on(eventName: string, listener: (...args: any[]) => unknown): void;
  emit?(eventName: string, ...args: any[]): void;
};

declare const Imports: {
  get<T = any>(resourceName: string): T;
};

declare const Exports: {
  register(name: string, value: unknown): void;
};

interface BridgePlayer {
  id: number;
  nickname?: string;
  name?: string;
  discordId?: string;
  characterId?: number;
  house?: string;
  sendChat?(message: string): void;
  kick?(reason?: string): void;
}

type HouseKey = "gryffindor" | "slytherin" | "ravenclaw" | "hufflepuff";

interface BridgeRuntimeConfig {
  $schema?: string;
  enabled: boolean;
  serverDisplayName: string;
  rootAdminDiscordIds: string[];
  bridge: {
    host: string;
    port: number;
    secretEnvVar: string;
    secret: string;
    replayWindowMs: number;
  };
  mysqlFallback: {
    enabled: boolean;
    drainQueueIntervalSeconds: number;
    houseSnapshotIntervalSeconds: number;
  };
  linking: {
    linkCommand: string;
    unlinkCommand: string;
    codeExpiryMinutes: number;
  };
  auditLogs: {
    joinsAndLeaves: boolean;
    sortingResults: boolean;
    academyMilestones: boolean;
    wandPurchases: boolean;
    staffModeration: boolean;
    accountLinking: boolean;
  };
}

const RESOURCE_NAME = "dg-discord";
const DEFAULT_CONFIG: BridgeRuntimeConfig = {
  "$schema": "https://github.com/arcane-mp/foundations/dg-discord.schema.json",
  "enabled": true,
  "serverDisplayName": "Hogwarts ArcaneMP RP",
  "rootAdminDiscordIds": [
    "96915452877348864"
  ],
  "bridge": {
    "host": "127.0.0.1",
    "port": 4190,
    "secretEnvVar": "DG_DISCORD_BRIDGE_SECRET",
    "secret": "",
    "replayWindowMs": 60000
  },
  "mysqlFallback": {
    "enabled": true,
    "drainQueueIntervalSeconds": 10,
    "houseSnapshotIntervalSeconds": 30
  },
  "linking": {
    "linkCommand": "link",
    "unlinkCommand": "unlink",
    "codeExpiryMinutes": 10
  },
  "auditLogs": {
    "joinsAndLeaves": true,
    "sortingResults": true,
    "academyMilestones": true,
    "wandPurchases": true,
    "staffModeration": true,
    "accountLinking": true
  }
};
const MAX_BODY_BYTES = 64 * 1024;
const LINK_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function safeImport(resource: string): any {
  try {
    return Imports.get<any>(resource);
  } catch {
    return null;
  }
}

const Hmp = safeImport("hmp-lib");
const Database = safeImport("hmp-mysql");
const Core = safeImport("hmp-core");
const Houses = safeImport("hmp-houses");
const ScrollNotify = safeImport("dg-notify") || safeImport("hmp-notify");
const Headmaster = safeImport("hmp-headmaster");
const Ui = safeImport("hmp-ui");

const logger = Hmp?.logger?.create
  ? Hmp.logger.create(RESOURCE_NAME)
  : {
      info: (m: string) => console.log(`[${RESOURCE_NAME}] ${m}`),
      warn: (m: string) => console.warn(`[${RESOURCE_NAME}] ${m}`),
      error: (m: string) => console.error(`[${RESOURCE_NAME}] ${m}`),
    };

let runtimeConfig: BridgeRuntimeConfig = loadRuntimeConfig();
let httpServer: http.Server | null = null;
let dbReady = false;
let queueDrainTimer: ReturnType<typeof setInterval> | null = null;
let houseSnapshotTimer: ReturnType<typeof setInterval> | null = null;
let sseHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
const sseClients = new Set<http.ServerResponse>();

const DISCORD_MIGRATIONS = [
  {
    version: 1,
    name: "create dg_discord_links, link_codes, action_queue, audit_log, and house_snapshot tables",
    statements: [
      `CREATE TABLE IF NOT EXISTS dg_discord_links (
        character_id BIGINT UNSIGNED NOT NULL,
        discord_id VARCHAR(32) NOT NULL,
        character_name VARCHAR(96) NOT NULL DEFAULT 'Student',
        house VARCHAR(24) NULL DEFAULT NULL,
        year_level TINYINT UNSIGNED NOT NULL DEFAULT 1,
        linked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (character_id),
        UNIQUE KEY uq_dg_discord_id (discord_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS dg_discord_link_codes (
        code VARCHAR(12) NOT NULL,
        character_id BIGINT UNSIGNED NOT NULL,
        character_name VARCHAR(96) NOT NULL,
        house VARCHAR(24) NULL DEFAULT NULL,
        expires_at DATETIME NOT NULL,
        consumed TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (code),
        KEY idx_dg_link_codes_char (character_id),
        KEY idx_dg_link_codes_exp (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS dg_discord_action_queue (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        command_type VARCHAR(32) NOT NULL,
        payload_json TEXT NOT NULL,
        issued_by_discord_id VARCHAR(32) NOT NULL,
        issued_by_tag VARCHAR(64) NOT NULL DEFAULT 'Staff',
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        result_message VARCHAR(255) NULL DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        executed_at TIMESTAMP NULL DEFAULT NULL,
        PRIMARY KEY (id),
        KEY idx_dg_queue_status (status, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS dg_discord_audit_log (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        category VARCHAR(24) NOT NULL,
        title VARCHAR(128) NOT NULL,
        description VARCHAR(512) NOT NULL,
        actor VARCHAR(64) NOT NULL DEFAULT 'server',
        payload_json TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_dg_audit_cat (category, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS dg_discord_house_snapshot (
        house_key VARCHAR(24) NOT NULL,
        points INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (house_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
];

function loadRuntimeConfig(): BridgeRuntimeConfig {
  try {
    const file = path.resolve(process.cwd(), "data", `${RESOURCE_NAME}.json`);
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        bridge: { ...DEFAULT_CONFIG.bridge, ...(parsed.bridge || {}) },
        mysqlFallback: { ...DEFAULT_CONFIG.mysqlFallback, ...(parsed.mysqlFallback || {}) },
        linking: { ...DEFAULT_CONFIG.linking, ...(parsed.linking || {}) },
        auditLogs: { ...DEFAULT_CONFIG.auditLogs, ...(parsed.auditLogs || {}) },
      };
    }
  } catch (err) {
    logger.warn(`Could not parse data/${RESOURCE_NAME}.json: ${String(err)}`);
  }
  return DEFAULT_CONFIG;
}

function getBridgeSecret(): string {
  const envKey = runtimeConfig.bridge.secretEnvVar || "DG_DISCORD_BRIDGE_SECRET";
  const fromEnv = process.env[envKey];
  if (typeof fromEnv === "string" && fromEnv.trim().length >= 16) {
    return fromEnv.trim();
  }
  if (typeof runtimeConfig.bridge.secret === "string" && runtimeConfig.bridge.secret.trim().length >= 16) {
    return runtimeConfig.bridge.secret.trim();
  }
  return "";
}

function normalizeHouse(raw: unknown): HouseKey | null {
  const h = String(raw || "").toLowerCase().trim();
  if (h === "gryffindor" || h === "slytherin" || h === "ravenclaw" || h === "hufflepuff") {
    return h;
  }
  return null;
}

function resolveCharacterId(player: BridgePlayer): number | null {
  try {
    const session = Core?.sessions?.get?.(player) || Core?.characters?.getActive?.(player);
    const id = Number(session?.character?.id ?? session?.characterId ?? player.characterId);
    if (Number.isFinite(id) && id > 0) return Math.trunc(id);
  } catch {}
  return Number.isFinite(Number(player.characterId)) && Number(player.characterId) > 0
    ? Math.trunc(Number(player.characterId))
    : null;
}

function resolvePlayerName(player: BridgePlayer): string {
  try {
    const session = Core?.sessions?.get?.(player);
    const charName = session?.character?.name || session?.character?.fullName;
    if (charName) return String(charName);
  } catch {}
  return String(player.nickname || player.name || `Student #${player.id}`);
}

async function resolvePlayerHouse(player: BridgePlayer): Promise<HouseKey | null> {
  try {
    const mem = await Houses?.membership?.get?.(player);
    const normalized = normalizeHouse(mem?.house);
    if (normalized) return normalized;
  } catch {}
  return normalizeHouse(player.house);
}

function sendPlayerScroll(
  player: BridgePlayer,
  title: string,
  description: string,
  tone: "info" | "success" | "warning" | "error" | "decree" | "house" | "magic" = "info",
  house?: HouseKey | null
): void {
  const notifyApi = ScrollNotify || safeImport("dg-notify") || safeImport("hmp-notify");
  if (notifyApi?.notify) {
    void notifyApi.notify(player, {
      title,
      description,
      tone,
      house: house || undefined,
      sender: "Discord Bridge",
    });
    return;
  }
  if (Ui?.notify) {
    Ui.notify(player, { title, description, tone: tone === "decree" || tone === "magic" || tone === "house" ? "info" : tone });
    return;
  }
  player.sendChat?.(`[${title}] ${description}`);
}

async function initDatabase(): Promise<void> {
  if (!Database?.ready || !Database?.migrate) {
    logger.warn("hmp-mysql not available — link persistence & offline queue disabled.");
    dbReady = false;
    return;
  }
  try {
    const ok = await Database.ready();
    if (!ok) {
      dbReady = false;
      return;
    }
    await Database.migrate(RESOURCE_NAME, DISCORD_MIGRATIONS);
    dbReady = true;
    logger.info("MySQL tables for dg-discord migrated and ready.");
  } catch (err) {
    dbReady = false;
    logger.error(`Failed migrating dg-discord tables: ${String(err)}`);
  }
}

function broadcastSse(eventType: string, data: Record<string, unknown>): void {
  const frame = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    if (res.writableEnded || res.destroyed) {
      sseClients.delete(res);
      continue;
    }
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

async function pushAudit(
  category: "joins" | "sorting" | "academy" | "ollivanders" | "staff" | "linking",
  title: string,
  description: string,
  actor = "server",
  fields: Array<{ name: string; value: string; inline?: boolean }> = []
): Promise<void> {
  const toggles = runtimeConfig.auditLogs;
  if (
    (category === "joins" && !toggles.joinsAndLeaves) ||
    (category === "sorting" && !toggles.sortingResults) ||
    (category === "academy" && !toggles.academyMilestones) ||
    (category === "ollivanders" && !toggles.wandPurchases) ||
    (category === "staff" && !toggles.staffModeration) ||
    (category === "linking" && !toggles.accountLinking)
  ) {
    return;
  }

  const entry = {
    category,
    title: String(title).slice(0, 128),
    description: String(description).slice(0, 512),
    actor: String(actor).slice(0, 64),
    fields,
    timestamp: new Date().toISOString(),
  };

  broadcastSse("audit", entry);

  if (dbReady && Database?.query) {
    try {
      await Database.query(
        `INSERT INTO dg_discord_audit_log (category, title, description, actor, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
        [entry.category, entry.title, entry.description, entry.actor, JSON.stringify({ fields })]
      );
    } catch (err) {
      logger.warn(`Could not persist audit log entry: ${String(err)}`);
    }
  }
}

async function readHouseCupStandings(): Promise<Record<HouseKey, number>> {
  const totals: Record<HouseKey, number> = {
    gryffindor: 0,
    slytherin: 0,
    ravenclaw: 0,
    hufflepuff: 0,
  };

  try {
    if (typeof Houses?.points?.getAll === "function") {
      const raw = await Houses.points.getAll();
      for (const h of ["gryffindor", "slytherin", "ravenclaw", "hufflepuff"] as HouseKey[]) {
        const val = Number(raw?.[h] ?? raw?.[h.toUpperCase()] ?? 0);
        if (Number.isFinite(val)) totals[h] = Math.trunc(val);
      }
      return totals;
    }
    if (typeof Houses?.points?.get === "function") {
      for (const h of ["gryffindor", "slytherin", "ravenclaw", "hufflepuff"] as HouseKey[]) {
        const val = Number(await Houses.points.get(h));
        if (Number.isFinite(val)) totals[h] = Math.trunc(val);
      }
      return totals;
    }
  } catch (err) {
    logger.warn(`Could not read hmp-houses standings: ${String(err)}`);
  }

  if (dbReady && Database?.query) {
    try {
      const rows = await Database.query("SELECT house_key, points FROM dg_discord_house_snapshot");
      for (const row of rows || []) {
        const key = normalizeHouse(row.house_key);
        if (key && Number.isFinite(Number(row.points))) {
          totals[key] = Math.trunc(Number(row.points));
        }
      }
    } catch {}
  }

  return totals;
}

async function persistHouseSnapshot(): Promise<void> {
  if (!dbReady || !Database?.query) return;
  const totals = await readHouseCupStandings();
  for (const h of ["gryffindor", "slytherin", "ravenclaw", "hufflepuff"] as HouseKey[]) {
    try {
      await Database.query(
        `INSERT INTO dg_discord_house_snapshot (house_key, points)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE points = VALUES(points)`,
        [h, totals[h]]
      );
    } catch {}
  }
}

async function buildLiveStatusSnapshot(): Promise<Record<string, unknown>> {
  const players = PlayerManager.getAll?.() ?? [];
  const roster = [];
  for (const p of players) {
    roster.push({
      id: p.id,
      name: resolvePlayerName(p),
      house: await resolvePlayerHouse(p),
    });
  }
  const houses = await readHouseCupStandings();
  return {
    online: true,
    serverName: runtimeConfig.serverDisplayName,
    playerCount: players.length,
    roster,
    houses,
    timestamp: new Date().toISOString(),
  };
}

function findPlayerByQuery(query: string): BridgePlayer | null {
  const players = PlayerManager.getAll?.() ?? [];
  const clean = String(query || "").trim();
  if (!clean) return null;
  const numericId = Number(clean);
  if (Number.isInteger(numericId) && numericId >= 0) {
    const byId = players.find((p) => p.id === numericId);
    if (byId) return byId;
  }
  const lower = clean.toLowerCase();
  return (
    players.find((p) => resolvePlayerName(p).toLowerCase() === lower) ||
    players.find((p) => resolvePlayerName(p).toLowerCase().includes(lower)) ||
    null
  );
}

async function executeStaffCommand(
  commandType: string,
  payload: Record<string, any>,
  issuedByDiscordId: string,
  issuedByTag: string
): Promise<{ ok: boolean; message: string; data?: Record<string, unknown> }> {
  const cmd = String(commandType || "").toLowerCase();
  const notifyApi = ScrollNotify || safeImport("dg-notify") || safeImport("hmp-notify");

  if (cmd === "decree") {
    const title = String(payload.title || "Proclamation of the Headmaster").slice(0, 96);
    const message = String(payload.message || "").slice(0, 260);
    if (!message) return { ok: false, message: "Decree message cannot be empty." };

    let delivered = 0;
    if (notifyApi?.decree) {
      delivered = await notifyApi.decree(title, message);
    } else {
      for (const p of PlayerManager.getAll?.() ?? []) {
        sendPlayerScroll(p, title, message, "decree");
        delivered++;
      }
    }
    await pushAudit("staff", "Headmaster Decree Dispatched", `**${title}** — ${message}`, issuedByTag, [
      { name: "Issued By", value: `<@${issuedByDiscordId}>`, inline: true },
      { name: "Recipients", value: String(delivered), inline: true },
    ]);
    return { ok: true, message: `Decree delivered to ${delivered} online student(s).`, data: { delivered } };
  }

  if (cmd === "howler") {
    const target = findPlayerByQuery(String(payload.target || ""));
    const message = String(payload.message || "").slice(0, 240);
    if (!target) return { ok: false, message: `Player "${payload.target}" is not currently online.` };
    if (!message) return { ok: false, message: "Howler message cannot be empty." };

    if (notifyApi?.howler) {
      await notifyApi.howler(target, String(payload.title || "A Howler Has Arrived!"), message);
    } else {
      sendPlayerScroll(target, "A Howler Has Arrived!", message, "error");
    }
    const targetName = resolvePlayerName(target);
    await pushAudit("staff", "Howler Dispatched", `Sent crimson Howler to **${targetName}**: ${message}`, issuedByTag, [
      { name: "Staff", value: `<@${issuedByDiscordId}>`, inline: true },
      { name: "Target", value: `${targetName} (#${target.id})`, inline: true },
    ]);
    return { ok: true, message: `Howler sent to ${targetName} (#${target.id}).` };
  }

  if (cmd === "points") {
    const house = normalizeHouse(payload.house);
    const delta = Math.trunc(Number(payload.amount));
    const reason = String(payload.reason || "Discord Staff Award").slice(0, 140);
    if (!house) return { ok: false, message: "Invalid house. Use gryffindor, slytherin, ravenclaw, or hufflepuff." };
    if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 5000) {
      return { ok: false, message: "Point amount must be a non-zero integer between -5000 and 5000." };
    }

    if (typeof Houses?.points?.add === "function") {
      await Houses.points.add(house, delta, { resource: RESOURCE_NAME, reason, actor: issuedByTag });
    } else if (typeof Houses?.points?.award === "function") {
      await Houses.points.award(house, delta, reason);
    } else if (dbReady && Database?.query) {
      await Database.query(
        `INSERT INTO dg_discord_house_snapshot (house_key, points) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE points = points + VALUES(points)`,
        [house, delta]
      );
    }

    await persistHouseSnapshot();
    const standings = await readHouseCupStandings();
    const verb = delta > 0 ? `+${delta} Points Awarded` : `${delta} Points Deducted`;
    const houseLabel = house.charAt(0).toUpperCase() + house.slice(1);

    if (notifyApi?.broadcast) {
      await notifyApi.broadcast({
        title: `${verb} · ${houseLabel}`,
        description: reason,
        tone: "house",
        house,
        sender: "Hogwarts House Cup",
      });
    }

    await pushAudit("staff", `House Points Updated (${houseLabel})`, `**${verb}** — ${reason}`, issuedByTag, [
      { name: "House", value: houseLabel, inline: true },
      { name: "New Total", value: String(standings[house]), inline: true },
      { name: "Staff", value: `<@${issuedByDiscordId}>`, inline: true },
    ]);
    broadcastSse("houseCup", { houses: standings });
    return { ok: true, message: `${houseLabel} updated (${delta > 0 ? "+" : ""}${delta}). New total: ${standings[house]}.`, data: { houses: standings } };
  }

  if (cmd === "kick") {
    const target = findPlayerByQuery(String(payload.target || ""));
    const reason = String(payload.reason || "Removed by Hogwarts Staff via Discord").slice(0, 180);
    if (!target) return { ok: false, message: `Player "${payload.target}" is not online.` };
    const targetCharId = resolveCharacterId(target);
    const linkedTargetDiscord = target.discordId || (targetCharId ? await getLinkedDiscordId(targetCharId) : null);
    if (linkedTargetDiscord && runtimeConfig.rootAdminDiscordIds.includes(linkedTargetDiscord)) {
      return { ok: false, message: "Root Admin is protected from remote kicks." };
    }
    const targetName = resolvePlayerName(target);
    const bansApi = Headmaster?.bans || safeImport("hmp-headmaster")?.bans;
    if (typeof bansApi?.kick === "function") {
      bansApi.kick({
        targetId: target.id,
        reason,
        actorName: issuedByTag,
        actorDiscordId: issuedByDiscordId,
      });
    } else if (typeof target.kick === "function") {
      target.kick(reason);
    }
    await pushAudit("staff", "Student Kicked", `**${targetName}** was kicked via Discord. Reason: ${reason}`, issuedByTag, [
      { name: "Staff", value: `<@${issuedByDiscordId}>`, inline: true },
      { name: "Player", value: `${targetName} (#${target.id})`, inline: true },
    ]);
    return { ok: true, message: `Kicked ${targetName} (#${target.id}).` };
  }

  if (cmd === "ban") {
    const targetQuery = String(payload.target || "").trim();
    const reason = String(payload.reason || "Banned by Hogwarts Staff via Discord").slice(0, 180);
    if (!targetQuery) return { ok: false, message: "Target player or Discord ID is required." };

    const online = findPlayerByQuery(targetQuery);
    let targetDiscordId = /^\d{17,20}$/.test(targetQuery) ? targetQuery : "";
    let targetDisplayName = online ? resolvePlayerName(online) : targetQuery;

    if (!targetDiscordId && online) {
      if (online.discordId && /^\d{17,20}$/.test(String(online.discordId))) {
        targetDiscordId = String(online.discordId);
      } else {
        const charId = resolveCharacterId(online);
        if (charId) {
          targetDiscordId = (await getLinkedDiscordId(charId)) || "";
        }
      }
    }

    if (!targetDiscordId && dbReady && Database?.query) {
      try {
        const rows = await Database.query(
          "SELECT discord_id, character_name FROM dg_discord_links WHERE LOWER(character_name) = LOWER(?) LIMIT 1",
          [targetQuery]
        );
        if (rows?.[0]?.discord_id) {
          targetDiscordId = String(rows[0].discord_id);
          targetDisplayName = String(rows[0].character_name || targetDisplayName);
        }
      } catch {}
    }

    if (!targetDiscordId) {
      if (online && typeof online.kick === "function") {
        online.kick(`Banned: ${reason}`);
        return {
          ok: false,
          message: `Kicked online player ${targetDisplayName}, but no linked Discord ID was found to persist a ban in hmp-headmaster.`,
        };
      }
      return {
        ok: false,
        message: `Could not resolve a Discord ID for "${targetQuery}". Pass a 17-20 digit Discord ID or an online/linked character name.`,
      };
    }

    if (runtimeConfig.rootAdminDiscordIds.includes(targetDiscordId)) {
      return { ok: false, message: "Root Admin cannot be banned." };
    }

    const bansApi = Headmaster?.bans || safeImport("hmp-headmaster")?.bans;
    if (typeof bansApi?.ban === "function") {
      const banRes = bansApi.ban({
        discordId: targetDiscordId,
        playerName: targetDisplayName,
        reason,
        actorName: issuedByTag,
        actorDiscordId: issuedByDiscordId,
      });
      if (banRes && banRes.ok === false) {
        return { ok: false, message: String(banRes.error || "Headmaster rejected ban request.") };
      }
    }

    if (online && typeof online.kick === "function") {
      online.kick(`Banned: ${reason}`);
    }
    await pushAudit("staff", "Ban Enforced", `**${targetDisplayName}** (${targetDiscordId}) banned via Discord. Reason: ${reason}`, issuedByTag, [
      { name: "Staff", value: `<@${issuedByDiscordId}>`, inline: true },
      { name: "Reason", value: reason, inline: false },
    ]);
    return {
      ok: true,
      message: `Ban recorded for ${targetDisplayName} (${targetDiscordId})${online ? " and kicked from server" : ""}.`,
    };
  }

  if (cmd === "unban") {
    const targetId = String(payload.target || "").trim();
    if (!/^\d{17,20}$/.test(targetId)) {
      return { ok: false, message: "Valid 17-20 digit Discord ID is required." };
    }
    const bansApi = Headmaster?.bans || safeImport("hmp-headmaster")?.bans;
    if (typeof bansApi?.unban === "function") {
      const unbanRes = bansApi.unban({
        discordId: targetId,
        actorName: issuedByTag,
        actorDiscordId: issuedByDiscordId,
      });
      if (unbanRes && unbanRes.ok === false) {
        return { ok: false, message: String(unbanRes.error || "Ban record not found.") };
      }
    }
    await pushAudit("staff", "Ban Lifted", `Unbanned Discord ID **${targetId}** via Discord.`, issuedByTag, [
      { name: "Staff", value: `<@${issuedByDiscordId}>`, inline: true },
    ]);
    return { ok: true, message: `Unbanned Discord ID ${targetId}.` };
  }

  if (cmd === "syncroles") {
    if (!dbReady || !Database?.query) {
      return { ok: false, message: "MySQL is unavailable; cannot fetch linked students." };
    }
    const rows = await Database.query(
      "SELECT discord_id, character_id, character_name, house, year_level FROM dg_discord_links"
    );
    return { ok: true, message: `Returned ${(rows || []).length} linked student record(s) for role sync.`, data: { links: rows || [] } };
  }

  return { ok: false, message: `Unknown command type: ${cmd}` };
}

async function generateLinkCodeForPlayer(player: BridgePlayer): Promise<string | null> {
  if (!dbReady || !Database?.query) return null;
  const charId = resolveCharacterId(player);
  if (!charId) return null;

  const bytes = crypto.randomBytes(6);
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += LINK_ALPHABET[bytes[i] % LINK_ALPHABET.length];
  }

  const charName = resolvePlayerName(player);
  const house = await resolvePlayerHouse(player);
  const expiryMins = Math.max(2, Math.min(60, Math.trunc(runtimeConfig.linking.codeExpiryMinutes || 10)));

  await Database.query("DELETE FROM dg_discord_link_codes WHERE character_id = ? AND consumed = 0", [charId]);
  await Database.query(
    `INSERT INTO dg_discord_link_codes (code, character_id, character_name, house, expires_at, consumed)
     VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), 0)`,
    [code, charId, charName, house, expiryMins]
  );

  return code;
}

async function verifyLinkCode(
  codeRaw: string,
  discordId: string,
  discordTag: string
): Promise<{ ok: boolean; message: string; house?: HouseKey | null; characterName?: string; characterId?: number }> {
  if (!dbReady || !Database?.query) {
    return { ok: false, message: "Database unavailable on game server." };
  }
  const cleanCode = String(codeRaw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  if (cleanCode.length !== 6) {
    return { ok: false, message: "Link codes are 6 characters long. Run /link in-game first." };
  }
  if (!/^\d{17,20}$/.test(discordId)) {
    return { ok: false, message: "Invalid Discord ID." };
  }

  const rows = await Database.query(
    `SELECT code, character_id, character_name, house
     FROM dg_discord_link_codes
     WHERE code = ? AND consumed = 0 AND expires_at > NOW()
     LIMIT 1`,
    [cleanCode]
  );

  const match = Array.isArray(rows) ? rows[0] : null;
  if (!match) {
    return { ok: false, message: "Code is invalid or expired. Type /link in-game to generate a fresh code." };
  }

  const consumeRes = await Database.query(
    "UPDATE dg_discord_link_codes SET consumed = 1 WHERE code = ? AND consumed = 0 AND expires_at > NOW()",
    [cleanCode]
  );
  if (consumeRes && typeof consumeRes.affectedRows === "number" && consumeRes.affectedRows === 0) {
    return { ok: false, message: "This link code has already been redeemed or expired." };
  }

  // Clear any prior link for either this character_id OR this discord_id to prevent uq_dg_discord_id collisions
  await Database.query(
    "DELETE FROM dg_discord_links WHERE character_id = ? OR discord_id = ?",
    [match.character_id, discordId]
  );
  await Database.query(
    `INSERT INTO dg_discord_links (character_id, discord_id, character_name, house)
     VALUES (?, ?, ?, ?)`,
    [match.character_id, discordId, match.character_name, match.house]
  );

  const house = normalizeHouse(match.house);
  const onlinePlayer = (PlayerManager.getAll?.() ?? []).find(
    (p) => resolveCharacterId(p) === Number(match.character_id)
  );
  if (onlinePlayer) {
    sendPlayerScroll(
      onlinePlayer,
      "Discord Account Linked",
      `Linked to ${discordTag}. Your Hogwarts House Discord role has been synchronized.`,
      house ? "house" : "success",
      house
    );
  }

  await pushAudit("linking", "Student Account Linked", `**${match.character_name}** linked with <@${discordId}>.`, discordTag, [
    { name: "Character ID", value: String(match.character_id), inline: true },
    { name: "House", value: house ? house.charAt(0).toUpperCase() + house.slice(1) : "Unsorted", inline: true },
  ]);

  return {
    ok: true,
    message: `Successfully linked ${match.character_name}!`,
    house,
    characterName: String(match.character_name),
    characterId: Number(match.character_id),
  };
}

async function drainOfflineActionQueue(): Promise<void> {
  if (!runtimeConfig.mysqlFallback.enabled || !dbReady || !Database?.query) return;
  try {
    const pending = await Database.query(
      `SELECT id, command_type, payload_json, issued_by_discord_id, issued_by_tag
       FROM dg_discord_action_queue
       WHERE status = 'pending'
       ORDER BY id ASC
       LIMIT 15`
    );
    if (!Array.isArray(pending) || pending.length === 0) return;

    for (const row of pending) {
      let parsedPayload: Record<string, any> = {};
      try {
        parsedPayload = JSON.parse(String(row.payload_json || "{}"));
      } catch {}

      const result = await executeStaffCommand(
        String(row.command_type),
        parsedPayload,
        String(row.issued_by_discord_id),
        String(row.issued_by_tag || "Staff")
      );

      await Database.query(
        `UPDATE dg_discord_action_queue
         SET status = ?, result_message = ?, executed_at = NOW()
         WHERE id = ?`,
        [result.ok ? "completed" : "failed", result.message.slice(0, 255), row.id]
      );

      broadcastSse("queueDrained", {
        id: row.id,
        commandType: row.command_type,
        ok: result.ok,
        message: result.message,
        issuedByDiscordId: row.issued_by_discord_id,
      });
    }
  } catch (err) {
    logger.warn(`Offline queue drain warning: ${String(err)}`);
  }
}

function verifyHmacRequest(req: http.IncomingMessage, rawBody: string): boolean {
  const secret = getBridgeSecret();
  if (!secret) return false;

  const tsHeader = String(req.headers["x-dg-timestamp"] || "");
  const sigHeader = String(req.headers["x-dg-signature"] || "");
  const ts = Number(tsHeader);
  const windowMs = Math.max(10_000, Number(runtimeConfig.bridge.replayWindowMs || 60_000));

  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > windowMs) {
    return false;
  }

  const method = String(req.method || "GET").toUpperCase();
  const reqPath = String(req.url || "/").split("?")[0];
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${tsHeader}.${method}.${reqPath}.${rawBody}`)
    .digest("hex");

  const sigBuf = Buffer.from(sigHeader, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function startBridgeHttpServer(): void {
  if (httpServer) return;
  const host = runtimeConfig.bridge.host || "127.0.0.1";
  const port = Math.max(1024, Math.min(65535, Math.trunc(runtimeConfig.bridge.port || 4190)));

  if (!getBridgeSecret()) {
    logger.warn(
      `Bridge secret is empty! Set ${runtimeConfig.bridge.secretEnvVar} in your environment or data/${RESOURCE_NAME}.json (min 16 chars) before connecting the Discord bot.`
    );
  }

  httpServer = http.createServer(async (req, res) => {
    const reqPath = String(req.url || "/").split("?")[0];
    const method = String(req.method || "GET").toUpperCase();

    try {
      const rawBody = method === "POST" || method === "PUT" ? await readRequestBody(req) : "";
      if (!verifyHmacRequest(req, rawBody)) {
        writeJson(res, 401, { ok: false, error: "Unauthorized bridge request." });
        return;
      }

      if (method === "GET" && reqPath === "/health") {
        writeJson(res, 200, { ok: true, resource: RESOURCE_NAME, dbReady, uptimeSec: Math.round(process.uptime()) });
        return;
      }

      if (method === "GET" && reqPath === "/status") {
        const snapshot = await buildLiveStatusSnapshot();
        writeJson(res, 200, { ok: true, ...snapshot });
        return;
      }

      if (method === "GET" && reqPath === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(`event: connected\ndata: ${JSON.stringify({ resource: RESOURCE_NAME })}\n\n`);
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        res.on("error", () => sseClients.delete(res));
        return;
      }

      if (method === "POST" && reqPath === "/command") {
        const body = JSON.parse(rawBody || "{}");
        const result = await executeStaffCommand(
          String(body.commandType || ""),
          body.payload || {},
          String(body.issuedByDiscordId || ""),
          String(body.issuedByTag || "Discord Staff")
        );
        writeJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (method === "POST" && reqPath === "/link/verify") {
        const body = JSON.parse(rawBody || "{}");
        const result = await verifyLinkCode(
          String(body.code || ""),
          String(body.discordId || ""),
          String(body.discordTag || "Discord User")
        );
        writeJson(res, result.ok ? 200 : 400, result);
        return;
      }

      writeJson(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      writeJson(res, 500, { ok: false, error: String(err) });
    }
  });

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    logger.error(`Discord Bridge HTTP server error on ${host}:${port}: ${err.message} (${err.code || "ERR"})`);
    httpServer = null;
  });

  httpServer.listen(port, host, () => {
    logger.info(`Discord Bridge HTTP/SSE server listening on http://${host}:${port}`);
  });

  sseHeartbeatTimer = setInterval(() => {
    broadcastSse("ping", { ts: Date.now() });
  }, 25_000);
}

async function syncPlayerRoles(player: BridgePlayer, houseOverride?: HouseKey): Promise<void> {
  if (!dbReady || !Database?.query) return;
  const charId = resolveCharacterId(player);
  if (!charId) return;
  const house = houseOverride || (await resolvePlayerHouse(player));
  await Database.query("UPDATE dg_discord_links SET house = ? WHERE character_id = ?", [house, charId]);
  const rows = await Database.query("SELECT discord_id FROM dg_discord_links WHERE character_id = ? LIMIT 1", [charId]);
  const discordId = rows?.[0]?.discord_id;
  if (discordId) {
    broadcastSse("roleSync", {
      discordId: String(discordId),
      characterId: charId,
      characterName: resolvePlayerName(player),
      house,
    });
  }
}

async function getLinkedDiscordId(characterId: number): Promise<string | null> {
  if (!dbReady || !Database?.query) return null;
  const rows = await Database.query("SELECT discord_id FROM dg_discord_links WHERE character_id = ? LIMIT 1", [
    Math.trunc(characterId),
  ]);
  return rows?.[0]?.discord_id ? String(rows[0].discord_id) : null;
}

// Game lifecycle & cross-resource event listeners
Events.on("playerConnect", (player: BridgePlayer) => {
  if (!player) return;
  void pushAudit("joins", "Student Connected", `**${resolvePlayerName(player)}** joined ${runtimeConfig.serverDisplayName}.`, "hmp-core", [
    { name: "Player ID", value: `#${player.id}`, inline: true },
  ]);
});

Events.on("playerDisconnect", (player: BridgePlayer) => {
  if (!player) return;
  void pushAudit("joins", "Student Disconnected", `**${resolvePlayerName(player)}** left Hogwarts.`, "hmp-core", [
    { name: "Player ID", value: `#${player.id}`, inline: true },
  ]);
});

Events.on("hmp:house:changed", (payload: any) => {
  const player: BridgePlayer | undefined = payload?.player;
  const house = normalizeHouse(payload?.house);
  if (!player || !house) return;
  const houseLabel = house.charAt(0).toUpperCase() + house.slice(1);
  void syncPlayerRoles(player, house);
  void pushAudit("sorting", "Sorting Hat House Assignment", `**${resolvePlayerName(player)}** was sorted into **${houseLabel}**!`, "hmp-sorting", [
    { name: "House", value: houseLabel, inline: true },
  ]);
});

Events.on("chatCommand", async (player: BridgePlayer, _msg: string, rawCmd: string) => {
  const cmd = String(rawCmd || "").toLowerCase();
  const linkCmd = (runtimeConfig.linking.linkCommand || "link").toLowerCase();
  const unlinkCmd = (runtimeConfig.linking.unlinkCommand || "unlink").toLowerCase();

  if (cmd === linkCmd) {
    const code = await generateLinkCodeForPlayer(player);
    if (!code) {
      sendPlayerScroll(player, "Discord Linking Unavailable", "Make sure your character is loaded and MySQL is connected.", "warning");
      return;
    }
    const mins = runtimeConfig.linking.codeExpiryMinutes || 10;
    sendPlayerScroll(
      player,
      `Discord Link Code: ${code}`,
      `Run /link ${code} in Discord within ${mins} minutes to link your student profile and receive your House role.`,
      "magic"
    );
    player.sendChat?.(`[Discord] Your 6-character link code is: ${code} (expires in ${mins}m). Type /link ${code} in Discord.`);
    return;
  }

  if (cmd === unlinkCmd) {
    if (!dbReady || !Database?.query) return;
    const charId = resolveCharacterId(player);
    if (!charId) return;
    await Database.query("DELETE FROM dg_discord_links WHERE character_id = ?", [charId]);
    sendPlayerScroll(player, "Discord Unlinked", "Your in-game character has been unlinked from Discord.", "info");
    return;
  }
});

Events.on("resourceStart", async (startedName?: string) => {
  if (startedName && startedName !== RESOURCE_NAME) return;
  runtimeConfig = loadRuntimeConfig();
  if (!runtimeConfig.enabled) return;

  await initDatabase();
  startBridgeHttpServer();
  await persistHouseSnapshot();
  await drainOfflineActionQueue();

  const drainMs = Math.max(5, runtimeConfig.mysqlFallback.drainQueueIntervalSeconds || 10) * 1000;
  queueDrainTimer = setInterval(() => void drainOfflineActionQueue(), drainMs);

  const snapMs = Math.max(15, runtimeConfig.mysqlFallback.houseSnapshotIntervalSeconds || 30) * 1000;
  houseSnapshotTimer = setInterval(() => void persistHouseSnapshot(), snapMs);
});

Events.on("resourceStop", (stoppedName?: string) => {
  if (stoppedName && stoppedName !== RESOURCE_NAME) return;
  if (queueDrainTimer) clearInterval(queueDrainTimer);
  if (houseSnapshotTimer) clearInterval(houseSnapshotTimer);
  if (sseHeartbeatTimer) clearInterval(sseHeartbeatTimer);
  for (const res of sseClients) {
    try { res.end(); } catch {}
  }
  sseClients.clear();
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
});

Exports.register("pushAudit", pushAudit);
Exports.register("syncPlayerRoles", syncPlayerRoles);
Exports.register("getLinkedDiscordId", getLinkedDiscordId);
Exports.register("getBridgeStatus", () => ({
  online: Boolean(httpServer),
  dbReady,
  sseClients: sseClients.size,
  host: runtimeConfig.bridge.host,
  port: runtimeConfig.bridge.port,
}));
