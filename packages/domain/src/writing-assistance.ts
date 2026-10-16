import { z } from "zod";

export const WRITING_MODES = [
  "natural",
  "developer",
  "prompt",
  "verbatim",
  "polished",
  "literal-code",
] as const;
export const writingModeSchema = z.enum(WRITING_MODES);
export type WritingMode = z.infer<typeof writingModeSchema>;

export const CORRECTION_BEHAVIORS = ["automatic", "suggest", "off"] as const;
export const correctionBehaviorSchema = z.enum(CORRECTION_BEHAVIORS);
export type CorrectionBehavior = z.infer<typeof correctionBehaviorSchema>;

export const WRITING_VOCABULARY_MAX_TERMS = 200;
export const WRITING_VOCABULARY_TERM_MAX_LENGTH = 64;

export const writingVocabularyTermSchema = z
  .string()
  .trim()
  .min(1)
  .max(WRITING_VOCABULARY_TERM_MAX_LENGTH)
  .regex(/^[^\r\n<>]+$/u, "Terms are single-line and cannot contain < or >");

export const writingAssistanceSettingsSchema = z
  .object({
    mode: writingModeSchema,
    typingCorrection: correctionBehaviorSchema,
    dictationFormatting: z.boolean(),
    vocabulary: z
      .array(writingVocabularyTermSchema)
      .max(WRITING_VOCABULARY_MAX_TERMS),
    dailyCorrectionLimit: z.number().int().min(0).max(5_000),
    dailyDictationMinutes: z.number().int().min(0).max(1_440),
  })
  .strict();
export type WritingAssistanceSettings = z.infer<
  typeof writingAssistanceSettingsSchema
>;

export const defaultWritingAssistanceSettings: WritingAssistanceSettings = {
  mode: "prompt",
  typingCorrection: "automatic",
  dictationFormatting: true,
  vocabulary: [],
  dailyCorrectionLimit: 300,
  dailyDictationMinutes: 60,
};

export const writingAssistanceSettingsUpdateSchema =
  writingAssistanceSettingsSchema.partial().strict();
export type WritingAssistanceSettingsUpdate = z.infer<
  typeof writingAssistanceSettingsUpdateSchema
>;

export const WRITING_EDIT_CATEGORIES = [
  "spelling",
  "grammar",
  "punctuation",
  "capitalization",
  "structure",
  "speech-recognition",
  "word-choice",
  "formatting",
] as const;
export const writingEditCategorySchema = z.enum(WRITING_EDIT_CATEGORIES);
export type WritingEditCategory = z.infer<typeof writingEditCategorySchema>;

export const writingConfidenceSchema = z.enum(["high", "medium", "low"]);
export type WritingConfidence = z.infer<typeof writingConfidenceSchema>;

export const writingSemanticImpactSchema = z.enum([
  "none",
  "possible",
  "likely",
]);
export type WritingSemanticImpact = z.infer<typeof writingSemanticImpactSchema>;

export const writingEditDispositionSchema = z.enum(["apply", "suggest"]);
export type WritingEditDisposition = z.infer<
  typeof writingEditDispositionSchema
>;

export const proposedWritingEditSchema = z.object({
  original: z.string().min(1).max(400),
  replacement: z.string().max(400),
  category: writingEditCategorySchema,
  confidence: writingConfidenceSchema,
  semanticImpact: writingSemanticImpactSchema,
  explanation: z.string().max(200).nullable().catch(null),
});
export type ProposedWritingEdit = z.infer<typeof proposedWritingEditSchema>;

export const writingEditSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    original: z.string(),
    replacement: z.string(),
    category: writingEditCategorySchema,
    confidence: writingConfidenceSchema,
    semanticImpact: writingSemanticImpactSchema,
    explanation: z.string().nullable(),
    disposition: writingEditDispositionSchema,
  })
  .strict();
export type WritingEdit = z.infer<typeof writingEditSchema>;

export const WRITING_TARGET_MAX_CHARS = 2_000;
export const WRITING_CONTEXT_MAX_CHARS = 600;

export const writingCorrectionRequestSchema = z
  .object({
    target: z.string().min(1).max(WRITING_TARGET_MAX_CHARS),
    context: z.string().max(WRITING_CONTEXT_MAX_CHARS),
    complete: z.boolean(),
  })
  .strict();
export type WritingCorrectionRequest = z.infer<
  typeof writingCorrectionRequestSchema
>;

export const WRITING_SKIP_REASONS = [
  "off",
  "budget",
  "unavailable",
  "timeout",
  "failed",
] as const;
export const writingSkipReasonSchema = z.enum(WRITING_SKIP_REASONS);
export type WritingSkipReason = z.infer<typeof writingSkipReasonSchema>;

