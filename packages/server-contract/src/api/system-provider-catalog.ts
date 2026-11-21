import { z } from "zod";
import { providerInfoSchema } from "@bb/domain";

export const systemProviderCatalogEntrySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  pluginId: z.string(),
  pluginName: z.string(),
  pluginEnabled: z.boolean(),
  enabled: z.boolean(),
  available: z.boolean(),
  logoUrl: z.string().nullable(),
  info: providerInfoSchema.nullable(),
});
export type SystemProviderCatalogEntry = z.infer<
  typeof systemProviderCatalogEntrySchema
>;
