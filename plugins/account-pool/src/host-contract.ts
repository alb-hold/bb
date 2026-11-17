import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// Thread ids are `thr_` plus ten characters of bb's id alphabet. "catalog"
// is the home of the machine-scoped model-catalog process.
export const GEMINI_HOME_KEY =
  /^(?:thr_[23456789abcdefghijkmnpqrstuvwxyz]{10}|catalog)$/u;

/** The hub route antigravity-acp refreshes its thread token against. */
export const GEMINI_TOKEN_ROUTE = "/gemini/oauth2/token";

export const accountPoolHostContract = defineRpcContract({
  ensureProxy: {
    experimental_retryable: true,
    input: z
      .object({
        caPem: z.string().min(1),
        leafCertPem: z.string().min(1),
        leafKeyPem: z.string().min(1),
        proxyCredentialSha256s: z
          .array(z.string().regex(/^[a-f0-9]{64}$/u))
          .max(4_096),
      })
      .strict(),
    output: z
      .object({
        port: z.number().int().min(1).max(65_535),
        caPath: z.string().min(1),
        noProxy: z.string().min(1),
      })
      .strict(),
  },
  writeGeminiHome: {
    experimental_retryable: true,
    input: z
      .object({
        key: z.string().regex(GEMINI_HOME_KEY),
        refreshToken: z.string().min(1).max(4_096),
      })
      .strict(),
    output: z.object({ home: z.string().min(1) }).strict(),
  },
  pruneGeminiHomes: {
    experimental_retryable: true,
    input: z
      .object({
        keep: z.array(z.string().regex(GEMINI_HOME_KEY)).max(65_536),
      })
      .strict(),
    output: z.object({ removed: z.number().int().min(0) }).strict(),
  },
});
