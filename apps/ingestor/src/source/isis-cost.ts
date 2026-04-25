import { createClient } from "@clickhouse/client";

/**
 * Canonical ISIS-cost row, one per ordered (Device_A_*, Device_B_*) quadruple.
 * Orientation folding (A→B vs B→A) happens later in the canonical-pair stage —
 * this reader returns rows as observed at the source.
 *
 * NEVER log row contents — real production hostnames per CLAUDE.md
 * data-sensitivity rules.
 */
export type IsisCostRow = {
  device_a_name: string;
  device_a_interface: string;
  device_b_name: string;
  device_b_interface: string;
  weight: number;
  observed_at: Date;
};

export type IsisCostConfig = {
  url: string;
  user: string;
  password: string;
  database: string;
  isisTable: string;
  timeoutMs: number;
};

type RawRow = {
  device_a_name: string;
  device_a_interface: string;
  device_b_name: string;
  device_b_interface: string;
  weight: string; // Int64 arrives as string in JSON
  observed_at: string; // DateTime arrives without timezone
};

/**
 * Read ISIS edge cost from ClickHouse `lldp_data.isis_cost`, applying:
 *   - drop NULL Device_*_Name and Device_*_Interface
 *   - drop self-loops (Device_A_Name = Device_B_Name AND Device_A_Interface = Device_B_Interface)
 *   - dedup with argMax(ISIS_COST, RecordDateTime) per ordered quadruple
 *
 * Table name is interpolated (CH refuses parameter binding for identifiers).
 * Values are env-only, not user input.
 */
export async function readIsisCost(cfg: IsisCostConfig): Promise<IsisCostRow[]> {
  const client = createClient({
    url: cfg.url,
    username: cfg.user,
    password: cfg.password,
    database: cfg.database,
    request_timeout: cfg.timeoutMs,
  });

  try {
    const sql = `
      SELECT
        Device_A_Name      AS device_a_name,
        Device_A_Interface AS device_a_interface,
        Device_B_Name      AS device_b_name,
        Device_B_Interface AS device_b_interface,
        argMax(ISIS_COST, RecordDateTime) AS weight,
        max(RecordDateTime)               AS observed_at
      FROM ${cfg.database}.${cfg.isisTable}
      WHERE Device_A_Name      IS NOT NULL
        AND Device_A_Interface IS NOT NULL
        AND Device_B_Name      IS NOT NULL
        AND Device_B_Interface IS NOT NULL
        AND NOT (Device_A_Name = Device_B_Name AND Device_A_Interface = Device_B_Interface)
      GROUP BY
        Device_A_Name,
        Device_A_Interface,
        Device_B_Name,
        Device_B_Interface
    `;

    const rs = await client.query({ query: sql, format: "JSONEachRow" });
    const raw = await rs.json<RawRow>();

    return raw.map((r) => ({
      device_a_name: r.device_a_name,
      device_a_interface: r.device_a_interface,
      device_b_name: r.device_b_name,
      device_b_interface: r.device_b_interface,
      weight: Number(r.weight),
      // ClickHouse DateTime ships without offset — pin to UTC to match source semantics.
      observed_at: new Date(`${r.observed_at}Z`),
    }));
  } finally {
    await client.close();
  }
}
