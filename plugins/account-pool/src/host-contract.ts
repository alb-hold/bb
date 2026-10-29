import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

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
});
