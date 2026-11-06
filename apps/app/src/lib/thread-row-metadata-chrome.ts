import { z } from "zod";
import { createLastKnownCache } from "@/lib/last-known-cache";

const MAX_THREADS = 512;
const cache = createLastKnownCache({
  prefix: "bb.thread-row-metadata",
  version: "1",
  schema: z.array(z.string().min(1)).max(MAX_THREADS),
});
const key = cache.key("threads");

export function readThreadRowMetadataChrome(threadId: string): boolean {
  return cache.read(key)?.includes(threadId) ?? false;
}

export function rememberThreadRowMetadataChrome(
  threadId: string,
  hasItems: boolean,
): void {
  const threads = cache.read(key) ?? [];
  if (threads.includes(threadId) === hasItems) return;
  const others = threads.filter((id) => id !== threadId);
  cache.write(
    key,
    hasItems ? [...others, threadId].slice(-MAX_THREADS) : others,
  );
}
