import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import http from "node:http";
import { WebSocket } from "ws";
import authRouter from "../src/routes/auth.js";
import sessionsRouter from "../src/routes/sessions.js";
import { attachAudioWebSocketServer } from "../src/websocket/audioServer.js";
import { pool } from "../src/db/pool.js";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1";

function requestFor(baseUrl, client) {
  return async (path, options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(client.cookie ? { Cookie: client.cookie } : {}),
        ...(options.headers ?? {}),
      },
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) client.cookie = setCookie.split(";", 1)[0];
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
}

function openSocket(url, cookie) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, cookie ? { headers: { Cookie: cookie } } : undefined);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("WebSocket test timed out"));
    }, 5_000);
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      resolve({ statusCode: response.statusCode });
    });
    socket.once("error", (error) => {
      if (error?.code !== "ECONNRESET") reject(error);
    });
  });
}

test("private accounts, ownership boundaries, and authenticated audio WebSockets", { skip: !runDatabaseTests }, async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  app.use("/api/sessions", sessionsRouter);
  const server = http.createServer(app);
  attachAudioWebSocketServer(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsBaseUrl = `ws://127.0.0.1:${port}`;
  const anonymous = requestFor(baseUrl, {});
  const owner = {};
  const other = {};
  const ownerRequest = requestFor(baseUrl, owner);
  const otherRequest = requestFor(baseUrl, other);
  const createdSessionIds = [];
  let ownerId;
  let otherId;

  try {
    assert.equal((await anonymous("/api/auth/me")).status, 401);
    assert.equal((await anonymous("/api/sessions")).status, 401);

    const ownerRegistration = await ownerRequest("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username: `Tayyib-${crypto.randomUUID().slice(0, 8)}`, password: "correct horse battery staple" }),
    });
    assert.equal(ownerRegistration.status, 201);
    ownerId = ownerRegistration.body.user.id;
    assert.ok(ownerRegistration.body.user.username.startsWith("tayyib-"));
    assert.equal(ownerRegistration.body.user.password_hash, undefined);

    const duplicate = await otherRequest("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username: ownerRegistration.body.user.username.toUpperCase(), password: "another secure password" }),
    });
    assert.equal(duplicate.status, 409);

    const otherRegistration = await otherRequest("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username: `other-${crypto.randomUUID().slice(0, 8)}`, password: "another secure password" }),
    });
    assert.equal(otherRegistration.status, 201);
    otherId = otherRegistration.body.user.id;

    const storedUser = await pool.query("SELECT username, username_normalized, password_hash FROM users WHERE id = $1", [ownerId]);
    assert.equal(storedUser.rows[0].username, storedUser.rows[0].username_normalized);
    assert.notEqual(storedUser.rows[0].password_hash, "correct horse battery staple");
    assert.match(storedUser.rows[0].password_hash, /^\$2[aby]\$/);

    const wrongPassword = await anonymous("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: ownerRegistration.body.user.username, password: "wrong password" }),
    });
    const missingUser = await anonymous("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "missing-user", password: "wrong password" }),
    });
    assert.equal(wrongPassword.status, 401);
    assert.deepEqual(wrongPassword.body, missingUser.body);

    const ownerMe = await ownerRequest("/api/auth/me");
    assert.equal(ownerMe.status, 200);
    assert.equal(ownerMe.body.user.id, ownerId);

    await pool.query("UPDATE auth_sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1", [ownerId]);
    assert.equal((await ownerRequest("/api/auth/me")).status, 401);
    const ownerLogin = await ownerRequest("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: ownerRegistration.body.user.username, password: "correct horse battery staple" }),
    });
    assert.equal(ownerLogin.status, 200);

    const created = await ownerRequest("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Owner record", user_id: otherId }),
    });
    assert.equal(created.status, 201);
    const sessionId = created.body.session.id;
    createdSessionIds.push(sessionId);
    const storedSession = await pool.query("SELECT user_id FROM sessions WHERE id = $1", [sessionId]);
    assert.equal(storedSession.rows[0].user_id, ownerId);

    const ownerSessions = await ownerRequest("/api/sessions");
    const otherSessions = await otherRequest("/api/sessions");
    assert.deepEqual(ownerSessions.body.sessions.map((session) => session.id), [sessionId]);
    assert.deepEqual(otherSessions.body.sessions, []);

    for (const [method, path] of [
      ["GET", `/api/sessions/${sessionId}`],
      ["POST", `/api/sessions/${sessionId}/start`],
      ["POST", `/api/sessions/${sessionId}/stop`],
      ["POST", `/api/sessions/${sessionId}/complete`],
      ["DELETE", `/api/sessions/${sessionId}`],
      ["POST", `/api/sessions/${sessionId}/process`],
      ["POST", `/api/sessions/${sessionId}/regenerate-summary`],
      ["POST", `/api/sessions/${sessionId}/verify`],
      ["GET", `/api/sessions/${sessionId}/verification`],
    ]) {
      const result = await otherRequest(path, { method });
      assert.equal(result.status, 404, `${method} ${path} should be private`);
      assert.match(result.body.error, /not found|unavailable/i);
    }

    const legacyId = crypto.randomUUID();
    createdSessionIds.push(legacyId);
    await pool.query("INSERT INTO sessions (id, title, status) VALUES ($1, $2, 'created')", [legacyId, "Legacy unowned record"]);
    assert.equal((await ownerRequest(`/api/sessions/${legacyId}`)).status, 404);
    assert.equal((await ownerRequest("/api/sessions")).body.sessions.some((session) => session.id === legacyId), false);
    assert.equal((await pool.query("SELECT user_id FROM sessions WHERE id = $1", [legacyId])).rows[0].user_id, null);

    const live = await ownerRequest(`/api/sessions/${sessionId}/start`, { method: "POST" });
    assert.equal(live.status, 200);
    const ownerSocket = await openSocket(`${wsBaseUrl}/ws/audio?sessionId=${sessionId}`, owner.cookie);
    assert.equal(ownerSocket.readyState, WebSocket.OPEN);
    ownerSocket.close();
    const otherSocket = await openSocket(`${wsBaseUrl}/ws/audio?sessionId=${sessionId}`, other.cookie);
    assert.equal(otherSocket.statusCode, 404);
    const anonymousSocket = await openSocket(`${wsBaseUrl}/ws/audio?sessionId=${sessionId}`);
    assert.equal(anonymousSocket.statusCode, 401);

    assert.equal((await ownerRequest(`/api/sessions/${sessionId}/stop`, { method: "POST" })).status, 200);
    assert.equal((await ownerRequest("/api/auth/logout", { method: "POST" })).status, 200);
    assert.equal((await ownerRequest("/api/auth/me")).status, 401);
  } finally {
    if (createdSessionIds.length > 0) await pool.query("DELETE FROM sessions WHERE id = ANY($1::text[])", [createdSessionIds]);
    const userIds = [ownerId, otherId].filter(Boolean);
    if (userIds.length > 0) await pool.query("DELETE FROM users WHERE id = ANY($1::text[])", [userIds]);
    await new Promise((resolve) => server.close(resolve));
  }
});
