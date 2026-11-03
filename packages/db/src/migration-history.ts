export interface PublishedMigrationWhen {
  tag: string;
  when: number;
}

export interface CompatibleMigrationHash {
  hash: string;
  tag: string;
  when: number;
  appliedWhen?: number;
}

export const publishedMigrationWhens = [
  { tag: "0000_baseline", when: 1778891867195 },
  { tag: "0001_terminal_session_user_input", when: 1779139400000 },
  { tag: "0002_closed_session_prune_indexes", when: 1779139400001 },
] as const satisfies readonly PublishedMigrationWhen[];

export const compatibleMigrationHashes = [
  {
    tag: "0031_mysterious_zaran",
    when: 1781403656069,
    hash: "bc111f5134183c37cf135af70231ec5a79823f9868818fdd8377e1ab3c05a23f",
  },
  {
    tag: "0039_thread_search",
    when: 1781660000001,
    hash: "025358fe89253aec7f5bd970dc3eb88d0e834f0d58fb9d75329a5d39899340f4",
  },
  {
    tag: "0103_wandering_mongoose",
    when: 1787181956957,
    hash: "79d39e7b68d1db8ba02614fe4cc227cc0c154d77c7183f2e37ed2d8475412993",
  },
  {
    tag: "0111_known_morph",
    when: 1788219579088,
    hash: "eda4daf7f011d8718c21d3fbd71030f30438863cd1e6ceddd32a5052fb3a14cd",
  },
  {
    tag: "0132_thread_drafts",
    when: 1790322211064,
    hash: "34086c32a5765e290293be611f00de29327ad1903e663f11b93d88eacfb95f7f",
  },
  {
    tag: "0144_thread_parent_notifications",
    when: 1792016697708,
    appliedWhen: 1792193667184,
    hash: "b56954240864756e3184bcd8ebd30f67927fd01aee72f6a9ec00741e1da0b5d7",
  },
  {
    tag: "0145_terminal_sessions_status_thread_index",
    when: 1792208936004,
    appliedWhen: 1792470678777,
    hash: "43e7562f9de43436a9ba4c2ab77246d0b550f47a8e5190e1c2956db123263658",
  },
  {
    tag: "0145_terminal_sessions_status_thread_index",
    when: 1792208936004,
    appliedWhen: 1792693676447,
    hash: "a26f91de1b18228b2739eded945ee5c7bf40886efc1a78818dee7f14a351f32d",
  },
  {
    tag: "0146_diff_viewed_files",
    when: 1792453324528,
    appliedWhen: 1792693676447,
    hash: "a26f91de1b18228b2739eded945ee5c7bf40886efc1a78818dee7f14a351f32d",
  },
] as const satisfies readonly CompatibleMigrationHash[];

export const publishedMigrationWhensByTag: ReadonlyMap<string, number> =
  new Map(publishedMigrationWhens.map((entry) => [entry.tag, entry.when]));