export const writingCorrectionResponseSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("ok"), edits: z.array(writingEditSchema) })
    .strict(),
  z
    .object({
      status: z.literal("skipped"),
      reason: writingSkipReasonSchema,
      message: z.string(),
    })
    .strict(),
]);
export type WritingCorrectionResponse = z.infer<
  typeof writingCorrectionResponseSchema
>;

export const dictationSegmentResponseSchema = z
  .object({
    raw: z.string(),
    text: z.string(),
    formatted: z.boolean(),
  })
  .strict();
export type DictationSegmentResponse = z.infer<
  typeof dictationSegmentResponseSchema
>;

export const writingUsageSchema = z
  .object({
    day: z.string(),
    corrections: z.number().int().nonnegative(),
    formattings: z.number().int().nonnegative(),
    dictationSegments: z.number().int().nonnegative(),
    audioSeconds: z.number().nonnegative(),
    inputChars: z.number().int().nonnegative(),
    outputChars: z.number().int().nonnegative(),
    estimatedCostMicros: z.number().int().nonnegative(),
  })
  .strict();
export type WritingUsage = z.infer<typeof writingUsageSchema>;

export const writingAssistanceViewSchema = z
  .object({
    settings: writingAssistanceSettingsSchema,
    usage: writingUsageSchema,
    correctionAvailable: z.boolean(),
  })
  .strict();
export type WritingAssistanceView = z.infer<typeof writingAssistanceViewSchema>;

export type ProtectedSpanKind =
  | "code"
  | "url"
  | "path"
  | "identifier"
  | "number"
  | "flag"
  | "constant"
  | "mention"
  | "vocabulary";

export interface ProtectedSpan {
  start: number;
  end: number;
  kind: ProtectedSpanKind;
}

