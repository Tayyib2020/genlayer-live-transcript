import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(currentFile), "..", "..");

// The application owns one root .env file shared by the client/server scripts.
// Existing process environment variables still take precedence over the file.
dotenv.config({
  path: path.join(projectRoot, ".env"),
  quiet: true,
});
