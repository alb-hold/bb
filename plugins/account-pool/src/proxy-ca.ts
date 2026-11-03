import { execFile } from "node:child_process";
import {
  X509Certificate,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { OAUTH_PROXY_HOST } from "./oauth-proxy-policy.js";

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1_000;
const CA_VALID_DAYS = 1_825;
const CA_RENEW_BEFORE_MS = 30 * DAY_MS;
const LEAF_VALID_DAYS = 7;
const LEAF_RENEW_BEFORE_MS = 2 * DAY_MS;
const OPENSSL_TIMEOUT_MS = 30_000;

export interface ProxyLeaf {
  certPem: string;
  keyPem: string;
  notAfter: number;
}

export interface ProxyCertificateAuthority {
  caPem(): Promise<string>;
  proxyCredential(tokenDigest: string): string;
  leafFor(hostId: string): Promise<ProxyLeaf>;
  mintLeaf(host: string): Promise<ProxyLeaf>;
}

export class ProxyCertificateAuthorityUnavailableError extends Error {}

const CA_CONFIG = `[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no
[dn]
CN = bb Account Pooler Artifact proxy CA
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign
subjectKeyIdentifier = hash
nameConstraints = critical, permitted;DNS:${OAUTH_PROXY_HOST}
`;

const LEAF_REQUEST_CONFIG = `[req]
distinguished_name = dn
prompt = no
[dn]
CN = ${OAUTH_PROXY_HOST}
`;

const LEAF_EXTENSIONS = `basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:${OAUTH_PROXY_HOST}
`;

function newKeyPem(): string {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
}

async function writePrivate(file: string, content: string): Promise<void> {
  await fs.writeFile(file, content, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function validUntil(pem: string): number {
  return Date.parse(new X509Certificate(pem).validTo);
}

export async function createProxyCertificateAuthority(options: {
  dir: string;
  now: () => number;
  openssl?: string;
}): Promise<ProxyCertificateAuthority> {
  const { dir, now } = options;
  const openssl = options.openssl ?? "openssl";
  const caKeyPath = path.join(dir, "ca.key");
  const caCertPath = path.join(dir, "ca.pem");
  const proxySecretPath = path.join(dir, "proxy-secret");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);

  async function run(args: string[]): Promise<void> {
    try {
      await execFileAsync(openssl, args, { timeout: OPENSSL_TIMEOUT_MS });
    } catch (error) {
      throw new ProxyCertificateAuthorityUnavailableError(
        `The openssl command is required to mint Artifact proxy certificates: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
        { cause: error },
      );
    }
  }

  async function withWorkDir<T>(
    body: (work: string) => Promise<T>,
  ): Promise<T> {
    const work = await fs.mkdtemp(path.join(dir, "work-"));
    await fs.chmod(work, 0o700);
    try {
      return await body(work);
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }

  async function generateCa(): Promise<void> {
    await withWorkDir(async (work) => {
      const config = path.join(work, "ca.cnf");
      const keyPath = path.join(work, "ca.key");
      const certPath = path.join(work, "ca.pem");
      await fs.writeFile(config, CA_CONFIG, { mode: 0o600 });
      await writePrivate(keyPath, newKeyPem());
      await run([
        "req",
        "-x509",
        "-new",
        "-sha256",
        "-key",
        keyPath,
        "-days",
        String(CA_VALID_DAYS),
        "-config",
        config,
        "-out",
        certPath,
      ]);
      await fs.chmod(certPath, 0o644);
      await fs.rename(keyPath, caKeyPath);
      await fs.rename(certPath, caCertPath);
    });
  }

  function keyMatchesCertificate(cert: string, key: string): boolean {
    try {
      return new X509Certificate(cert).checkPrivateKey(createPrivateKey(key));
    } catch {
      return false;
    }
  }

  async function ensureCa(): Promise<void> {
    const cert = await readIfPresent(caCertPath);
    const key = await readIfPresent(caKeyPath);
    if (
      cert !== null &&
      key !== null &&
      keyMatchesCertificate(cert, key) &&
      validUntil(cert) - now() > CA_RENEW_BEFORE_MS
    ) {
      await fs.chmod(caKeyPath, 0o600);
      return;
    }
    await generateCa();
  }

  async function loadProxySecret(): Promise<Buffer> {
    const existing = await readIfPresent(proxySecretPath);
    if (existing !== null && /^[a-f0-9]{64}$/u.test(existing.trim()))
      return Buffer.from(existing.trim(), "hex");
    const secret = randomBytes(32);
    const temp = `${proxySecretPath}.${randomBytes(8).toString("hex")}.tmp`;
    await writePrivate(temp, secret.toString("hex"));
    await fs.rename(temp, proxySecretPath);
    return secret;
  }

  let chain: Promise<unknown> = ensureCa();
  await chain;
  const proxySecret = await loadProxySecret();
  const leaves = new Map<string, ProxyLeaf>();

  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  }

  async function mint(): Promise<ProxyLeaf> {
    return withWorkDir(async (work) => {
      const keyPem = newKeyPem();
      const keyPath = path.join(work, "leaf.key");
      const requestConfig = path.join(work, "req.cnf");
      const extensions = path.join(work, "ext.cnf");
      const csr = path.join(work, "leaf.csr");
      const certPath = path.join(work, "leaf.pem");
      await writePrivate(keyPath, keyPem);
      await fs.writeFile(requestConfig, LEAF_REQUEST_CONFIG, { mode: 0o600 });
      await fs.writeFile(extensions, LEAF_EXTENSIONS, { mode: 0o600 });
      await run([
        "req",
        "-new",
        "-sha256",
        "-key",
        keyPath,
        "-config",
        requestConfig,
        "-out",
        csr,
      ]);
      await run([
        "x509",
        "-req",
        "-sha256",
        "-in",
        csr,
        "-CA",
        caCertPath,
        "-CAkey",
        caKeyPath,
        "-set_serial",
        `0x${randomBytes(16).toString("hex")}`,
        "-days",
        String(LEAF_VALID_DAYS),
        "-extfile",
        extensions,
        "-out",
        certPath,
      ]);
      const certPem = await fs.readFile(certPath, "utf8");
      const leaf = new X509Certificate(certPem);
      const ca = new X509Certificate(await fs.readFile(caCertPath, "utf8"));
      if (!leaf.verify(ca.publicKey) || !leaf.checkIssued(ca))
        throw new ProxyCertificateAuthorityUnavailableError(
          "The minted Artifact proxy certificate did not verify against its CA.",
        );
      return { certPem, keyPem, notAfter: Date.parse(leaf.validTo) };
    });
  }

  return {
    caPem: () => serialized(() => fs.readFile(caCertPath, "utf8")),
    proxyCredential: (tokenDigest) =>
      createHmac("sha256", proxySecret)
        .update(`account-pool proxy credential\0${tokenDigest}`)
        .digest("base64url"),
    mintLeaf(host) {
      if (host !== OAUTH_PROXY_HOST)
        return Promise.reject(
          new Error(
            `Artifact proxy certificates are minted only for ${OAUTH_PROXY_HOST}.`,
          ),
        );
      return serialized(mint);
    },
    leafFor(hostId) {
      return serialized(async () => {
        const cached = leaves.get(hostId);
        if (
          cached !== undefined &&
          cached.notAfter - now() > LEAF_RENEW_BEFORE_MS
        )
          return cached;
        const leaf = await mint();
        leaves.set(hostId, leaf);
        return leaf;
      });
    },
  };
}
