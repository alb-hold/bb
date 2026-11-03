export const DEVICE_HANDOFF_DEVICE_STORAGE_KEY = "bb-device-handoff-device-id";

export type DeviceHandoffIdentityEnvironment = {
  readStoredId: () => string | null;
  storeId: (token: string) => void;
  createId: () => string;
};

export function createDeviceHandoffIdentityManager(
  environment: DeviceHandoffIdentityEnvironment,
): {
  ensure: () => string | null;
  remember: (token: string) => void;
} {
  let inMemoryDeviceHandoffId: string | null = null;

  function ensureDeviceHandoffId(): string | null {
    if (inMemoryDeviceHandoffId !== null) return inMemoryDeviceHandoffId;
    try {
      const token = environment.readStoredId();
      if (token !== null && /^[A-Za-z0-9_-]{22}$/u.test(token)) {
        inMemoryDeviceHandoffId = token;
        return token;
      }
    } catch {
      inMemoryDeviceHandoffId = null;
    }
    try {
      const token = environment.createId();
      inMemoryDeviceHandoffId = token;
      try {
        environment.storeId(token);
      } catch {
        return inMemoryDeviceHandoffId;
      }
      return token;
    } catch {
      return null;
    }
  }

  return {
    ensure: ensureDeviceHandoffId,
    remember: (token) => {
      inMemoryDeviceHandoffId = token;
    },
  };
}
