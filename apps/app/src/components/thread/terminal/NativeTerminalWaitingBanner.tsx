import {
  isPluginPendingInteraction,
  isUserQuestionPendingInteractionPayload,
  type PendingInteraction,
} from "@bb/domain";
import { Icon } from "@bb/shared-ui/icon";

export function nativeTerminalWaitingPrompts(
  interactions: readonly PendingInteraction[],
): string[] {
  return interactions.flatMap((interaction) => {
    if (
      interaction.status !== "pending" ||
      isPluginPendingInteraction(interaction) ||
      !isUserQuestionPendingInteractionPayload(interaction.payload)
    ) {
      return [];
    }
    return interaction.payload.questions.map((question) => question.prompt);
  });
}

interface NativeTerminalWaitingBannerProps {
  prompts: readonly string[];
  providerLabel: string;
}

export function NativeTerminalWaitingBanner({
  prompts,
  providerLabel,
}: NativeTerminalWaitingBannerProps) {
  if (prompts.length === 0) return null;
  return (
    <div
      className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2 text-xs"
      data-native-terminal-waiting=""
      role="status"
    >
      <Icon
        name="CircleQuestion"
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          {providerLabel} is waiting for your answer in the terminal
        </p>
        <ul className="mt-0.5 space-y-0.5 text-muted-foreground">
          {prompts.map((prompt) => (
            <li key={prompt} className="line-clamp-2 whitespace-pre-line">
              {prompt}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
