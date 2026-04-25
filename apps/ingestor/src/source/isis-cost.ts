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
  weight: string | null; // Int64 arrives as string in JSON; Nullable arrives as null
  observed_at: string; // DateTime formatted with explicit UTC offset
};

/**
 * ClickHouse identifier allowlist — letters, digits, underscore, must not
 * start with a digit. We never accept user-supplied database/table names
 * (env-only), but interpolation deserves a defense-in-depth check.
 */
const CH_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Structured warn-level log for dropped rows. NEVER include row contents. */
function logWarn(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({ level: "warn", event, ...fields }));
}

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
  if (!CH_IDENT.test(cfg.database) || !CH_IDENT.test(cfg.isisTable)) {
    throw new Error("Invalid ClickHouse identifier in IsisCostConfig");
  }

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
        formatDateTime(max(RecordDateTime), '%Y-%m-%dT%H:%M:%SZ', 'UTC') AS observed_at
      FROM ${cfg.database}.${cfg.isisTable}
      WHERE Device_A_Name      IS NOT NULL
        AND Device_A_Interface IS NOT NULL
        AND Device_B_Name      IS NOT NULL
        AND Device_B_Interface IS NOT NULL
        AND ISIS_COST          IS NOT NULL
        AND NOT (Device_A_Name = Device_B_Name AND Device_A_Interface = Device_B_Interface)
      GROUP BY
        Device_A_Name,
        Device_A_Interface,
        Device_B_Name,
        Device_B_Interface
    `;

    const rs = await client.query({ query: sql, format: "JSONEachRow" });
    const raw = await rs.json<RawRow>();

    const out: IsisCostRow[] = [];
    let droppedNonFinite = 0;
    for (const r of raw) {
      const weight = r.weight === null ? NaN : Number(r.weight);
      if (!Number.isFinite(weight)) {
        droppedNonFinite++;
        continue;
      }
      out.push({
        device_a_name: r.device_a_name,
        device_a_interface: r.device_a_interface,
        device_b_name: r.device_b_name,
        device_b_interface: r.device_b_interface,
        weight,
        // observed_at is formatted by ClickHouse with an explicit `Z` suffix.
        observed_at: new Date(r.observed_at),
      });
    }
    if (droppedNonFinite > 0) {
      logWarn("isis_weight_dropped", {
        reason: "non_finite_weight",
        count: droppedNonFinite,
      });
    }
    return out;
  } finally {
    await client.close();
  }
}
