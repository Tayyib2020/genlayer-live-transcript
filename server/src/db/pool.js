import "../env.js";
import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error", {
    name: error?.name,
    code: error?.code,
    message: typeof error?.message === "string" ? error.message.slice(0, 500) : "No error message available",
    detail: typeof error?.detail === "string" ? error.detail.slice(0, 500) : undefined,
  });
});
