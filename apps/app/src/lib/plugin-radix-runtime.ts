import * as radixCheckbox from "@radix-ui/react-checkbox";
import {
  Root,
  Slot,
  Slottable,
  createSlot,
  createSlottable,
} from "@radix-ui/react-slot";
import { composeRefs, useComposedRefs } from "@radix-ui/react-compose-refs";

export const radixRuntimeSlots = {
  radixCheckbox,
  radixSlot: { Root, Slot, Slottable, createSlot, createSlottable },
  radixComposeRefs: { composeRefs, useComposedRefs },
};
