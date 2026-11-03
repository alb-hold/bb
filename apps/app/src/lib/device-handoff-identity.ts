import {
  createDeviceHandoffIdentityManager,
  DEVICE_HANDOFF_DEVICE_STORAGE_KEY,
} from "@bb/server-contract";

export { DEVICE_HANDOFF_DEVICE_STORAGE_KEY };

const deviceHandoffIdentity = createDeviceHandoffIdentityManager({
  readStoredId: () => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(DEVICE_HANDOFF_DEVICE_STORAGE_KEY);
  },
  storeId: (token) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(DEVICE_HANDOFF_DEVICE_STORAGE_KEY, token);
    }
  },
  createId: () => {
    if (typeof window === "undefined") {
      throw new Error("Device identity is unavailable outside the browser");
    }
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return window
      .btoa(binary)
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_")
      .replace(/=+$/u, "");
  },
});

export const ensureDeviceHandoffId = deviceHandoffIdentity.ensure;
export const rememberDeviceHandoffId = deviceHandoffIdentity.remember;
