import mysql from "mysql2/promise";

export type HouseKey = "gryffindor" | "slytherin" | "ravenclaw" | "hufflepuff";

export class OfflineFallbackDb {
  private pool: mysql.Pool | null = null;

  constructor() {
    if (process.env.MYSQL_ENABLED !== "true") return;
    if (!process.env.MYSQL_HOST || !process.env.MYSQL_USER || !process.env.MYSQL_DATABASE) return;

    this.pool = mysql.createPool({
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD || "",
      database: process.env.MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: 5,
    });
  }

  get enabled(): boolean {
    return Boolean(this.pool);
  }

  async getHouseCupSnapshot(): Promise<Record<HouseKey, number> | null> {
    if (!this.pool) return null;
    try {
      const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(
        "SELECT house_key, points FROM dg_discord_house_snapshot"
      );
      const totals: Record<HouseKey, number> = {
        gryffindor: 0,
        slytherin: 0,
        ravenclaw: 0,
        hufflepuff: 0,
      };
      for (const row of rows) {
        const key = String(row.house_key || "").toLowerCase() as HouseKey;
        if (key in totals) totals[key] = Number(row.points) || 0;
      }
      return totals;
    } catch {
      return null;
    }
  }

  async enqueueStaffAction(
    commandType: string,
    payload: Record<string, unknown>,
    issuedByDiscordId: string,
    issuedByTag: string
  ): Promise<number | null> {
    if (!this.pool) return null;
    const [result] = await this.pool.execute<mysql.ResultSetHeader>(
      `INSERT INTO dg_discord_action_queue (command_type, payload_json, issued_by_discord_id, issued_by_tag, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [commandType, JSON.stringify(payload), issuedByDiscordId, issuedByTag]
    );
    return result.insertId;
  }

  async verifyLinkCodeOffline(
    codeRaw: string,
    discordId: string
  ): Promise<{ ok: boolean; message: string; house?: HouseKey | null; characterName?: string }> {
    if (!this.pool) return { ok: false, message: "Offline MySQL fallback is not configured." };
    const code = codeRaw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    if (code.length !== 6) return { ok: false, message: "Link codes must be 6 characters." };

    try {
      const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(
        `SELECT code, character_id, character_name, house
         FROM dg_discord_link_codes
         WHERE code = ? AND consumed = 0 AND expires_at > NOW()
         LIMIT 1`,
        [code]
      );
      const match = rows[0];
      if (!match) {
        return { ok: false, message: "Link code is invalid or expired. Run /link in-game for a new code." };
      }

      const [consumeRes] = await this.pool.execute<mysql.ResultSetHeader>(
        "UPDATE dg_discord_link_codes SET consumed = 1 WHERE code = ? AND consumed = 0 AND expires_at > NOW()",
        [code]
      );
      if (consumeRes.affectedRows === 0) {
        return { ok: false, message: "This link code has already been redeemed or expired." };
      }
      await this.pool.execute(
        "DELETE FROM dg_discord_links WHERE character_id = ? OR discord_id = ?",
        [match.character_id, discordId]
      );
      await this.pool.execute(
        `INSERT INTO dg_discord_links (character_id, discord_id, character_name, house)
         VALUES (?, ?, ?, ?)`,
        [match.character_id, discordId, match.character_name, match.house]
      );

      return {
        ok: true,
        message: `Linked ${match.character_name} via MySQL!`,
        house: (match.house ? String(match.house).toLowerCase() : null) as HouseKey | null,
        characterName: String(match.character_name),
      };
    } catch {
      return { ok: false, message: "Offline MySQL error while verifying link code." };
    }
  }

  async getAllLinks(): Promise<Array<{ discord_id: string; character_name: string; house: HouseKey | null }>> {
    if (!this.pool) return [];
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(
      "SELECT discord_id, character_name, house FROM dg_discord_links"
    );
    return rows.map((r) => ({
      discord_id: String(r.discord_id),
      character_name: String(r.character_name || "Student"),
      house: (r.house ? String(r.house).toLowerCase() : null) as HouseKey | null,
    }));
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
