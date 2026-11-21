import type { RegistrySkill } from "@bb/server-contract";
import { sdk } from "@/lib/sdk";

export async function fetchRegistrySkillEntry(
  id: string,
  signal?: AbortSignal,
): Promise<RegistrySkill> {
  return sdk.skills.registry.get({ registrySkillId: id, signal });
}
