import { BbHttpError } from "@bb/sdk";
import { nativeTerminalClosedForGood } from "./native-holder.js";

export async function checkNativeTerminalClosedForGood(
  load: () => Promise<Parameters<typeof nativeTerminalClosedForGood>[0]>,
): Promise<boolean> {
  try {
    return nativeTerminalClosedForGood(await load());
  } catch (error) {
    if (error instanceof BbHttpError) return error.status === 404;
    throw error;
  }
}
