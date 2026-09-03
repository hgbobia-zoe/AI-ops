// User store (Node runtime only — uses node:crypto + the DB). Per-person accounts with roles.
// Passwords are scrypt-hashed with a per-user salt; verification is constant-time.

import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db";
import { isRole, type Role } from "./roles";

export interface User {
  id: string;
  username: string;
  name: string;
  role: Role;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

interface Row {
  id: string;
  username: string;
  name: string | null;
  role: string;
  password_hash: string;
  active: number;
  created_at: string;
  last_login_at: string | null;
}

function toUser(r: Row): User {
  return {
    id: r.id,
    username: r.username,
    name: r.name ?? "",
    role: isRole(r.role) ? r.role : "member",
    active: r.active === 1,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
  };
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function countUsers(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

export function usernameExists(username: string): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username));
}

export function createUser(input: { username: string; name?: string; role: Role; password: string }): User {
  const id = `U-${randomUUID()}`;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      "INSERT INTO users (id, username, name, role, password_hash, active, created_at) VALUES (?,?,?,?,?,1,?)",
    )
    .run(id, input.username.trim(), input.name?.trim() || null, input.role, hashPassword(input.password), now);
  return toUser(getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as Row);
}

export function listUsers(): User[] {
  return (getDb().prepare("SELECT * FROM users ORDER BY role, username").all() as Row[]).map(toUser);
}

export function getUser(id: string): User | null {
  const r = getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
  return r ? toUser(r) : null;
}

export function setUserRole(id: string, role: Role): void {
  getDb().prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
}

export function setUserActive(id: string, active: boolean): void {
  getDb().prepare("UPDATE users SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

export function setUserPassword(id: string, password: string): void {
  getDb().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), id);
}

/** Verify a login. Returns the user (active only) on success, else null. Updates last_login_at. */
export function verifyLogin(username: string, password: string): User | null {
  const r = getDb().prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username.trim()) as Row | undefined;
  if (!r || r.active !== 1) return null;
  if (!verifyPassword(password, r.password_hash)) return null;
  const now = new Date().toISOString();
  getDb().prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, r.id);
  return toUser({ ...r, last_login_at: now });
}

/** Seed the first Owner from env if there are NO users yet. Idempotent. Needs OWNER_USERNAME +
 *  (OWNER_PASSWORD or APP_PASSWORD). Lets an admin bootstrap without a chicken-and-egg problem. */
export function bootstrapOwner(): void {
  if (countUsers() > 0) return;
  const username = process.env.OWNER_USERNAME || "owner";
  const password = process.env.OWNER_PASSWORD || process.env.APP_PASSWORD;
  if (!password) return; // nothing to seed with
  createUser({ username, name: "Owner", role: "owner", password });
}
