import type {
  ExperimentalMessageMetadataRegistration,
  ExperimentalTabRegistration,
  PluginAppDefinition,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  requireComponent,
  requireNonEmptyString,
  requireSlotId,
  requireUniqueId,
} from "./composer-customization-validation.js";

export function collectPanelAction<C, Run>(
  kind: string,
  seen: Set<string>,
  registration: {
    id: string;
    title: string;
    icon?: string;
    component: C;
    layout?: "padded" | "flush";
    run?: Run;
  },
): {
  id: string;
  title: string;
  icon?: string;
  component: C;
  layout?: "padded" | "flush";
  run?: Run;
} {
  const id = requireSlotId(kind, registration?.id);
  requireUniqueId(kind, seen, id);
  if (
    registration.run !== undefined &&
    typeof registration.run !== "function"
  ) {
    throw new Error(`${kind}: "run" must be a function when set`);
  }
  if (
    registration.layout !== undefined &&
    registration.layout !== "padded" &&
    registration.layout !== "flush"
  ) {
    throw new Error(`${kind}: "layout" must be "padded" or "flush"`);
  }
  return {
    id,
    title: requireNonEmptyString(kind, "title", registration.title),
    ...(registration.icon !== undefined
      ? { icon: requireNonEmptyString(kind, "icon", registration.icon) }
      : {}),
    component: requireComponent<C>(kind, registration.component),
    ...(registration.layout !== undefined
      ? { layout: registration.layout }
      : {}),
    ...(registration.run !== undefined ? { run: registration.run } : {}),
  };
}

export function createThreadSlotCollector() {
  const tabs: ExperimentalTabRegistration[] = [];
  const messageMetadata: ExperimentalMessageMetadataRegistration[] = [];
  const tabIds = new Set<string>();
  const metadataIds = new Set<string>();

  function collectTab(value: unknown, legacy = false): void {
    const registration = value as ExperimentalTabRegistration;
    const kind = "slots.experimental_tab";
    const id = requireSlotId(kind, registration?.id);
    const context = registration.context;
    if (context?.kind !== "thread" && context?.kind !== "nav-panel") {
      throw new Error(`${kind}: context must be thread or nav-panel`);
    }
    if (context.kind === "nav-panel") requireSlotId(kind, context.panelId);
    const availability = registration.availability;
    if (availability !== "fixed" && availability !== "action") {
      throw new Error(`${kind}: availability must be fixed or action`);
    }
    requireUniqueId(
      kind,
      tabIds,
      `${context.kind}/${context.kind === "nav-panel" ? context.panelId : ""}/${id}`,
    );
    if (
      registration.useVisible !== undefined &&
      typeof registration.useVisible !== "function"
    ) {
      throw new Error(`${kind}: useVisible must be a function`);
    }
    if (
      availability === "fixed" &&
      (registration.run !== undefined || registration.params !== undefined)
    ) {
      throw new Error(`${kind}: run and params require action availability`);
    }
    const target = registration.experimental_target;
    if (
      target !== undefined &&
      (availability !== "fixed" || typeof target?.validate !== "function")
    ) {
      throw new Error(
        `${kind}: experimental_target requires a fixed tab and a validate function`,
      );
    }
    const validated = {
      ...registration,
      ...collectPanelAction<
        ExperimentalTabRegistration["component"],
        ExperimentalTabRegistration["run"]
      >(kind, new Set(), {
        ...registration,
        icon:
          legacy && registration.icon === "" ? undefined : registration.icon,
      }),
      icon:
        legacy && registration.icon === ""
          ? ""
          : requireNonEmptyString(kind, "icon", registration.icon),
      ...(registration.tooltip === undefined
        ? {}
        : {
            tooltip: requireNonEmptyString(
              kind,
              "tooltip",
              registration.tooltip,
            ),
          }),
      ...(availability === "action" && registration.params !== undefined
        ? { params: z.json().parse(registration.params) }
        : {}),
    };
    tabs.push(validated as ExperimentalTabRegistration);
  }

  const slots: Pick<
    Parameters<PluginAppDefinition["setup"]>[0]["slots"],
    "experimental_tab" | "experimental_messageMetadata"
  > = {
    experimental_tab(value: unknown) {
      collectTab(value);
    },
    experimental_messageMetadata(registration) {
      const kind = "slots.experimental_messageMetadata";
      const id = requireSlotId(kind, registration?.id);
      requireUniqueId(kind, metadataIds, id);
      const placement = registration.placement ?? "above";
      if (placement !== "above" && placement !== "actionRow") {
        throw new Error(
          `${kind}: "placement" must be "above" or "actionRow"`,
        );
      }
      messageMetadata.push({
        id,
        placement,
        component: requireComponent(kind, registration.component),
      });
    },
  };
  return {
    slots,
    tabs,
    messageMetadata,
    collectLegacyTab: (value: unknown) => collectTab(value, true),
  };
}
