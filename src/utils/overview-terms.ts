/**
 * Overview term extraction: noise stripping, tokenization, stop words, and
 * the folder-path helpers shared by the overview pipeline (core/overview.ts)
 * and its SQLite store (utils/overview-store.ts — schema v2 needs the folder
 * token exclusion inside the database). Extracted verbatim from
 * core/overview.ts for #125: the candidate filter runs in SQL at write time,
 * so the store must compute the same folderKeywordTokens set itself.
 */

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`]+`/g;
const URL_RE = /https?:\/\/[^\s)>\]]+/g;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const HEX_HASH_RE = /\b[a-f0-9]{8,}\b/g;
// Structured noise from imported/converted documents (OCR'd PDFs, DocuSign
// exports, HTML conversions). Stripped before tokenization so ID shrapnel
// ("DAB4-BCF3-..." → "dab", "bcf") never reaches keyword scoring.
const DASHED_HEX_RE = /\b[0-9a-f]{2,}(?:-[0-9a-f]{2,})+\b/gi;
const DIGIT_BLOB_RE = /\b(?=[0-9a-z]*\d)(?=[0-9a-z]*[a-z])[0-9a-z]{6,}\b/gi;
const HTML_TAG_RE = /<\/?[a-z][^>]*>/gi;
const HTML_ENTITY_RE = /&[a-z]+;|&#\d+;/gi;
const HEXLETTER_RUN_RE = /\b[a-f]{7,}\b/gi;

const TOKEN_RE = /[a-z]{3,}/g;

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "is",
  "it",
  "as",
  "be",
  "was",
  "are",
  "this",
  "that",
  "not",
  "has",
  "have",
  "had",
  "will",
  "can",
  "may",
  "do",
  "does",
  "did",
  "been",
  "being",
  "would",
  "could",
  "should",
  "its",
  "my",
  "your",
  "our",
  "their",
  "his",
  "her",
  "we",
  "they",
  "you",
  "he",
  "she",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "than",
  "too",
  "very",
  "just",
  "about",
  "above",
  "after",
  "again",
  "also",
  "any",
  "because",
  "before",
  "between",
  "down",
  "during",
  "even",
  "first",
  "get",
  "how",
  "if",
  "into",
  "like",
  "made",
  "make",
  "many",
  "much",
  "new",
  "no",
  "now",
  "off",
  "old",
  "only",
  "one",
  "out",
  "over",
  "own",
  "same",
  "so",
  "still",
  "then",
  "there",
  "these",
  "those",
  "through",
  "under",
  "up",
  "use",
  "used",
  "using",
  "want",
  "way",
  "well",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "work",
  "see",
  "here",
  "need",
  "etc",
  "two",
  "next",
  "per",
  "via",
  "vs",
  "yet",
  "ago",
  "due",
  "tbd",
]); // prettier-ignore

const DIGIT_RE = /\d/;

/**
 * Each replace is guarded by a necessary condition of its pattern (an email
 * must contain "@", a URL "http", ...) so clean prose skips the expensive
 * regex scans entirely. Guards never change the result: when the guard is
 * false the pattern cannot match. HEX_HASH_RE can skip when no digit remains
 * because HEXLETTER_RUN_RE has already removed pure-letter hex runs ≥7.
 */
export function stripNoise(text: string): string {
  let out = text;
  if (out.includes("```")) out = out.replace(CODE_BLOCK_RE, "");
  if (out.includes("`")) out = out.replace(INLINE_CODE_RE, "");
  if (out.includes("http")) out = out.replace(URL_RE, "");
  if (out.includes("@")) out = out.replace(EMAIL_RE, "");
  if (out.includes("<")) out = out.replace(HTML_TAG_RE, " ");
  if (out.includes("&")) out = out.replace(HTML_ENTITY_RE, " ");
  const hasDigit = DIGIT_RE.test(out);
  if (out.includes("-")) out = out.replace(DASHED_HEX_RE, " ");
  if (hasDigit) out = out.replace(DIGIT_BLOB_RE, " ");
  out = out.replace(HEXLETTER_RUN_RE, " ");
  if (hasDigit) out = out.replace(HEX_HASH_RE, "");
  return out;
}

export function tokenize(text: string): string[] {
  const cleaned = stripNoise(text);
  return (cleaned.toLowerCase().match(TOKEN_RE) || []).filter(
    (w) => !STOP_WORDS.has(w),
  );
}

/** Depth of a folder path: root `/` is 0, `amazon` is 1, `amazon/features` is 2. */
export function folderDepth(folder: string): number {
  return folder === "/" ? 0 : folder.split("/").length;
}

export function folderKeywordTokens(folderPath: string): Set<string> {
  const tokens = new Set<string>();
  for (const segment of folderPath.split("/")) {
    for (const token of tokenize(segment)) {
      tokens.add(token);
      tokens.add(token.endsWith("s") ? token.slice(0, -1) : `${token}s`);
    }
  }
  return tokens;
}

/** term → flags byte: bit 0 = contains a space, bit 1 = "x x" self-pair. */
export function termFlags(term: string): number {
  const sp = term.indexOf(" ");
  if (sp < 0) return 0;
  return term.slice(0, sp) === term.slice(sp + 1) ? 3 : 1;
}
