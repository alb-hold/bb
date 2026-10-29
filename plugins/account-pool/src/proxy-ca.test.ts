import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createProxyCertificateAuthority } from "./proxy-ca.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "bb-proxy-ca-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function handshake(
  ca: string,
  serverName: string,
  cert: string,
  key: string,
): Promise<{ authorized: boolean; error: string | null }> {
  return new Promise((resolve) => {
    const server = tls.createServer({ cert, key }, (socket) => socket.end());
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error();
      const client = tls.connect({
        host: "127.0.0.1",
        port: address.port,
        servername: serverName,
        ca,
        rejectUnauthorized: false,
      });
      client.once("secureConnect", () => {
        const result = {
          authorized: client.authorized,
          error: client.authorizationError
            ? String(client.authorizationError)
            : null,
        };
        client.destroy();
        server.close();
        resolve(result);
      });
      client.once("error", (error) => {
        server.close();
        resolve({ authorized: false, error: error.message });
      });
    });
  });
}

describe("proxy certificate authority", () => {
  it("creates a name-constrained CA with a 0600 key and 0700 directory", async () => {
    const dir = path.join(await tempDir(), "proxy-ca");
    const authority = await createProxyCertificateAuthority({
      dir,
      now: () => Date.now(),
    });
    const ca = new X509Certificate(await authority.caPem());
    expect(ca.ca).toBe(true);
    const { stdout } = await execFileAsync("openssl", [
      "x509",
      "-in",
      path.join(dir, "ca.pem"),
      "-noout",
      "-ext",
      "nameConstraints",
    ]);
    expect(stdout).toMatch(/critical/u);
    expect(stdout).toContain("DNS:api.anthropic.com");
    expect(stdout.match(/DNS:/gu)).toHaveLength(1);
    expect((await fs.stat(path.join(dir, "ca.key"))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("reuses the stored CA", async () => {
    const dir = path.join(await tempDir(), "proxy-ca");
    const first = await createProxyCertificateAuthority({ dir, now: Date.now });
    const second = await createProxyCertificateAuthority({
      dir,
      now: Date.now,
    });
    expect(await second.caPem()).toBe(await first.caPem());
  });

  it("mints a short-lived leaf for api.anthropic.com that a client trusting only the CA accepts", async () => {
    const dir = path.join(await tempDir(), "proxy-ca");
    const authority = await createProxyCertificateAuthority({
      dir,
      now: Date.now,
    });
    const leaf = await authority.leafFor("host-one");
    const cert = new X509Certificate(leaf.certPem);
    expect(cert.subjectAltName).toBe("DNS:api.anthropic.com");
    expect(cert.ca).toBe(false);
    const lifetimeMs = leaf.notAfter - Date.now();
    expect(lifetimeMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(lifetimeMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
    expect(
      await handshake(
        await authority.caPem(),
        "api.anthropic.com",
        leaf.certPem,
        leaf.keyPem,
      ),
    ).toEqual({ authorized: true, error: null });
  });

  it("rejects a leaf for any other host even when the CA key signs it", async () => {
    const root = await tempDir();
    const dir = path.join(root, "proxy-ca");
    const authority = await createProxyCertificateAuthority({
      dir,
      now: Date.now,
    });
    await authority.leafFor("host-one");
    const work = path.join(root, "evil");
    await fs.mkdir(work);
    const key = path.join(work, "k.pem");
    const csr = path.join(work, "c.csr");
    const crt = path.join(work, "c.pem");
    const ext = path.join(work, "e.cnf");
    await execFileAsync("openssl", [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      csr,
      "-subj",
      "/CN=example.com",
    ]);
    await fs.writeFile(ext, "subjectAltName=DNS:example.com\n");
    await execFileAsync("openssl", [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      path.join(dir, "ca.pem"),
      "-CAkey",
      path.join(dir, "ca.key"),
      "-CAcreateserial",
      "-out",
      crt,
      "-days",
      "1",
      "-extfile",
      ext,
    ]);
    const result = await handshake(
      await authority.caPem(),
      "example.com",
      await fs.readFile(crt, "utf8"),
      await fs.readFile(key, "utf8"),
    );
    expect(result.authorized).toBe(false);
    const verification = await execFileAsync("openssl", [
      "verify",
      "-CAfile",
      path.join(dir, "ca.pem"),
      crt,
    ]).then(
      () => "accepted",
      (error: { stdout?: string; stderr?: string }) =>
        `${error.stdout ?? ""}${error.stderr ?? ""}`,
    );
    expect(verification).toMatch(/permitted subtree violation/iu);
  });

  it("regenerates a CA whose key does not match its certificate", async () => {
    const root = await tempDir();
    const dir = path.join(root, "proxy-ca");
    const other = path.join(root, "other-ca");
    const first = await createProxyCertificateAuthority({ dir, now: Date.now });
    const stale = await first.caPem();
    const foreign = await createProxyCertificateAuthority({
      dir: other,
      now: Date.now,
    });
    await fs.copyFile(path.join(other, "ca.pem"), path.join(dir, "ca.pem"));
    const healed = await createProxyCertificateAuthority({
      dir,
      now: Date.now,
    });
    const pem = await healed.caPem();
    expect(pem).not.toBe(await foreign.caPem());
    expect(pem).not.toBe(stale);
    const leaf = await healed.leafFor("host-one");
    expect(
      await handshake(pem, "api.anthropic.com", leaf.certPem, leaf.keyPem),
    ).toEqual({ authorized: true, error: null });
    expect(
      (await fs.readdir(dir)).filter((name) => name.startsWith("work-")),
    ).toEqual([]);
  });

  it("refuses to mint certificates for hosts other than api.anthropic.com", async () => {
    const dir = path.join(await tempDir(), "proxy-ca");
    const authority = await createProxyCertificateAuthority({
      dir,
      now: Date.now,
    });
    await expect(authority.mintLeaf("example.com")).rejects.toThrow(
      /api\.anthropic\.com/u,
    );
  });
});
