import { z } from "zod";
import type { ThreadParentNotifications } from "./thread-parent-notifications.js";

export const storedThreadParentNotificationsValues = [
  "auto",
  "stuck",
  "off",
] as const;
export const storedThreadParentNotificationsSchema = z.enum(
  storedThreadParentNotificationsValues,
);
export type StoredThreadParentNotifications = z.infer<
  typeof storedThreadParentNotificationsSchema
>;

export interface StoredParentNotificationsColumns {
  parentNotifications: StoredThreadParentNotifications;
  parentNotificationsHoldWhileIdle: boolean | null;
}

export function splitParentNotificationsChoice(
  choice: ThreadParentNotifications,
): StoredParentNotificationsColumns {
  if (choice === "inbox") {
    return { parentNotifications: "auto", parentNotificationsHoldWhileIdle: true };
  }
  return { parentNotifications: choice, parentNotificationsHoldWhileIdle: null };
}

export function resolveParentNotificationsChoice(columns: {
  parentNotifications: ThreadParentNotifications;
  parentNotificationsHoldWhileIdle?: boolean | null;
}): ThreadParentNotifications {
  return columns.parentNotifications === "auto" &&
    columns.parentNotificationsHoldWhileIdle === true
    ? "inbox"
    : columns.parentNotifications;
}
