import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sessionRoutes = readFileSync(new URL("../src/routes/sessions.js", import.meta.url), "utf8");

test("session detail loads reconcile verification before returning history", () => {
  const reconciliation = sessionRoutes.indexOf(
    "const verification = await refreshSessionVerification(request.params.id, {}, request.user.id);",
  );
  const history = sessionRoutes.indexOf(
    "const verificationHistory = await getSessionVerificationHistory(request.params.id, request.user.id);",
  );

  assert.ok(reconciliation >= 0, "session detail load must call the existing read-only reconciliation lifecycle");
  assert.ok(history > reconciliation, "verification history must be read after reconciliation persists any updated verdict");
});
