import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { formatRelativeTime } from "@/lib/relative-time";
import { defineSplit } from "@/lib/define-split";
import {
  toggleNotificationCenter,
  useNotificationCenterState,
} from "@/lib/notifications/notification-store";

const NotificationCenterView = defineSplit<{
  open: boolean;
  formatTime: typeof formatRelativeTime;
}>({
  id: "notification-center",
  load: () =>
    import("./NotificationCenterView").then(
      (module) => module.NotificationCenterView,
    ),
  loading: () => null,
  tier: "intent",
  mountWhen: ({ open }) => open,
  keepMounted: true,
});

export function NotificationCenter() {
  const { open } = useNotificationCenterState();
  useAppCommandHandler("notifications.open", () => {
    toggleNotificationCenter();
    return true;
  });
  return <NotificationCenterView open={open} formatTime={formatRelativeTime} />;
}
