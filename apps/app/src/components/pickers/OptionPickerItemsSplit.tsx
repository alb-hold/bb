import { defineSplit } from "@/lib/define-split";
export const OptionPickerItems = defineSplit({
  id: "option-picker-items",
  tier: "intent",
  load: () =>
    import("./OptionPickerItems").then((module) => module.OptionPickerItems),
  loading: () => null,
});
