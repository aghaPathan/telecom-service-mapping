import bcrypt from "bcryptjs";

export const BCRYPT_COST = 12;
const MIN_LEN = 8;

export async function hashPassword(plaintext: string): Promise<string> {
  if (!plaintext) throw new Error("password required");
  if (plaintext.length < MIN_LEN) throw new Error(`password must be at least ${MIN_LEN} chars`);
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  if (!plaintext || !hash) return false;
  return bcrypt.compare(plaintext, hash);
}
