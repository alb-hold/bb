import { defineSplit } from "./define-split";

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
