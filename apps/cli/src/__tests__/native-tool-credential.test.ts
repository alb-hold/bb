import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nativeToolCredentialDir,
  readNativeToolCredentialFile,
  removeNativeToolCredentialFile,
  withBearerCredential,
  writeNativeToolCredentialFile,
} from "../native-tool-credential.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function socketPath(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "bb-native-cred-"));
  roots.push(root);
  return path.join(root, "thr_abc-12345678.sock");
}

describe("native tool credential file", () => {
  it("writes the secret to a 0600 file in a 0700 directory and removes it", () => {
    const socket = socketPath();
    const file = writeNativeToolCredentialFile(socket, "secret-value");
    expect(readFileSync(file, "utf8")).toBe("secret-value");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(nativeToolCredentialDir(socket)).mode & 0o777).toBe(0o700);
    expect(readNativeToolCredentialFile(file)).toBe("secret-value");
    removeNativeToolCredentialFile(socket);
    expect(existsSync(file)).toBe(false);
  });

  it("replaces a stale credential from an earlier launch", () => {
    const socket = socketPath();
    writeNativeToolCredentialFile(socket, "old");
    const file = writeNativeToolCredentialFile(socket, "new");
    expect(readFileSync(file, "utf8")).toBe("new");
  });

  it("refuses an empty credential file", () => {
    const socket = socketPath();
    const file = writeNativeToolCredentialFile(socket, "x");
    rmSync(file);
    expect(() => readNativeToolCredentialFile(file)).toThrow();
  });

  it("sends the credential as a bearer header on every request", async () => {
    const seen: string[] = [];
    const wrapped = withBearerCredential(
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("authorization") ?? "");
        return new Response("{}");
      }) as typeof fetch,
      "tok",
    );
    await wrapped("http://x/y", { headers: { "content-type": "text/plain" } });
    await wrapped("http://x/y");
    expect(seen).toEqual(["Bearer tok", "Bearer tok"]);
  });
});
