#!/usr/bin/env tsx
/**
 * create-admin CLI — interactive admin user creation.
 *
 * Usage:
 *   pnpm --filter web create-admin          # prompts for email + password (x2)
 *   pnpm --filter web create-admin --force  # upsert if user already exists
 *
 * Exit codes:
 *   0 — success (created or updated)
 *   1 — generic / unexpected error
 *   2 — validation failure (bad email, password mismatch, password too short)
 *   3 — conflict: user exists and --force was not passed
 *
 * Security: password input is read with stdout echo muted. The plaintext
 * password is never written to stdout or stderr.
 */
import readline from "node:readline";
import { Writable } from "node:stream";
import { argv, exit, stdin } from "node:process";
import { hashPassword } from "../lib/password";
import { getPool } from "../lib/postgres";

class MutableStdout extends Writable {
  muted = false;
  _write(chunk: unknown, enc: BufferEncoding, cb: (e?: Error) => void): void {
    if (!this.muted) {
      process.stdout.write(chunk as Buffer | string, enc);
    }
    cb();
  }
}

type Prompter = {
  ask: (q: string) => Promise<string>;
  askHidden: (q: string) => Promise<string>;
  close: () => void;
};

/**
 * Build a prompter for an interactive TTY: readline echoes keystrokes to our
 * MutableStdout, which we selectively mute for password prompts.
 */
function buildTtyPrompter(): Prompter {
  const out = new MutableStdout();
  const rl = readline.createInterface({
    input: stdin,
    output: out,
    terminal: true,
  });
  return {
    ask: (q) =>
      new Promise((resolve) => {
        out.muted = false;
        out.write(q);
        rl.question("", (answer) => resolve(answer));
      }),
    askHidden: (q) =>
      new Promise((resolve) => {
        out.muted = false;
        out.write(q);
        out.muted = true;
        rl.question("", (answer) => {
          out.muted = false;
          out.write("\n");
          resolve(answer);
        });
      }),
    close: () => rl.close(),
  };
}

/**
 * Build a prompter for piped stdin (tests, CI, scripted use): read the whole
 * stream once, split on newlines, then serve lines sequentially. This
 * side-steps the readline-on-a-pipe race where line events can fire before the
 * next `rl.question` handler is registered. Prompts are still written to
 * stdout, but passwords are never echoed at all.
 */
async function buildPipedPrompter(): Promise<Prompter> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(chunk as Buffer);
  }
  const lines = Buffer.concat(chunks).toString("utf8").split("\n");
  let i = 0;
  const nextLine = (): string => {
    const v = lines[i] ?? "";
    i += 1;
    return v;
  };
  return {
    ask: async (q) => {
      process.stdout.write(q);
      return nextLine();
    },
    askHidden: async (q) => {
      process.stdout.write(q);
      const v = nextLine();
      process.stdout.write("\n");
      return v;
    },
    close: () => {
      /* nothing to close */
    },
  };
}

async function main(): Promise<number> {
  const force = argv.includes("--force");

  const isTty = Boolean((stdin as NodeJS.ReadStream).isTTY);
  const prompter: Prompter = isTty
    ? buildTtyPrompter()
    : await buildPipedPrompter();
  const { ask, askHidden } = prompter;

  try {
    const email = (await ask("Email: ")).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      process.stderr.write("invalid email\n");
      return 2;
    }

    const password = await askHidden("Password: ");
    const confirm = await askHidden("Confirm:  ");

    if (password !== confirm) {
      process.stderr.write("passwords do not match\n");
      return 2;
    }
    if (password.length < 8) {
      process.stderr.write("password must be at least 8 chars\n");
      return 2;
    }

    const hash = await hashPassword(password);
    const pool = getPool();
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE email=$1`,
      [email],
    );
    if (existing.rowCount && !force) {
      process.stderr.write("user exists: pass --force to upsert\n");
      return 3;
    }
    if (existing.rowCount) {
      await pool.query(
        `UPDATE users
            SET password_hash=$2,
                role='admin',
                is_active=true,
                updated_at=now()
          WHERE email=$1`,
        [email, hash],
      );
      process.stdout.write(`updated admin: ${email}\n`);
    } else {
      await pool.query(
        `INSERT INTO users (email, password_hash, role, is_active)
         VALUES ($1, $2, 'admin', true)`,
        [email, hash],
      );
      process.stdout.write(`created admin: ${email}\n`);
    }
    return 0;
  } finally {
    prompter.close();
  }
}

main()
  .then(async (code) => {
    try {
      await getPool().end();
    } catch {
      /* ignore pool teardown errors */
    }
    exit(code);
  })
  .catch(async (err) => {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    try {
      await getPool().end();
    } catch {
      /* ignore */
    }
    exit(1);
  });
