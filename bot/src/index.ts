import "dotenv/config";
import {
  ActivityType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  GuildMember,
  Message,
  TextChannel,
} from "discord.js";
import { ArcaneBridgeClient } from "./bridgeClient";
import { HouseKey, OfflineFallbackDb } from "./db";

const DEFAULT_SERVER_NAME = "Hogwarts ArcaneMP RP";
const EMBED_ACCENT = 0xC8A252;
const STATUS_REFRESH_MS = 45 * 1000;

const ROOT_ADMIN_IDS = new Set(
  (process.env.ROOT_ADMIN_DISCORD_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const STAFF_ROLE_IDS = new Set(
  (process.env.STAFF_ROLE_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const HOUSE_ROLE_MAP: Record<HouseKey, string> = {
  gryffindor: (process.env.ROLE_GRYFFINDOR_ID || "").trim(),
  slytherin: (process.env.ROLE_SLYTHERIN_ID || "").trim(),
  ravenclaw: (process.env.ROLE_RAVENCLAW_ID || "").trim(),
  hufflepuff: (process.env.ROLE_HUFFLEPUFF_ID || "").trim(),
};

const VERIFIED_ROLE_ID = (process.env.ROLE_VERIFIED_STUDENT_ID || "").trim();

const bridgeUrl = process.env.BRIDGE_URL || "http://127.0.0.1:4190";
const bridgeSecret = process.env.BRIDGE_SECRET || "";
const botToken = process.env.DISCORD_BOT_TOKEN || "";

if (!botToken) {
  console.error("Missing DISCORD_BOT_TOKEN in .env");
  process.exit(1);
}
if (bridgeSecret.length < 16) {
  console.error("BRIDGE_SECRET in .env must be at least 16 characters and match data/dg-discord.json");
  process.exit(1);
}

const bridge = new ArcaneBridgeClient(bridgeUrl, bridgeSecret);
const fallbackDb = new OfflineFallbackDb();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

let pinnedStatusMessageId: string | null = null;
let pinnedCupMessageId: string | null = null;

function isAuthorizedStaff(interaction: ChatInputCommandInteraction): boolean {
  if (ROOT_ADMIN_IDS.has(interaction.user.id)) return true;
  const member = interaction.member as GuildMember | { roles?: string[] } | null;
  if (!member || !member.roles) return false;
  if (Array.isArray(member.roles)) {
    for (const roleId of STAFF_ROLE_IDS) {
      if (member.roles.includes(roleId)) return true;
    }
    return false;
  }
  const cache = (member as GuildMember).roles?.cache;
  if (!cache) return false;
  for (const roleId of STAFF_ROLE_IDS) {
    if (cache.has(roleId)) return true;
  }
  return false;
}

function buildProgressBar(value: number, max: number): string {
  const safeMax = Math.max(1, max);
  const filled = Math.round((Math.max(0, value) / safeMax) * 12);
  return "█".repeat(filled) + "░".repeat(Math.max(0, 12 - filled));
}

function buildHouseCupEmbed(houses: Record<HouseKey, number>, offlineMode: boolean): EmbedBuilder {
  const ordered = (["gryffindor", "slytherin", "ravenclaw", "hufflepuff"] as HouseKey[])
    .map((k) => ({ key: k, label: k.charAt(0).toUpperCase() + k.slice(1), pts: houses[k] || 0 }))
    .sort((a, b) => b.pts - a.pts);

  const top = Math.max(1, ordered[0]?.pts || 1);
  const lines = ordered.map(
    (row, idx) =>
      `**${idx + 1}. ${row.label}** — **${row.pts.toLocaleString()} pts**\n\`${buildProgressBar(row.pts, top)}\``
  );

  return new EmbedBuilder()
    .setTitle("Hogwarts House Cup Standings")
    .setColor(EMBED_ACCENT)
    .setDescription(lines.join("\n\n"))
    .setFooter({
      text: offlineMode
        ? "Cached MySQL Snapshot · Game Server Offline"
        : "Live Sync via dg-discord Bridge",
    })
    .setTimestamp();
}

async function applyHouseRoleToMember(discordId: string, house: HouseKey | null): Promise<boolean> {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return false;
  try {
    const guild = await client.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordId);
    if (!member) return false;

    const allHouseRoleIds = Object.values(HOUSE_ROLE_MAP).filter(Boolean);
    const targetHouseRoleId = house ? HOUSE_ROLE_MAP[house] : "";

    for (const rid of allHouseRoleIds) {
      if (rid && rid !== targetHouseRoleId && member.roles.cache.has(rid)) {
        await member.roles.remove(rid, "Hogwarts House role sync");
      }
    }
    if (targetHouseRoleId && !member.roles.cache.has(targetHouseRoleId)) {
      await member.roles.add(targetHouseRoleId, "Hogwarts House role sync");
    }
    if (VERIFIED_ROLE_ID && !member.roles.cache.has(VERIFIED_ROLE_ID)) {
      await member.roles.add(VERIFIED_ROLE_ID, "Hogwarts account verified");
    }
    return true;
  } catch (err) {
    console.warn(`Role sync skipped for ${discordId}:`, err);
    return false;
  }
}

async function upsertPinnedEmbed(
  channelId: string,
  cachedMessageId: string | null,
  embed: EmbedBuilder
): Promise<string | null> {
  if (!channelId) return null;
  try {
    const channel = (await client.channels.fetch(channelId)) as TextChannel | null;
    if (!channel?.isTextBased()) return null;

    if (cachedMessageId) {
      try {
        const existing = await channel.messages.fetch(cachedMessageId);
        await existing.edit({ embeds: [embed] });
        return existing.id;
      } catch {}
    }

    const recent = await channel.messages.fetch({ limit: 15 });
    const botMsg = recent.find(
      (m: Message) =>
        m.author.id === client.user?.id &&
        (m.embeds[0]?.title === embed.data.title ||
          (Boolean(embed.data.title?.endsWith("— Server Status")) &&
            Boolean(m.embeds[0]?.title?.endsWith("— Server Status"))))
    );
    if (botMsg) {
      await botMsg.edit({ embeds: [embed] });
      return botMsg.id;
    }

    const created = await channel.send({ embeds: [embed] });
    return created.id;
  } catch {
    return null;
  }
}

async function refreshLiveStatusAndCup(): Promise<void> {
  const res = await bridge.request("GET", "/status");
  const isLive = Boolean(res.ok && !res.offline);

  const houses =
    (isLive && res.houses) ||
    (await fallbackDb.getHouseCupSnapshot()) || {
      gryffindor: 0,
      slytherin: 0,
      ravenclaw: 0,
      hufflepuff: 0,
    };

  const playerCount = isLive ? Number(res.playerCount || 0) : 0;
  client.user?.setActivity(
    isLive ? `${playerCount} wizards at Hogwarts` : "Hogwarts · Offline Fallback",
    { type: ActivityType.Watching }
  );

  const statusEmbed = new EmbedBuilder()
    .setTitle(`${isLive ? res.serverName || DEFAULT_SERVER_NAME : DEFAULT_SERVER_NAME} — Server Status`)
    .setColor(isLive ? 0x2f9e68 : 0xd97706)
    .addFields(
      { name: "Server State", value: isLive ? "Online (Live Bridge)" : "Offline (MySQL Fallback)", inline: true },
      { name: "Students Online", value: isLive ? String(playerCount) : "0", inline: true },
      { name: "Bridge Transport", value: isLive ? "HMAC-SSE Connected" : "Queue Mode Active", inline: true }
    )
    .setFooter({ text: "Auto-updates via dg-discord" })
    .setTimestamp();

  pinnedStatusMessageId = await upsertPinnedEmbed(
    process.env.CHANNEL_STATUS_ID || "",
    pinnedStatusMessageId,
    statusEmbed
  );

  const cupEmbed = buildHouseCupEmbed(houses, !isLive);
  pinnedCupMessageId = await upsertPinnedEmbed(
    process.env.CHANNEL_HOUSE_CUP_ID || "",
    pinnedCupMessageId,
    cupEmbed
  );
}

async function dispatchAuditEmbed(data: any): Promise<void> {
  const isMod = data.category === "staff";
  const channelId = (isMod && process.env.CHANNEL_MOD_LOG_ID) || process.env.CHANNEL_AUDIT_LOG_ID || "";
  if (!channelId) return;

  const colorMap: Record<string, number> = {
    joins: 0x2f9e68,
    sorting: 0x4c82d4,
    academy: 0xc8a252,
    ollivanders: 0x9c6ade,
    staff: 0xc4453b,
    linking: 0x38bdf8,
  };

  try {
    const channel = (await client.channels.fetch(channelId)) as TextChannel | null;
    if (!channel?.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setTitle(String(data.title || "Server Event"))
      .setDescription(String(data.description || ""))
      .setColor(colorMap[String(data.category)] || EMBED_ACCENT)
      .setFooter({ text: `Source: ${data.actor || "dg-discord"}` })
      .setTimestamp();

    if (Array.isArray(data.fields) && data.fields.length > 0) {
      embed.addFields(
        data.fields.slice(0, 6).map((f: any) => ({
          name: String(f.name || "Detail"),
          value: String(f.value || "-"),
          inline: f.inline !== false,
        }))
      );
    }

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.warn("Could not post audit embed:", err);
  }
}

async function handleStaffRemoteCommand(
  interaction: ChatInputCommandInteraction,
  commandType: string,
  payload: Record<string, unknown>,
  allowOfflineQueue: boolean
): Promise<void> {
  if (!isAuthorizedStaff(interaction)) {
    await interaction.reply({ content: "You do not have Hogwarts Staff permissions for this command.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: false });
  const res = await bridge.request("POST", "/command", {
    commandType,
    payload,
    issuedByDiscordId: interaction.user.id,
    issuedByTag: interaction.user.tag,
  });

  if (res.offline && allowOfflineQueue && fallbackDb.enabled) {
    const queueId = await fallbackDb.enqueueStaffAction(commandType, payload, interaction.user.id, interaction.user.tag);
    const queuedEmbed = new EmbedBuilder()
      .setTitle("Server Offline — Action Queued in MySQL")
      .setColor(0xd97706)
      .setDescription(`Command **/${commandType}** was saved as Queue ID **#${queueId}** and will execute automatically as soon as the ArcaneMP server comes online.`)
      .setTimestamp();
    await interaction.editReply({ embeds: [queuedEmbed] });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(res.ok ? `/${commandType} Executed` : `/${commandType} Failed`)
    .setColor(res.ok ? 0x2f9e68 : 0xc4453b)
    .setDescription(String(res.message || res.error || "No response from bridge."))
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;

  try {
  if (cmd === "status") {
    await interaction.deferReply();
    const res = await bridge.request("GET", "/status");
    const live = Boolean(res.ok && !res.offline);
    const embed = new EmbedBuilder()
      .setTitle(live ? `${res.serverName || DEFAULT_SERVER_NAME} — Online` : `${DEFAULT_SERVER_NAME} — Offline`)
      .setColor(live ? 0x2f9e68 : 0xd97706)
      .setDescription(
        live
          ? `**${res.playerCount}** student(s) currently connected to Hogwarts.`
          : "The ArcaneMP server is currently offline or restarting. MySQL fallback is active."
      )
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (cmd === "housecup") {
    await interaction.deferReply();
    const res = await bridge.request("GET", "/status");
    const live = Boolean(res.ok && !res.offline && res.houses);
    const houses = live
      ? res.houses
      : (await fallbackDb.getHouseCupSnapshot()) || { gryffindor: 0, slytherin: 0, ravenclaw: 0, hufflepuff: 0 };
    await interaction.editReply({ embeds: [buildHouseCupEmbed(houses, !live)] });
    return;
  }

  if (cmd === "online") {
    await interaction.deferReply({ ephemeral: true });
    const res = await bridge.request("GET", "/status");
    if (!res.ok || res.offline) {
      await interaction.editReply("Server is currently offline.");
      return;
    }
    const roster: Array<{ id: number; name: string; house?: string }> = res.roster || [];
    let description = "No students are currently online.";
    if (roster.length > 0) {
      const formatted = roster.map((p) => `• **#${p.id}** ${p.name} (${p.house || "Unsorted"})`);
      let acc = "";
      let shown = 0;
      for (const line of formatted) {
        if (acc.length + line.length + 1 > 3800) break;
        acc += (acc ? "\n" : "") + line;
        shown++;
      }
      if (shown < roster.length) {
        acc += `\n…and ${roster.length - shown} more student(s).`;
      }
      description = acc;
    }
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle(`Online Students (${roster.length})`).setColor(EMBED_ACCENT).setDescription(description)],
    });
    return;
  }

  if (cmd === "decree") {
    await handleStaffRemoteCommand(
      interaction,
      "decree",
      {
        title: interaction.options.getString("title", true),
        message: interaction.options.getString("message", true),
      },
      true
    );
    return;
  }

  if (cmd === "howler") {
    await handleStaffRemoteCommand(
      interaction,
      "howler",
      {
        target: interaction.options.getString("player", true),
        message: interaction.options.getString("message", true),
      },
      false
    );
    return;
  }

  if (cmd === "points") {
    await handleStaffRemoteCommand(
      interaction,
      "points",
      {
        house: interaction.options.getString("house", true),
        amount: interaction.options.getInteger("amount", true),
        reason: interaction.options.getString("reason", true),
      },
      true
    );
    return;
  }

  if (cmd === "kick") {
    await handleStaffRemoteCommand(
      interaction,
      "kick",
      {
        target: interaction.options.getString("player", true),
        reason: interaction.options.getString("reason", true),
      },
      false
    );
    return;
  }

  if (cmd === "ban") {
    await handleStaffRemoteCommand(
      interaction,
      "ban",
      {
        target: interaction.options.getString("target", true),
        reason: interaction.options.getString("reason", true),
      },
      true
    );
    return;
  }

  if (cmd === "unban") {
    await handleStaffRemoteCommand(
      interaction,
      "unban",
      {
        target: interaction.options.getString("discord_id", true),
      },
      true
    );
    return;
  }

  if (cmd === "link") {
    await interaction.deferReply({ ephemeral: true });
    const code = interaction.options.getString("code", true);
    let result: any = await bridge.request("POST", "/link/verify", {
      code,
      discordId: interaction.user.id,
      discordTag: interaction.user.tag,
    });

    if (result.offline && fallbackDb.enabled) {
      result = await fallbackDb.verifyLinkCodeOffline(code, interaction.user.id);
    }

    if (!result.ok) {
      await interaction.editReply(String(result.message || result.error || "Could not verify link code."));
      return;
    }

    const house = (result.house || null) as HouseKey | null;
    await applyHouseRoleToMember(interaction.user.id, house);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Hogwarts Student Profile Linked")
          .setColor(0x2f9e68)
          .setDescription(`Bound Discord account to **${result.characterName}**.${house ? ` Assigned **${house.charAt(0).toUpperCase() + house.slice(1)}** House role!` : ""}`)
          .setTimestamp(),
      ],
    });
    return;
  }

  if (cmd === "syncroles") {
    if (!isAuthorizedStaff(interaction)) {
      await interaction.reply({ content: "Staff permissions required.", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const res = await bridge.request("POST", "/command", {
      commandType: "syncroles",
      payload: {},
      issuedByDiscordId: interaction.user.id,
      issuedByTag: interaction.user.tag,
    });
    const links = res.ok && res.data?.links ? res.data.links : await fallbackDb.getAllLinks();
    let synced = 0;
    for (const row of links) {
      if (await applyHouseRoleToMember(String(row.discord_id), row.house || null)) {
        synced++;
      }
    }
    await interaction.editReply(`Synchronized Hogwarts House roles for **${synced}/${links.length}** linked member(s).`);
  }
  } catch (err) {
    console.error(`Interaction error for /${cmd}:`, err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("An unexpected error occurred while executing this command.");
      } else {
        await interaction.reply({ content: "An unexpected error occurred while executing this command.", ephemeral: true });
      }
    } catch {}
  }
});

let refreshTimer: ReturnType<typeof setInterval> | null = null;

client.once("ready", () => {
  console.log(`[dg-discord-bot] Logged in as ${client.user?.tag}`);
  void refreshLiveStatusAndCup();
  refreshTimer = setInterval(() => void refreshLiveStatusAndCup(), STATUS_REFRESH_MS);

  bridge.startEventStream((eventName, data) => {
    if (eventName === "audit") {
      void dispatchAuditEmbed(data);
    } else if (eventName === "roleSync" && data?.discordId) {
      void applyHouseRoleToMember(String(data.discordId), data.house || null);
    } else if (eventName === "houseCup" && data?.houses) {
      void upsertPinnedEmbed(
        process.env.CHANNEL_HOUSE_CUP_ID || "",
        pinnedCupMessageId,
        buildHouseCupEmbed(data.houses, false)
      ).then((id) => {
        if (id) pinnedCupMessageId = id;
      });
    } else if (eventName === "queueDrained") {
      void dispatchAuditEmbed({
        category: "staff",
        title: `Offline Queued Command Executed (/${data.commandType})`,
        description: String(data.message || ""),
        actor: "MySQL Queue Drainer",
      });
    }
  });
});

async function shutdown(): Promise<void> {
  if (refreshTimer) clearInterval(refreshTimer);
  bridge.stop();
  await fallbackDb.close();
  client.destroy();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

void client.login(botToken);
