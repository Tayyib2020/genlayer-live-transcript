import crypto from "node:crypto";
import express from "express";
import { pool } from "../db/pool.js";
import {
  clearAuthCookie,
  createAuthSession,
  authenticateRequest,
  hashPassword,
  mapUser,
  requireTrustedOrigin,
  revokeAuthSession,
  validatePassword,
  validateUsername,
  verifyPassword,
} from "../auth/auth.js";

const router = express.Router();
const attempts = new Map();
const RATE_WINDOW_MS = 15 * 60 * 1_000;

function clientAddress(request) {
  return request.ip || request.socket.remoteAddress || "unknown";
}

function rateLimit(request, response, next) {
  const key = `${request.path}:${clientAddress(request)}`;
  const now = Date.now();
  for (const [knownKey, bucket] of attempts) {
    if (bucket.expiresAt <= now) attempts.delete(knownKey);
  }
  const previous = attempts.get(key);
  if (!previous || previous.expiresAt <= now) {
    attempts.set(key, { count: 1, expiresAt: now + RATE_WINDOW_MS });
    return next();
  }
  if (previous.count >= (request.path === "/login" ? 10 : 5)) {
    return response.status(429).json({ error: "Too many attempts. Try again later." });
  }
  previous.count += 1;
  return next();
}

function credentials(request) {
  const username = validateUsername(request.body?.username);
  const password = validatePassword(request.body?.password);
  return { username, password };
}

router.use(requireTrustedOrigin);

router.post("/register", rateLimit, async (request, response, next) => {
  try {
    const { username, password } = credentials(request);
    const userId = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    const result = await pool.query(
      `INSERT INTO users (id, username, username_normalized, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, created_at`,
      [userId, username, username, passwordHash],
    );
    await createAuthSession(response, userId);
    return response.status(201).json({ user: mapUser(result.rows[0]) });
  } catch (error) {
    if (error?.code === "23505") return response.status(409).json({ error: "That username is already taken." });
    if (error instanceof Error && /Username|Password/.test(error.message)) return response.status(400).json({ error: error.message });
    return next(error);
  }
});

router.post("/login", rateLimit, async (request, response, next) => {
  try {
    const { username, password } = credentials(request);
    const result = await pool.query(
      `SELECT id, username, password_hash, created_at
         FROM users
        WHERE username_normalized = $1`,
      [username],
    );
    const valid = result.rowCount > 0 && await verifyPassword(password, result.rows[0].password_hash);
    if (!valid) return response.status(401).json({ error: "Invalid username or password." });
    await createAuthSession(response, result.rows[0].id);
    return response.json({ user: mapUser(result.rows[0]) });
  } catch (error) {
    if (error instanceof Error && /Username|Password/.test(error.message)) return response.status(400).json({ error: error.message });
    return next(error);
  }
});

router.post("/logout", async (request, response, next) => {
  try {
    await revokeAuthSession(request);
    clearAuthCookie(response);
    return response.json({ loggedOut: true });
  } catch (error) {
    return next(error);
  }
});

router.get("/me", async (request, response, next) => {
  try {
    const user = await authenticateRequest(request);
    if (!user) return response.status(401).json({ error: "Authentication required." });
    return response.json({ user });
  } catch (error) {
    return next(error);
  }
});

export default router;
