import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import pg from "pg";
import neo4j, { type Driver } from "neo4j-driver";
import { runIngest } from "../src/index.ts";
import { dedupLldpRows, type RawLldpRow } from "../src/dedup.ts";
import { FIXTURE } from "./fixtures/lldp-50.ts";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { Client } = pg;

describe("ingest integration (testcontainers)", () => {
  let sourcePg: StartedTestContainer;
  let appPg: StartedTestContainer;
  let neo4jC: StartedTestContainer;

  let sourceUrl: string;
  let appUrl: string;
  let neoUri: string;
  const neoUser = "neo4j";
  const neoPassword = "testpassword123";

  beforeAll(async () => {
    // Start source Postgres (app_lldp seed).
    sourcePg = await new GenericContainer("postgres:13-alpine")
      .withEnvironment({
        POSTGRES_USER: "source",
        POSTGRES_PASSWORD: "source",
        POSTGRES_DB: "source",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(
          /database system is ready to accept connections/,
          2,
        ),
      )
      .start();

    // Start app Postgres (migrations + ingestion_runs).
    appPg = await new GenericContainer("postgres:13-alpine")
      .withEnvironment({
        POSTGRES_USER: "app",
        POSTGRES_PASSWORD: "app",
        POSTGRES_DB: "app",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(
          /database system is ready to accept connections/,
          2,
        ),
      )
      .start();

    // Start Neo4j.
    neo4jC = await new GenericContainer("neo4j:5-community")
      .withEnvironment({
        NEO4J_AUTH: `${neoUser}/${neoPassword}`,
      })
      .withExposedPorts(7687, 7474)
      .withWaitStrategy(Wait.forLogMessage(/Started\./))
      .withStartupTimeout(120_000)
      .start();

    sourceUrl = `postgres://source:source@${sourcePg.getHost()}:${sourcePg.getMappedPort(5432)}/source`;
    appUrl = `postgres://app:app@${appPg.getHost()}:${appPg.getMappedPort(5432)}/app`;
    neoUri = `bolt://${neo4jC.getHost()}:${neo4jC.getMappedPort(7687)}`;

    // Seed source `app_lldp` with the fixture rows (+ 2 rows at status=false
    // to verify the filter).
    const sc = new Client({ connectionString: sourceUrl });
    await sc.connect();
    try {
      await sc.query(`
        CREATE TABLE app_sitesportal (
          site_name TEXT PRIMARY KEY,
          category  TEXT,
          site_url  TEXT
        );
        CREATE TABLE app_cid (
          cid              TEXT PRIMARY KEY,
          source           TEXT,
          dest             TEXT,
          bandwidth        TEXT,
          protection_type  TEXT,
          protection_cid   TEXT,
          mobily_cid       TEXT,
          region           TEXT
        );
        CREATE TABLE app_devicecid (
          cid            TEXT,
          device_a_name  TEXT,
          device_b_name  TEXT
        );
      `);
      await sc.query(
        // Portal sites follow parseHostname's single-token convention — the
        // same key that :Site.name is MERGEd on from device hostnames. 'XX'
        // matches every XX-* device in the fixture; 'YY' has no devices so
        // stays portal-only (orphan :Site with category but no :LOCATED_AT).
        `INSERT INTO app_sitesportal (site_name, category, site_url) VALUES
           ('XX', 'core-hub',      'https://example.invalid/XX'),
           ('YY', 'unused-portal', null)`,
      );
      // Services:
      //   - SVC-1: protected by SVC-2 (primary→backup edge)
      //   - SVC-2: unprotected
      //   - SVC-3: protection_cid points at itself (self-loop, dropped)
      //   - SVC-4: protection_cid points at SVC-MISSING (unknown, dropped)
      //   - SVC-5: no source/dest columns — fallback to app_devicecid
      await sc.query(
        `INSERT INTO app_cid (cid, source, dest, bandwidth, protection_type, protection_cid, mobily_cid, region) VALUES
           ('SVC-1', 'XX-AAA-CORE-01', 'XX-BBB-UPE-01', '1G',  'linear',   'SVC-2',       'MCID-1', 'west'),
           ('SVC-2', 'XX-AAA-CORE-02', 'XX-BBB-UPE-02', '10G', 'none',     null,          'MCID-2', 'west'),
           ('SVC-3', 'XX-AAA-CORE-03', 'XX-BBB-UPE-03', '1G',  'linear',   'SVC-3',       'MCID-3', 'east'),
           ('SVC-4', 'XX-AAA-CORE-04', 'XX-BBB-UPE-04', '1G',  'linear',   'SVC-MISSING', 'MCID-4', 'east'),
           ('SVC-5', null,             null,             '1G', 'none',     null,          'MCID-5', 'south')`,
      );
      await sc.query(
        `INSERT INTO app_devicecid (cid, device_a_name, device_b_name) VALUES
           ('SVC-5', 'XX-AAA-CORE-05', 'XX-BBB-UPE-05')`,
      );
      await sc.query(`
        CREATE TABLE app_lldp (
          id                   SERIAL PRIMARY KEY,
          device_a_name        TEXT,
          device_a_interface   TEXT,
          device_a_trunk_name  TEXT,
          device_a_ip          TEXT,
          device_a_mac         TEXT,
          device_b_name        TEXT,
          device_b_interface   TEXT,
          device_b_ip          TEXT,
          device_b_mac         TEXT,
          vendor_a             TEXT,
          vendor_b             TEXT,
          domain_a             TEXT,
          domain_b             TEXT,
          type_a               TEXT,
          type_b               TEXT,
          updated_at           TIMESTAMPTZ NOT NULL,
          status               BOOLEAN NOT NULL DEFAULT true
        );
      `);
      for (const r of FIXTURE) {
        await sc.query(
          `INSERT INTO app_lldp (
             device_a_name, device_a_interface, device_a_trunk_name,
             device_a_ip, device_a_mac,
             device_b_name, device_b_interface,
             device_b_ip, device_b_mac,
             vendor_a, vendor_b, domain_a, domain_b,
             type_a, type_b,
             updated_at, status
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true)`,
          [
            r.device_a_name,
            r.device_a_interface,
            r.device_a_trunk_name,
            r.device_a_ip,
            r.device_a_mac,
            r.device_b_name,
            r.device_b_interface,
            r.device_b_ip,
            r.device_b_mac,
            r.vendor_a,
            r.vendor_b,
            r.domain_a,
            r.domain_b,
            r.type_a,
            r.type_b,
            r.updated_at,
          ],
        );
      }
      // Two inactive rows that MUST be excluded by `status = true` filter.
      await sc.query(
        `INSERT INTO app_lldp (
           device_a_name, device_a_interface, device_b_name, device_b_interface,
           updated_at, status
         ) VALUES
           ('XX-ZZZ-STALE-01','Gi0/1','XX-ZZZ-STALE-02','Gi0/1', now(), false),
           ('XX-ZZZ-STALE-03','Gi0/1','XX-ZZZ-STALE-04','Gi0/1', now(), false)`,
      );
    } finally {
      await sc.end();
    }
  }, 180_000);

  afterAll(async () => {
    await Promise.allSettled([
      sourcePg?.stop(),
      appPg?.stop(),
      neo4jC?.stop(),
    ]);
  }, 60_000);

  it("full round-trip: source pg → dedup → neo4j, metadata in app pg", async () => {
    // Derive expected counts from the same pure function the ingestor uses
    // — avoids brittle hard-coded numbers if the fixture evolves.
    const expected = dedupLldpRows(FIXTURE as unknown as RawLldpRow[]);

    const result = await runIngest({
      dryRun: false,
      config: {
        DATABASE_URL: appUrl,
        DATABASE_URL_SOURCE: sourceUrl,
        NEO4J_URI: neoUri,
        NEO4J_USER: neoUser,
        NEO4J_PASSWORD: neoPassword,
      },
    });

    expect(result.dryRun).toBe(false);
    // Source read honored status=true (only 50 fixture rows, not 52).
    expect(result.sourceRows).toBe(50);
    expect(result.dropped).toEqual(expected.dropped);
    expect(result.warnings).toHaveLength(expected.warnings.length);
    expect(result.graph.nodes).toBe(expected.devices.length);
    expect(result.graph.edges).toBe(expected.links.length);

    // Verify Neo4j actually holds the graph.
    const driver: Driver = neo4j.driver(
      neoUri,
      neo4j.auth.basic(neoUser, neoPassword),
    );
    try {
      const sess = driver.session();
      try {
        const nodeRes = await sess.run(
          "MATCH (d:Device) RETURN count(d) AS c",
        );
        expect(nodeRes.records[0]!.get("c").toNumber()).toBe(
          expected.devices.length,
        );

        const edgeRes = await sess.run(
          "MATCH ()-[r:CONNECTS_TO]->() RETURN count(r) AS c",
        );
        expect(edgeRes.records[0]!.get("c").toNumber()).toBe(
          expected.links.length,
        );

        // Unicode round-trip.
        const uni = await sess.run(
          "MATCH (d:Device) WHERE d.name IN ['Δ-CORE-01','日本-UPE-01'] RETURN d.name AS name",
        );
        const uniNames = uni.records.map((r) => r.get("name")).sort();
        expect(uniNames).toEqual(["Δ-CORE-01", "日本-UPE-01"]);

        // Mixed-case merge preserved first-seen casing.
        const mc = await sess.run(
          "MATCH (d:Device) WHERE toLower(d.name) = 'xx-hhh-core-01' RETURN d.name AS name",
        );
        expect(mc.records).toHaveLength(1);
        expect(mc.records[0]!.get("name")).toBe("XX-HHH-CORE-01");

        // Sites: portal rows + derived-from-name union. Portal rows carry
        // category + url; derived-only rows have null category/url.
        const portalSite = await sess.run(
          "MATCH (s:Site {name: 'XX'}) RETURN s.category AS c, s.url AS u",
        );
        expect(portalSite.records).toHaveLength(1);
        expect(portalSite.records[0]!.get("c")).toBe("core-hub");

        // The fixture has Δ-CORE-01 and Δ-CORE-02 (unicode site, not in portal) —
        // derived-only :Site with null category.
        const derivedSite = await sess.run(
          "MATCH (s:Site {name: 'Δ'}) RETURN s.category AS c",
        );
        expect(derivedSite.records).toHaveLength(1);
        expect(derivedSite.records[0]!.get("c")).toBeNull();

        // Orphan portal site — registered in app_sitesportal but no device
        // resolves to first-token 'YY', so the :Site node has category but
        // no :LOCATED_AT edges.
        const orphanPortal = await sess.run(
          "MATCH (s:Site {name: 'YY'}) OPTIONAL MATCH (s)<-[:LOCATED_AT]-(d) RETURN s.category AS c, count(d) AS n",
        );
        expect(orphanPortal.records).toHaveLength(1);
        expect(orphanPortal.records[0]!.get("c")).toBe("unused-portal");
        expect(orphanPortal.records[0]!.get("n").toNumber()).toBe(0);

        const locatedAt = await sess.run(
          `MATCH (d:Device {name: 'XX-AAA-CORE-01'})-[:LOCATED_AT]->(s:Site)
           RETURN s.name AS site`,
        );
        expect(locatedAt.records).toHaveLength(1);
        expect(locatedAt.records[0]!.get("site")).toBe("XX");

        // Services — all 5 fixture services materialize as :Service nodes.
        const svcCount = await sess.run(
          "MATCH (s:Service) RETURN count(s) AS c",
        );
        expect(svcCount.records[0]!.get("c").toNumber()).toBe(5);

        // TERMINATES_AT: source + dest roles from app_cid, plus fallback
        // from app_devicecid for SVC-5.
        const term = await sess.run(
          `MATCH (s:Service {cid: 'SVC-1'})-[r:TERMINATES_AT]->(d:Device)
           RETURN r.role AS role, d.name AS name ORDER BY r.role`,
        );
        expect(term.records.map((r) => r.get("role"))).toEqual([
          "dest",
          "source",
        ]);

        const svc5Term = await sess.run(
          `MATCH (s:Service {cid: 'SVC-5'})-[r:TERMINATES_AT]->(d:Device)
           RETURN r.role AS role, d.name AS name ORDER BY r.role`,
        );
        expect(svc5Term.records).toHaveLength(2);
        expect(svc5Term.records.map((r) => r.get("name")).sort()).toEqual([
          "XX-AAA-CORE-05",
          "XX-BBB-UPE-05",
        ]);

        // PROTECTED_BY: only SVC-1 → SVC-2 materializes. Self-loop (SVC-3)
        // and unknown-cid reference (SVC-4) are dropped.
        const prot = await sess.run(
          `MATCH (p:Service)-[:PROTECTED_BY]->(b:Service)
           RETURN p.cid AS primary, b.cid AS backup`,
        );
        expect(prot.records).toHaveLength(1);
        expect(prot.records[0]!.get("primary")).toBe("SVC-1");
        expect(prot.records[0]!.get("backup")).toBe("SVC-2");

        // mobily_cid index is queryable.
        const byMobily = await sess.run(
          "MATCH (s:Service {mobily_cid: 'MCID-2'}) RETURN s.cid AS cid",
        );
        expect(byMobily.records[0]!.get("cid")).toBe("SVC-2");
      } finally {
        await sess.close();
      }
    } finally {
      await driver.close();
    }

    // Verify ingestion_runs row.
    const ac = new Client({ connectionString: appUrl });
    await ac.connect();
    try {
      const { rows } = await ac.query(
        `SELECT status, dry_run, source_rows_read,
                rows_dropped_null_b, rows_dropped_self_loop, rows_dropped_anomaly,
                graph_nodes_written, graph_edges_written,
                sites_loaded, services_loaded, terminate_edges,
                located_at_edges, protected_by_edges,
                warnings_json
         FROM ingestion_runs WHERE id = $1`,
        [result.runId],
      );
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.status).toBe("succeeded");
      expect(row.dry_run).toBe(false);
      expect(row.source_rows_read).toBe(50);
      expect(row.rows_dropped_null_b).toBe(expected.dropped.null_b);
      expect(row.rows_dropped_self_loop).toBe(expected.dropped.self_loop);
      expect(row.rows_dropped_anomaly).toBe(expected.dropped.anomaly);
      expect(row.graph_nodes_written).toBe(expected.devices.length);
      expect(row.graph_edges_written).toBe(expected.links.length);
      expect(row.services_loaded).toBe(5);
      expect(row.sites_loaded).toBeGreaterThanOrEqual(3);
      expect(row.terminate_edges).toBe(10);
      expect(row.protected_by_edges).toBe(1);
      expect(row.located_at_edges).toBeGreaterThan(0);
      // warnings_json is stored as a jsonb; pg returns it already parsed.
      expect(Array.isArray(row.warnings_json)).toBe(true);
      expect(row.warnings_json).toHaveLength(expected.warnings.length);
    } finally {
      await ac.end();
    }
  });

  it("dry-run writes nothing to Neo4j but still records a run row", async () => {
    const driver = neo4j.driver(
      neoUri,
      neo4j.auth.basic(neoUser, neoPassword),
    );
    let before: number;
    {
      const s = driver.session();
      try {
        const r = await s.run("MATCH (d:Device) RETURN count(d) AS c");
        before = r.records[0]!.get("c").toNumber();
      } finally {
        await s.close();
      }
    }

    const result = await runIngest({
      dryRun: true,
      config: {
        DATABASE_URL: appUrl,
        DATABASE_URL_SOURCE: sourceUrl,
        NEO4J_URI: neoUri,
        NEO4J_USER: neoUser,
        NEO4J_PASSWORD: neoPassword,
      },
    });

    expect(result.dryRun).toBe(true);
    expect(result.graph).toEqual({
      nodes: 0,
      edges: 0,
      sites: 0,
      services: 0,
      terminate_edges: 0,
      located_at_edges: 0,
      protected_by_edges: 0,
    });

    let after: number;
    try {
      const s = driver.session();
      try {
        const r = await s.run("MATCH (d:Device) RETURN count(d) AS c");
        after = r.records[0]!.get("c").toNumber();
      } finally {
        await s.close();
      }
    } finally {
      await driver.close();
    }
    expect(after).toBe(before);

    const ac = new Client({ connectionString: appUrl });
    await ac.connect();
    try {
      const { rows } = await ac.query(
        "SELECT status, dry_run FROM ingestion_runs WHERE id = $1",
        [result.runId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("succeeded");
      expect(rows[0].dry_run).toBe(true);
    } finally {
      await ac.end();
    }
  });

  it("applies roles + levels from YAML config (default repo config)", async () => {
    const result = await runIngest({
      dryRun: false,
      config: {
        DATABASE_URL: appUrl,
        DATABASE_URL_SOURCE: sourceUrl,
        NEO4J_URI: neoUri,
        NEO4J_USER: neoUser,
        NEO4J_PASSWORD: neoPassword,
      },
    });
    expect(result.graph.nodes).toBeGreaterThan(0);

    const driver = neo4j.driver(neoUri, neo4j.auth.basic(neoUser, neoPassword));
    try {
      const sess = driver.session();
      try {
        // symmetric pair devices had type_a=ICOR / IUPE → resolved to CORE/UPE.
        const core = await sess.run(
          "MATCH (d:Device:CORE) RETURN d.name AS name, d.level AS level LIMIT 1",
        );
        expect(core.records).toHaveLength(1);
        const coreLvl = core.records[0]!.get("level");
        expect(typeof coreLvl === "number" ? coreLvl : coreLvl.toNumber()).toBe(1);

        const upe = await sess.run(
          "MATCH (d:Device:UPE) RETURN count(d) AS c",
        );
        expect(upe.records[0]!.get("c").toNumber()).toBeGreaterThan(0);

        // one-direction-pair devices: a=ICSG→CSG, b=null→Unknown.
        const unknown = await sess.run(
          "MATCH (d:Device:Unknown) RETURN count(d) AS c",
        );
        expect(unknown.records[0]!.get("c").toNumber()).toBeGreaterThan(0);
      } finally {
        await sess.close();
      }
    } finally {
      await driver.close();
    }
  });

  it("SW dynamic-leveling post-pass re-levels based on topology", async () => {
    // Custom config: maps a test-only type code to SW/Ran/Customer so we can
    // drive topology without polluting repo config.
    const cfgDir = mkdtempSync(path.join(tmpdir(), "sw-pass-"));
    writeFileSync(
      path.join(cfgDir, "hierarchy.yaml"),
      `levels:
  - { level: 1, label: Core, roles: [CORE] }
  - { level: 3, label: CustomerAggregation, roles: [SW] }
  - { level: 4, label: Access, roles: [RAN, Customer] }
unknown_label: Unknown
unknown_level: 99
sw_dynamic_leveling:
  enabled: true
`,
    );
    writeFileSync(
      path.join(cfgDir, "role_codes.yaml"),
      `type_map:
  TCOR: CORE
  TSWI: SW
  TRAN: RAN
  TCUS: Customer
name_prefix_map: {}
fallback: Unknown
resolver_priority: [type_column, name_prefix, fallback]
`,
    );

    // Seed dedicated fixture rows: sw-core connects to a core; sw-acc connects
    // to a RAN; sw-iso connects only to another SW. Full-refresh wipes prior.
    const sc = new pg.Client({ connectionString: sourceUrl });
    await sc.connect();
    try {
      await sc.query("TRUNCATE app_lldp, app_cid, app_devicecid, app_sitesportal");
      const rows: [string, string, string, string, string, string][] = [
        // [a, a_if, b, b_if, type_a, type_b]
        ["SW-CORE-BOUND", "xe-1", "CORE-01", "xe-1", "TSWI", "TCOR"],
        ["SW-ACCESS-BOUND", "xe-2", "RAN-01", "xe-2", "TSWI", "TRAN"],
        ["SW-ISOLATED", "xe-3", "SW-ISOLATED-PEER", "xe-3", "TSWI", "TSWI"],
      ];
      for (const [a, ai, b, bi, ta, tb] of rows) {
        await sc.query(
          `INSERT INTO app_lldp
             (device_a_name, device_a_interface, device_b_name, device_b_interface,
              type_a, type_b, updated_at, status)
           VALUES ($1,$2,$3,$4,$5,$6, now(), true)`,
          [a, ai, b, bi, ta, tb],
        );
      }
    } finally {
      await sc.end();
    }

    await runIngest({
      dryRun: false,
      resolverConfigDir: cfgDir,
      config: {
        DATABASE_URL: appUrl,
        DATABASE_URL_SOURCE: sourceUrl,
        NEO4J_URI: neoUri,
        NEO4J_USER: neoUser,
        NEO4J_PASSWORD: neoPassword,
      },
    });

    const driver = neo4j.driver(neoUri, neo4j.auth.basic(neoUser, neoPassword));
    try {
      const sess = driver.session();
      try {
        const q = async (name: string): Promise<number> => {
          const r = await sess.run(
            "MATCH (d:Device {name: $n}) RETURN d.level AS level",
            { n: name },
          );
          const lvl = r.records[0]!.get("level");
          return typeof lvl === "number" ? lvl : lvl.toNumber();
        };
        expect(await q("SW-CORE-BOUND")).toBe(2);     // connected to CORE
        expect(await q("SW-ACCESS-BOUND")).toBe(4);   // connected to RAN
        expect(await q("SW-ISOLATED")).toBe(3);       // only connected to SW → default
      } finally {
        await sess.close();
      }
    } finally {
      await driver.close();
    }
  });

  it("sites.yaml coords land on :Site nodes after ingest", async () => {
    const cfgDir = mkdtempSync(path.join(tmpdir(), "sites-yaml-"));
    writeFileSync(
      path.join(cfgDir, "hierarchy.yaml"),
      `levels:
  - { level: 1, label: Core, roles: [CORE] }
unknown_label: Unknown
unknown_level: 99
sw_dynamic_leveling:
  enabled: false
`,
    );
    writeFileSync(
      path.join(cfgDir, "role_codes.yaml"),
      `type_map:
  TCOR: CORE
name_prefix_map: {}
fallback: Unknown
resolver_priority: [type_column, name_prefix, fallback]
`,
    );
    // Seed JED (has coords) + ORPH (absent from sites.yaml → stays null).
    writeFileSync(
      path.join(cfgDir, "sites.yaml"),
      `sites:
  JED: { lat: 21.5433, lng: 39.1728, region: West }
`,
    );

    const sc = new pg.Client({ connectionString: sourceUrl });
    await sc.connect();
    try {
      await sc.query("TRUNCATE app_lldp, app_cid, app_devicecid, app_sitesportal");
      await sc.query(
        `INSERT INTO app_lldp
           (device_a_name, device_a_interface, device_b_name, device_b_interface,
            type_a, type_b, updated_at, status)
         VALUES
           ('JED-CORE-01',  'xe-1', 'JED-CORE-02',  'xe-1', 'TCOR', 'TCOR', now(), true),
           ('ORPH-CORE-01', 'xe-2', 'ORPH-CORE-02', 'xe-2', 'TCOR', 'TCOR', now(), true)`,
      );
    } finally {
      await sc.end();
    }

    await runIngest({
      dryRun: false,
      resolverConfigDir: cfgDir,
      config: {
        DATABASE_URL: appUrl,
        DATABASE_URL_SOURCE: sourceUrl,
        NEO4J_URI: neoUri,
        NEO4J_USER: neoUser,
        NEO4J_PASSWORD: neoPassword,
      },
    });

    const driver = neo4j.driver(neoUri, neo4j.auth.basic(neoUser, neoPassword));
    try {
      const sess = driver.session();
      try {
        const jed = await sess.run(
          "MATCH (s:Site {name: 'JED'}) RETURN s.lat AS lat, s.lng AS lng, s.region AS r",
        );
        expect(jed.records).toHaveLength(1);
        expect(jed.records[0]!.get("lat")).toBeCloseTo(21.5433, 4);
        expect(jed.records[0]!.get("lng")).toBeCloseTo(39.1728, 4);
        expect(jed.records[0]!.get("r")).toBe("West");

        const orph = await sess.run(
          "MATCH (s:Site {name: 'ORPH'}) RETURN s.lat AS lat, s.lng AS lng, s.region AS r",
        );
        expect(orph.records).toHaveLength(1);
        expect(orph.records[0]!.get("lat")).toBeNull();
        expect(orph.records[0]!.get("lng")).toBeNull();
        expect(orph.records[0]!.get("r")).toBeNull();
      } finally {
        await sess.close();
      }
    } finally {
      await driver.close();
    }
  });
});
