import { z } from "zod";

export const pluginFrontendInventorySchema = z.strictObject({
  version: z.literal(1),
  settingsSections: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-zA-Z0-9_-]+$/u),
        title: z.string().optional(),
        description: z.string().optional(),
        experimental_page: z.literal("mobile").optional(),
      }),
    )
    .min(1),
});

export type PluginFrontendInventory = z.infer<
  typeof pluginFrontendInventorySchema
>;

export function parsePluginFrontendInventory(
  value: unknown,
): PluginFrontendInventory | null {
  const parsed = pluginFrontendInventorySchema.safeParse(value);
  if (!parsed.success) return null;
  const ids = parsed.data.settingsSections.map((section) => section.id);
  return new Set(ids).size === ids.length ? parsed.data : null;
}
