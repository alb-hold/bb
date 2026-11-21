import { defineSplit } from "./define-split";
import type { VoiceInputButton as VoiceInputButtonView } from "@/components/promptbox/VoiceInputButton";
import type { VoiceInputTextarea as VoiceInputTextareaView } from "@/components/promptbox/VoiceInputTextarea";
import { Button } from "@bb/shared-ui/button";
import { useEffect, type ComponentProps } from "react";

type VoiceInputButtonProps = ComponentProps<typeof VoiceInputButtonView>;
type VoiceInputTextareaProps = ComponentProps<typeof VoiceInputTextareaView>;

function VoiceInputButtonLoading({ warning, ...props }: VoiceInputButtonProps) {
  return (
    <Button
      {...props}
      aria-label={
        warning
          ? "Microphone warning: open voice preferences"
          : props["aria-label"]
      }
    />
  );
}

function VoiceInputTextareaLoading({
  value,
  onValueChange,
  onVoiceInputActiveChange,
  ...props
}: VoiceInputTextareaProps) {
  useEffect(() => {
    onVoiceInputActiveChange?.(false);
  }, [onVoiceInputActiveChange]);
  return (
    <textarea
      {...props}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    />
  );
}

export const PluginSdkVoiceInputButton = defineSplit<VoiceInputButtonProps>({
  id: "sdk-VoiceInputButton",
  load: () =>
    import("@/components/promptbox/VoiceInputButton").then(
      (module) => module.VoiceInputButton,
    ),
  loading: VoiceInputButtonLoading,
  tier: "intent",
});

export const PluginSdkVoiceInputTextarea =
  defineSplit<VoiceInputTextareaProps>({
    id: "sdk-VoiceInputTextarea",
    load: () =>
      import("@/components/promptbox/VoiceInputTextarea").then(
        (module) => module.VoiceInputTextarea,
      ),
    loading: VoiceInputTextareaLoading,
    tier: "intent",
  });

export const PluginBranchPicker = defineSplit({
  id: "sdk-PluginBranchPicker",
  tier: "intent",
  load: () =>
    import("@/components/plugin/PluginBranchPicker").then(
      (module) => module.PluginBranchPicker,
    ),
  loading: () => null,
});

export const PluginNewThreadComposer = defineSplit({
  id: "sdk-PluginNewThreadComposer",
  tier: "intent",
  load: () =>
    import("@/components/plugin/PluginNewThreadComposer").then(
      (module) => module.PluginNewThreadComposer,
    ),
  loading: () => null,
});

export const ImageLightbox = defineSplit({
  id: "sdk-ImageLightbox",
  tier: "intent",
  load: () =>
    import("@/components/ui/image-lightbox").then(
      (module) => module.ImageLightbox,
    ),
  loading: () => null,
  mountWhen: (props) => props.isOpen ?? props.imageSrc !== null,
  keepMounted: true,
});

export const PluginProviderModelPicker = defineSplit({
  id: "sdk-PluginProviderModelPicker",
  tier: "intent",
  load: () =>
    import("@/components/plugin/PluginProviderModelPicker").then(
      (module) => module.PluginProviderModelPicker,
    ),
  loading: () => null,
});

export const PluginPermissionModePicker = defineSplit({
  id: "sdk-PluginPermissionModePicker",
  tier: "intent",
  load: () =>
    import("@/components/plugin/PluginPermissionModePicker").then(
      (module) => module.PluginPermissionModePicker,
    ),
  loading: () => null,
});

export const ExperimentalFilePreview = defineSplit({
  id: "sdk-ExperimentalFilePreview",
  tier: "intent",
  load: () =>
    import("@/components/plugin/ExperimentalFilePreview").then(
      (module) => module.ExperimentalFilePreview,
    ),
  loading: () => null,
});

export const CollapsibleStackCard = defineSplit({
  id: "sdk-CollapsibleStackCard",
  tier: "intent",
  load: () =>
    import("@/components/promptbox/banner/CollapsibleStackCard").then(
      (module) => module.CollapsibleStackCard,
    ),
  loading: () => null,
});
