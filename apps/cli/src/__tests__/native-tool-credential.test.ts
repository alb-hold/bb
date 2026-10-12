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
  takeNativeToolCredentialFromEnv,
  withFileCredential,
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

  it("takes the credential from the environment so child processes never inherit it", () => {
    const socket = socketPath();
    const env: NodeJS.ProcessEnv = {
      BB_NATIVE_TOOL_CREDENTIAL: "from-daemon",
      PATH: "/bin",
    };
    takeNativeToolCredentialFromEnv(env, socket);
    expect(env.BB_NATIVE_TOOL_CREDENTIAL).toBeUndefined();
    expect(
      readFileSync(
        path.join(nativeToolCredentialDir(socket), "credential"),
        "utf8",
      ),
    ).toBe("from-daemon");
    takeNativeToolCredentialFromEnv({ PATH: "/bin" }, socket);
    expect(
      readFileSync(
        path.join(nativeToolCredentialDir(socket), "credential"),
        "utf8",
      ),
    ).toBe("from-daemon");
  });

  it("sends the file's current credential as a bearer header on every request", async () => {
    const socket = socketPath();
    const file = writeNativeToolCredentialFile(socket, "first");
    const seen: string[] = [];
    const wrapped = withFileCredential(
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("authorization") ?? "");
        return new Response("{}");
      }) as typeof fetch,
      file,
    );
    await wrapped("http://x/y", { headers: { "content-type": "text/plain" } });
    writeNativeToolCredentialFile(socket, "rotated");
    await wrapped("http://x/y");
    expect(seen).toEqual(["Bearer first", "Bearer rotated"]);
  });
});