const PROTECTED_PATTERNS: readonly (readonly [ProtectedSpanKind, RegExp])[] = [
  ["code", /```[\s\S]*?(?:```|$)/gu],
  ["code", /`[^`\n]+`/gu],
  ["url", /\b(?:https?|wss?|ftp|file):\/\/[^\s<>"'`]+/giu],
  ["url", /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gu],
  ["path", /(?:~|\.{1,2})?\/[\w.@~+-]+(?:\/[\w.@~+-]*)*/gu],
  ["path", /\b[\w@.-]+(?:\/[\w@.-]+)+\b/gu],
  ["path", /\b[\w-]+\.[a-z][a-z0-9]{0,5}\b(?=[^\p{L}]|$)/gu],
  ["flag", /(?<![\p{L}\p{N}])--?[a-zA-Z][\w-]*/gu],
  ["identifier", /\b\w+\(\)/gu],
  ["identifier", /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/gu],
  ["identifier", /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/gu],
  ["identifier", /\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+\b/gu],
  ["identifier", /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/gu],
  ["constant", /\b[A-Z][A-Z0-9]{1,}\b/gu],
  ["number", /\bv?\d+(?:[.,:x/-]\d+)*%?\b/gu],
  ["mention", /(?<![\p{L}\p{N}])[@#][\w./-]+/gu],
];

const LIST_INDEX_PATTERN = /^\d{1,2}$/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function mergeSpans(spans: ProtectedSpan[]): ProtectedSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: ProtectedSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start < last.end) {
      if (span.end > last.end) last.end = span.end;
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

export function findProtectedSpans(
  text: string,
  vocabulary: readonly string[] = [],
): ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];
  for (const [kind, pattern] of PROTECTED_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      if (kind === "number" && LIST_INDEX_PATTERN.test(match[0])) continue;
      spans.push({ start, end: start + match[0].length, kind });
    }
  }
  for (const term of vocabulary) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`,
      "gu",
    );
    for (const match of text.matchAll(pattern)) {
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        kind: "vocabulary",
      });
    }
  }
  return mergeSpans(spans);
}

export function overlapsProtectedSpan(
  spans: readonly ProtectedSpan[],
  start: number,
  end: number,
): boolean {
  return spans.some((span) =>
    start === end
      ? start > span.start && start < span.end
      : start < span.end && end > span.start,
  );
}

function damerauLevenshtein(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () =>
    new Array<number>(cols).fill(0),
  );
  for (let i = 0; i < rows; i += 1) d[i]![0] = i;
  for (let j = 0; j < cols; j += 1) d[0]![j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = value;
    }
  }
  return d[a.length]![b.length]!;
}

export function wordTokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}'’]+/gu) ?? [];
}

const AGREEMENT_GROUPS: readonly (readonly string[])[] = [
  ["is", "are", "am", "be"],
  ["was", "were"],
  ["has", "have"],
  ["does", "do"],
  ["a", "an"],
  ["its", "it's", "it’s"],
  ["there", "their", "they're", "they’re"],
  ["your", "you're", "you’re"],
  ["isn't", "aren't"],
  ["wasn't", "weren't"],
  ["hasn't", "haven't"],
  ["doesn't", "don't"],
  ["é", "e"],
  ["está", "esta"],
  ["não", "nao"],
];

const INFLECTION_SUFFIXES = ["s", "es", "ed", "d", "ing"];

function isAgreementSwap(a: string, b: string): boolean {
  return AGREEMENT_GROUPS.some(
    (group) => group.includes(a) && group.includes(b),
  );
}

function isInflection(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 3) return false;
  return INFLECTION_SUFFIXES.some((suffix) => long === `${short}${suffix}`);
}

export type WritingChangeKind =
  | "surface"
  | "spelling"
  | "agreement"
  | "content";

function letters(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function classifyWritingChange(
  original: string,
  replacement: string,
): WritingChangeKind {
  if (letters(original) === letters(replacement)) return "surface";
  const before = wordTokens(original);
  const after = wordTokens(replacement);
  if (before.length !== after.length) return "content";
  const changed: [string, string][] = [];
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== after[index]) {
      changed.push([before[index]!, after[index]!]);
    }
  }
  if (changed.length !== 1) return "content";
  const [from, to] = changed[0]!;
  if (isAgreementSwap(from, to) || isInflection(from, to)) return "agreement";
  const longest = Math.max(from.length, to.length);
  if (longest < 4) return "content";
  const distance = damerauLevenshtein(from, to, 2);
  if (distance <= 2 && distance / longest <= 0.34) return "spelling";
  return "content";
}

function findUniqueOccurrence(text: string, needle: string): number | null {
  const first = text.indexOf(needle);
  if (first < 0) return null;
  return text.indexOf(needle, first + 1) < 0 ? first : null;
}

function minimalChange(
  start: number,
  original: string,
  replacement: string,
): { start: number; end: number; original: string; replacement: string } {
  let prefix = 0;
  const maxPrefix = Math.min(original.length, replacement.length);
  while (prefix < maxPrefix && original[prefix] === replacement[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  const maxSuffix = Math.min(
    original.length - prefix,
    replacement.length - prefix,
  );
  while (
    suffix < maxSuffix &&
    original[original.length - 1 - suffix] ===
      replacement[replacement.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  while (prefix > 0 && /[\p{L}\p{N}]/u.test(original[prefix - 1]!)) {
    prefix -= 1;
  }
  while (
    suffix > 0 &&
    /[\p{L}\p{N}]/u.test(original[original.length - suffix]!)
  ) {
    suffix -= 1;
  }
  return {
    start: start + prefix,
    end: start + original.length - suffix,
    original: original.slice(prefix, original.length - suffix),
    replacement: replacement.slice(prefix, replacement.length - suffix),
  };
}

const AUTO_CATEGORIES: ReadonlySet<WritingEditCategory> = new Set([
  "spelling",
  "grammar",
  "punctuation",
  "capitalization",
]);

export interface ResolveWritingEditsArgs {
  target: string;
  proposals: readonly ProposedWritingEdit[];
  behavior: CorrectionBehavior;
  vocabulary: readonly string[];
  complete: boolean;
}

export function resolveWritingEdits(
  args: ResolveWritingEditsArgs,
): WritingEdit[] {
  if (args.behavior === "off") return [];
  const spans = findProtectedSpans(args.target, args.vocabulary);
  const accepted: WritingEdit[] = [];
  for (const proposal of args.proposals) {
    if (proposal.original === proposal.replacement) continue;
    const at = findUniqueOccurrence(args.target, proposal.original);
    if (at === null) continue;
    const change = minimalChange(at, proposal.original, proposal.replacement);
    if (change.original === change.replacement) continue;
    if (overlapsProtectedSpan(spans, change.start, change.end)) continue;
    if (
      accepted.some(
        (edit) => change.start < edit.end && change.end > edit.start,
      ) ||
      accepted.some(
        (edit) =>
          change.start === change.end &&
          edit.start === edit.end &&
          edit.start === change.start,
      )
    ) {
      continue;
    }
    const kind = classifyWritingChange(change.original, change.replacement);
    const deterministicSafe =
      kind === "surface" ||
      ((kind === "spelling" || kind === "agreement") &&
        proposal.category !== "word-choice" &&
        proposal.category !== "speech-recognition");
    const apply =
      args.behavior === "automatic" &&
      args.complete &&
      deterministicSafe &&
      AUTO_CATEGORIES.has(proposal.category) &&
      proposal.confidence === "high" &&
      proposal.semanticImpact === "none";
    if (
      !apply &&
      (proposal.confidence === "low" || proposal.semanticImpact === "likely") &&
      kind === "content" &&
      proposal.category === "structure"
    ) {
      continue;
    }
    accepted.push({
      ...change,
      category: proposal.category,
      confidence: proposal.confidence,
      semanticImpact:
        kind === "content" && proposal.semanticImpact === "none"
          ? "possible"
          : proposal.semanticImpact,
      explanation: proposal.explanation,
      disposition: apply ? "apply" : "suggest",
    });
  }
  return accepted.sort((a, b) => a.start - b.start);
}

const NUMBER_WORDS: ReadonlySet<string> = new Set([
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "um",
  "dois",
  "duas",
  "três",
  "tres",
  "quatro",
  "cinco",
  "seis",
  "sete",
  "oito",
  "nove",
  "dez",
  "primeiro",
  "primeira",
  "segundo",
  "segunda",
  "terceiro",
  "terceira",
  "quarto",
  "quarta",
  "quinto",
  "quinta",
]);

export type FormattedTranscriptVerdict =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "protected"
        | "added-words"
        | "dropped-words"
        | "negation"
        | "empty";
    };

const FILLER_WORDS: ReadonlySet<string> = new Set([
  "um",
  "umm",
  "uh",
  "uhm",
  "uhh",
  "er",
  "erm",
  "ah",
  "ahn",
  "eh",
  "hmm",
  "hum",
  "né",
]);

const LIST_CONNECTORS: ReadonlySet<string> = new Set([
  "and",
  "then",
  "next",
  "finally",
  "lastly",
  "also",
  "e",
  "depois",
  "então",
  "entao",
]);

const NEGATIONS: ReadonlySet<string> = new Set([
  "not",
  "no",
  "never",
  "nothing",
  "nobody",
  "none",
  "nor",
  "neither",
  "without",
  "cannot",
  "não",
  "nao",
  "nunca",
  "nem",
  "nada",
  "ninguém",
  "ninguem",
  "sem",
  "jamais",
]);

const CORRECTION_MARKERS: readonly (readonly string[])[] = [
  ["no", "wait"],
  ["no", "sorry"],
  ["wait", "no"],
  ["i", "mean"],
  ["scratch", "that"],
  ["or", "rather"],
  ["sorry"],
  ["actually"],
  ["quer", "dizer"],
  ["ou", "melhor"],
  ["na", "verdade"],
  ["aliás"],
  ["alias"],
  ["digo"],
  ["não", "espera"],
  ["nao", "espera"],
];

const CORRECTION_WINDOW = 6;

function isNegation(token: string): boolean {
  return NEGATIONS.has(token) || /n['’]t$/u.test(token);
}

function nearVariant(word: string, token: string): boolean {
  const longest = Math.max(word.length, token.length);
  if (longest < 4) return false;
  if (isInflection(word, token) || isAgreementSwap(word, token)) return true;
  const distance = damerauLevenshtein(word, token, 2);
  return distance <= 2 && distance / longest <= 0.34;
}

function allowedNovelToken(
  token: string,
  source: ReadonlySet<string>,
): boolean {
  if (/^\d{1,2}$/u.test(token)) return true;
  for (const word of source) {
    if (nearVariant(word, token)) return true;
  }
  return false;
}

function correctionCoverage(tokens: readonly string[]): {
  marker: boolean[];
  window: boolean[];
} {
  const marker = tokens.map(() => false);
  const window = tokens.map(() => false);
  let previousEnd = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const match = CORRECTION_MARKERS.find((phrase) =>
      phrase.every((word, offset) => tokens[index + offset] === word),
    );
    if (match === undefined) continue;
    for (let offset = 0; offset < match.length; offset += 1) {
      marker[index + offset] = true;
    }
    for (
      let before = Math.max(previousEnd, index - CORRECTION_WINDOW);
      before < index;
      before += 1
    ) {
      window[before] = true;
    }
    previousEnd = index + match.length;
    index = previousEnd - 1;
  }
  return { marker, window };
}

function droppedTokens(
  rawTokens: readonly string[],
  formattedTokens: readonly string[],
  deferred: readonly boolean[],
): boolean[] {
  const remaining = new Map<string, number>();
  for (const token of formattedTokens) {
    remaining.set(token, (remaining.get(token) ?? 0) + 1);
  }
  const rawSet = new Set(rawTokens);
  const novel = formattedTokens.filter((token) => !rawSet.has(token));
  const dropped = rawTokens.map(() => false);
  const order = rawTokens
    .map((_token, index) => index)
    .sort((a, b) => Number(deferred[a]) - Number(deferred[b]) || a - b);
  for (const index of order) {
    const token = rawTokens[index]!;
    const count = remaining.get(token) ?? 0;
    if (count > 0) {
      remaining.set(token, count - 1);
      continue;
    }
    dropped[index] = !novel.some((candidate) => nearVariant(token, candidate));
  }
  return dropped;
}

const SPOKEN_SYMBOLS: ReadonlySet<string> = new Set([
  "dash",
  "hyphen",
  "dot",
  "comma",
  "colon",
  "semicolon",
  "slash",
  "backslash",
  "underscore",
  "equals",
  "paren",
  "parens",
  "parenthesis",
  "bracket",
  "brace",
  "quote",
  "backtick",
  "asterisk",
  "ampersand",
  "tilde",
  "newline",
  "camelcase",
  "ponto",
  "vírgula",
  "virgula",
  "barra",
  "traço",
  "traco",
  "hífen",
  "hifen",
  "parênteses",
  "parenteses",
  "colchete",
  "aspas",
  "sublinhado",
  "underline",
  "arroba",
  "cerquilha",
]);

function splitJoinedToken(
  token: string,
  rawTokens: readonly string[],
): string[] | null {
  for (let start = 0; start < rawTokens.length; start += 1) {
    let joined = "";
    for (
      let end = start;
      end < Math.min(rawTokens.length, start + 5);
      end += 1
    ) {
      joined += rawTokens[end]!;
      if (end > start && joined === token)
        return rawTokens.slice(start, end + 1);
      if (!token.startsWith(joined)) break;
    }
  }
  return null;
}

export function validateFormattedTranscript(
  raw: string,
  formatted: string,
  vocabulary: readonly string[] = [],
  options: { literalCode: boolean } = { literalCode: false },
): FormattedTranscriptVerdict {
  if (formatted.trim().length === 0) return { ok: false, reason: "empty" };
  for (const span of findProtectedSpans(raw, vocabulary)) {
    if (span.kind === "number") continue;
    if (!formatted.includes(raw.slice(span.start, span.end))) {
      return { ok: false, reason: "protected" };
    }
  }
  const rawTokens = wordTokens(raw);
  const source = new Set(rawTokens);
  const vocabularyTokens = new Set(
    vocabulary.flatMap((term) => wordTokens(term)),
  );
  const rawNumbers = new Set(raw.match(/\d+(?:[.,]\d+)*/gu) ?? []);
  for (const number of formatted.match(/\d+(?:[.,]\d+)*/gu) ?? []) {
    if (!rawNumbers.has(number) && !/^\d{1,2}$/u.test(number)) {
      return { ok: false, reason: "added-words" };
    }
  }
  const formattedTokens = wordTokens(formatted).flatMap((token) =>
    options.literalCode && !source.has(token)
      ? (splitJoinedToken(token, rawTokens) ?? [token])
      : [token],
  );
  for (const token of formattedTokens) {
    if (source.has(token) || vocabularyTokens.has(token)) continue;
    if (allowedNovelToken(token, source)) continue;
    return { ok: false, reason: "added-words" };
  }
  const list = /^\s*\d{1,2}[.)]\s/mu.test(formatted);
  const { marker, window } = correctionCoverage(rawTokens);
  const dropped = droppedTokens(
    rawTokens,
    formattedTokens,
    rawTokens.map((_token, index) => marker[index]! || window[index]!),
  );
  const lostNegation = rawTokens.some(
    (token, index) => dropped[index] && !marker[index] && isNegation(token),
  );
  if (lostNegation) return { ok: false, reason: "negation" };
  for (let index = 0; index < rawTokens.length; index += 1) {
    if (!dropped[index]) continue;
    const token = rawTokens[index]!;
    if (marker[index] || window[index]) continue;
    if (FILLER_WORDS.has(token)) continue;
    if (options.literalCode && SPOKEN_SYMBOLS.has(token)) continue;
    if (index > 0 && rawTokens[index - 1] === token) continue;
    if (NUMBER_WORDS.has(token) && list) continue;
    if (LIST_CONNECTORS.has(token) && list) continue;
    return { ok: false, reason: "dropped-words" };
  }
  return { ok: true };
}

export function normalizeDictatedText(raw: string): string {
  return raw
    .replace(/[ \t]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .trim();
}
