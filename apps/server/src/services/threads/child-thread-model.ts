interface ChildThreadModelArgs {
  parentThreadId: string | null | undefined;
  declaredChildModel: string | null | undefined;
}

export function childThreadModel(args: ChildThreadModelArgs): string | null {
  if (!args.parentThreadId) {
    return null;
  }
  return args.declaredChildModel ?? null;
}
