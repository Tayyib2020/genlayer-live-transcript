import { z } from "zod";

export const createSessionSchema = z.object({
  title: z.string().trim().min(1, "Session title is required").max(160),
  sourceUrl: z
    .string()
    .trim()
    .url("Source URL must be a valid URL")
    .max(2_000)
    .optional()
    .or(z.literal("")),
});

export function parseSessionId(value) {
  return z.string().uuid().safeParse(value);
}
