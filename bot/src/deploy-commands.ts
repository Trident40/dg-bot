import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

const commands = [
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show live Hogwarts ArcaneMP server status & online player count"),

  new SlashCommandBuilder()
    .setName("housecup")
    .setDescription("Display current Hogwarts House Cup point standings"),

  new SlashCommandBuilder()
    .setName("online")
    .setDescription("List students currently online on the server"),

  new SlashCommandBuilder()
    .setName("decree")
    .setDescription("[Staff] Broadcast a Headmaster Decree scroll to all online students")
    .addStringOption((opt) => opt.setName("title").setDescription("Decree headline").setRequired(true).setMaxLength(80))
    .addStringOption((opt) => opt.setName("message").setDescription("Decree announcement text").setRequired(true).setMaxLength(240)),

  new SlashCommandBuilder()
    .setName("howler")
    .setDescription("[Staff] Send a crimson Howler scroll to an online student")
    .addStringOption((opt) => opt.setName("player").setDescription("Player ID or character name").setRequired(true))
    .addStringOption((opt) => opt.setName("message").setDescription("Howler warning text").setRequired(true).setMaxLength(220)),

  new SlashCommandBuilder()
    .setName("points")
    .setDescription("[Staff] Award or deduct Hogwarts House Cup points")
    .addStringOption((opt) =>
      opt
        .setName("house")
        .setDescription("Target Hogwarts House")
        .setRequired(true)
        .addChoices(
          { name: "Gryffindor", value: "gryffindor" },
          { name: "Slytherin", value: "slytherin" },
          { name: "Ravenclaw", value: "ravenclaw" },
          { name: "Hufflepuff", value: "hufflepuff" }
        )
    )
    .addIntegerOption((opt) => opt.setName("amount").setDescription("Points to add (negative to deduct)").setRequired(true))
    .addStringOption((opt) => opt.setName("reason").setDescription("Reason shown in scroll & audit log").setRequired(true).setMaxLength(140)),

  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("[Staff] Kick an online student from Hogwarts")
    .addStringOption((opt) => opt.setName("player").setDescription("Player ID or name").setRequired(true))
    .addStringOption((opt) => opt.setName("reason").setDescription("Kick reason").setRequired(true)),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("[Staff] Ban a player or Discord ID via Headmaster Admin")
    .addStringOption((opt) => opt.setName("target").setDescription("Discord ID or online player name").setRequired(true))
    .addStringOption((opt) => opt.setName("reason").setDescription("Ban reason").setRequired(true)),

  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("[Staff] Lift a ban by Discord ID")
    .addStringOption((opt) => opt.setName("discord_id").setDescription("Banned Discord ID").setRequired(true)),

  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link your in-game Hogwarts character using your 6-character /link code")
    .addStringOption((opt) => opt.setName("code").setDescription("6-character code from /link in-game").setRequired(true).setMinLength(6).setMaxLength(6)),

  new SlashCommandBuilder()
    .setName("syncroles")
    .setDescription("[Staff] Synchronize Hogwarts House Discord roles for all linked students"),
].map((cmd) => cmd.toJSON());

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !clientId || !guildId) {
    throw new Error("Missing DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, or DISCORD_GUILD_ID in .env");
  }

  const rest = new REST({ version: "10" }).setToken(token);
  console.log(`Deploying ${commands.length} slash commands to guild ${guildId}...`);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  console.log("Slash commands deployed successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
