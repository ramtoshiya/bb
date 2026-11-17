import { isRawThreadId } from "@bb/domain";

type MentionTokenKind = "serializedId" | "rawThreadId" | "path";

const SERIALIZED_ID_PREFIX_PATTERN = /^@(?:thread|project|section|folder):/u;
const WORD_BEFORE_PATTERN = /[\p{L}\p{N}_.+-]/u;
const PATH_CONTINUATION_PATTERN = /[\p{L}\p{N}_.+\/-]/u;
const ID_CONTINUATION_PATTERN = /[A-Za-z\p{N}_.+\/-]/u;
const SENTENCE_PERIOD_FOLLOWER_PATTERN = /[\s,;:!?)}\]"'’”]/u;
const PATH_SEGMENT_CONTINUATION_PATTERN =
  /^\s+(?:[\p{L}\p{N}._-]+(?:\s+|\/))*[\p{L}\p{N}_-]+(?:\/|\.[\p{L}\p{N}_-]+)(?=$|[\s,;:!?)}\]])/u;

export function isBoundedMentionToken(
  text: string,
  start: number,
  end: number,
): boolean {
  const kind = mentionTokenKind(text.slice(start, end));
  return (
    hasStartBoundary(text, start, kind) &&
    hasEndBoundary(text, end, kind) &&
    (kind !== "path" ||
      !PATH_SEGMENT_CONTINUATION_PATTERN.test(text.slice(end)))
  );
}

function mentionTokenKind(token: string): MentionTokenKind {
  if (isRawThreadId(token)) return "rawThreadId";
  return SERIALIZED_ID_PREFIX_PATTERN.test(token) ? "serializedId" : "path";
}

function hasStartBoundary(
  text: string,
  start: number,
  kind: MentionTokenKind,
): boolean {
  const previous = text[start - 1];
  if (previous === undefined) return true;
  if (kind === "rawThreadId" && (previous === "/" || previous === "\\")) {
    return false;
  }
  return !WORD_BEFORE_PATTERN.test(previous);
}

function hasEndBoundary(
  text: string,
  end: number,
  kind: MentionTokenKind,
): boolean {
  const next = text[end];
  if (next === undefined) return true;
  if (kind === "rawThreadId" && next === "\\") return false;
  if (next === ".") {
    const afterPeriod = text[end + 1];
    return (
      afterPeriod === undefined ||
      SENTENCE_PERIOD_FOLLOWER_PATTERN.test(afterPeriod)
    );
  }
  return !(
    kind === "path" ? PATH_CONTINUATION_PATTERN : ID_CONTINUATION_PATTERN
  ).test(next);
}
