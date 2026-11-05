export function zodSourceUsage(source: string): { names: string[]; edges: string[] };
export function collectHostZodNames(entry: string, resolveImport: (specifier: string, importer: string) => Promise<string | null>): Promise<string[]>;
