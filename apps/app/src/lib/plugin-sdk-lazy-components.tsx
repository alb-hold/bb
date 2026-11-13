import { defineSplit } from "./define-split";

export const WaveformVisualizer = defineSplit({
  id: "voice-waveform",
  tier: "intent",
  load: () =>
    import("@/components/promptbox/WaveformVisualizer").then(
      (module) => module.WaveformVisualizer,
    ),
  loading: () => null,
});

export const VoiceRecordingBar = defineSplit({
  id: "sdk-VoiceRecordingBar",
  tier: "intent",
  load: () =>
    import("@/components/promptbox/VoiceRecordingBar").then(
      (module) => module.VoiceRecordingBar,
    ),
  loading: () => null,
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
