import "../env.js";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";

export const AUTH_COOKIE_NAME = "signal_ledger_session";
export const USERNAME_PATTERN = /^[a-z0-9_-]{3,30}$/;

const DEFAULT_SESSION_TTL_DAYS = 7;
const BCRYPT_ROUNDS = 12;

function sessionTtlDays() {
  const configured = Number.parseInt(process.env.AUTH_SESSION_TTL_DAYS ?? `${DEFAULT_SESSION_TTL_DAYS}`, 10);
  return Number.isInteger(configured) && configured >= 1 && configured <= 30 ? configured : DEFAULT_SESSION_TTL_DAYS;
}

function tokenDigest(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function cookieOptions() {
  const production = process.env.NODE_ENV === "production";
  return {
    secure: production,
    sameSite: production ? "None" : "Lax",
    maxAge: sessionTtlDays() * 24 * 60 * 60,
  };
}

function serializeCookie(name, value, options) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", `Max-Age=${options.maxAge}`, "HttpOnly", `SameSite=${options.sameSite}`];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function readCookie(request, name) {
  const header = request.headers.cookie;
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function normalizeUsername(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function validateUsername(value) {
  const username = normalizeUsername(value);
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error("Username must be 3–30 characters and use only letters, numbers, underscores, or hyphens.");
  }
  return username;
}

export function validatePassword(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 128) {
    throw new Error("Password must be between 8 and 128 characters.");
  }
  return value;
}

export async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

export function mapUser(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, createdAt: row.created_at };
}

export function setAuthCookie(response, token) {
  response.setHeader("Set-Cookie", serializeCookie(AUTH_COOKIE_NAME, token, cookieOptions()));
}

export function clearAuthCookie(response) {
  const options = cookieOptions();
  response.setHeader("Set-Cookie", serializeCookie(AUTH_COOKIE_NAME, "", { ...options, maxAge: 0 }));
}

export async function createAuthSession(response, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO auth_sessions (token_digest, user_id, expires_at)
     VALUES ($1, $2, NOW() + ($3::integer * INTERVAL '1 day'))`,
    [tokenDigest(token), userId, sessionTtlDays()],
  );
  setAuthCookie(response, token);
}

export async function authenticateRequest(request) {
  const token = readCookie(request, AUTH_COOKIE_NAME);
  if (!token || token.length > 200) return null;
  const digest = tokenDigest(token);
  const result = await pool.query(
    `SELECT users.id, users.username, users.created_at, auth_sessions.token_digest
       FROM auth_sessions
       JOIN users ON users.id = auth_sessions.user_id
      WHERE auth_sessions.token_digest = $1
        AND auth_sessions.expires_at > NOW()` ,
    [digest],
  );
  if (result.rowCount === 0) {
    await pool.query("DELETE FROM auth_sessions WHERE token_digest = $1 AND expires_at <= NOW()", [digest]);
    return null;
  }
  request.authTokenDigest = digest;
  request.user = mapUser(result.rows[0]);
  return request.user;
}

export async function requireAuth(request, response, next) {
  try {
    if (await authenticateRequest(request)) return next();
    return response.status(401).json({ error: "Authentication required." });
  } catch (error) {
    return next(error);
  }
}

export async function revokeAuthSession(request) {
  const token = readCookie(request, AUTH_COOKIE_NAME);
  if (!token || token.length > 200) return;
  await pool.query("DELETE FROM auth_sessions WHERE token_digest = $1", [tokenDigest(token)]);
}

export function requireTrustedOrigin(request, response, next) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return next();
  const origin = request.get("origin");
  const trustedOrigin = (process.env.CLIENT_ORIGIN ?? "http://localhost:5173").replace(/\/$/, "");
  if (origin && origin.replace(/\/$/, "") !== trustedOrigin) {
    return response.status(403).json({ error: "Request origin is not allowed." });
  }
  return next();
}

export function getCookieToken(request) {
  return readCookie(request, AUTH_COOKIE_NAME);
}
