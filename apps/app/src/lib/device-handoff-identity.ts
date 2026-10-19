export const DEVICE_HANDOFF_DEVICE_STORAGE_KEY = "bb-device-handoff-device-id";

export function createDeviceHandoffIdentityManager(): {
  ensure: () => string | null;
  remember: (token: string) => void;
} {
  let inMemoryDeviceHandoffId: string | null = null;

  function ensureDeviceHandoffId(): string | null {
    if (inMemoryDeviceHandoffId !== null) return inMemoryDeviceHandoffId;
    if (typeof window === "undefined") return null;
    try {
      const token = window.localStorage.getItem(
        DEVICE_HANDOFF_DEVICE_STORAGE_KEY,
      );
      if (token !== null && /^[A-Za-z0-9_-]{22}$/u.test(token)) {
        inMemoryDeviceHandoffId = token;
        return token;
      }
    } catch {
      inMemoryDeviceHandoffId = null;
    }
    let token: string;
    try {
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      token = window
        .btoa(binary)
        .replace(/\+/gu, "-")
        .replace(/\//gu, "_")
        .replace(/=+$/u, "");
    } catch {
      return null;
    }
    inMemoryDeviceHandoffId = token;
    try {
      window.localStorage.setItem(DEVICE_HANDOFF_DEVICE_STORAGE_KEY, token);
    } catch {
      return inMemoryDeviceHandoffId;
    }
    return token;
  }

  return {
    ensure: ensureDeviceHandoffId,
    remember: (token) => {
      inMemoryDeviceHandoffId = token;
    },
  };
}

const deviceHandoffIdentity = createDeviceHandoffIdentityManager();

export const ensureDeviceHandoffId = deviceHandoffIdentity.ensure;
export const rememberDeviceHandoffId = deviceHandoffIdentity.remember;
