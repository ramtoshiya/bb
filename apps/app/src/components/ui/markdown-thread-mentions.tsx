import { createContext, useContext } from "react";
import type { InlineCode, Nodes, Parent, PhrasingContent, Text } from "mdast";
import type {} from "mdast-util-to-hast";
import { visit } from "unist-util-visit";
import {
  isRawThreadId,
  RAW_THREAD_ID_PATTERN_SOURCE,
  type PromptMentionResource,
  type PromptTextMention,
} from "@bb/domain";
import {
  MessageMentionPill,
  PromptMentionPill,
  resolveThreadMentionResource,
} from "@/components/thread/timeline/ConversationMessageMentions.js";
import { isBoundedMentionToken } from "@/components/thread/mention-token-boundary.js";
import {
  useRawThreadMentionResource,
  useSidebarThreadMentionResource,
  useThreadMentionResource,
} from "@/components/thread/ThreadTitleMentions.js";
import { replaceTextMatches } from "./markdown-text-matches.js";

const THREAD_MENTION_PATTERN = new RegExp(
  `@thread:([A-Za-z0-9_-]+)(?:#msg=(0|[1-9]\\d*))?|(${RAW_THREAD_ID_PATTERN_SOURCE})`,
  "gu",
);
const RAW_THREAD_ID_PATTERN = new RegExp(RAW_THREAD_ID_PATTERN_SOURCE, "gu");
const CHARACTER_REFERENCE_PATTERN = /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/iu;
const THREAD_MENTION_PREFIX = "@thread";

const THREAD_MENTION_HAST_NAME = "bb-thread-mention";
const THREAD_MENTION_THREAD_ID_PROPERTY = "dataThreadId";
const RAW_THREAD_ID_PROPERTY = "dataRawThreadId";
const RAW_THREAD_INLINE_CODE_PROPERTY = "dataRawThreadInlineCode";
const MESSAGE_SEQ_PROPERTY = "dataMessageSeq";

interface ThreadMentionNodeArgs {
  threadId: string;
  messageSeq: string | null;
  rawThreadId: boolean;
  rawThreadInlineCode: boolean;
}

function threadMentionNode({
  threadId,
  messageSeq,
  rawThreadId,
  rawThreadInlineCode,
}: ThreadMentionNodeArgs): Text {
  return {
    type: "text",
    value: "",
    data: {
      hName: THREAD_MENTION_HAST_NAME,
      hProperties: {
        [THREAD_MENTION_THREAD_ID_PROPERTY]: threadId,
        ...(messageSeq === null ? {} : { [MESSAGE_SEQ_PROPERTY]: messageSeq }),
        ...(rawThreadId ? { [RAW_THREAD_ID_PROPERTY]: threadId } : {}),
        ...(rawThreadInlineCode
          ? { [RAW_THREAD_INLINE_CODE_PROPERTY]: "true" }
          : {}),
      },
    },
  };
}

interface PhrasingTextContext {
  offset: number;
  text: string;
}

function collectPhrasingTextContexts(
  tree: Nodes,
): WeakMap<object, PhrasingTextContext> {
  const contexts = new WeakMap<object, PhrasingTextContext>();
  visit(tree, (node) => {
    if (
      node.type !== "paragraph" &&
      node.type !== "heading" &&
      node.type !== "tableCell"
    ) {
      return;
    }

    const leaves: Array<{ node: InlineCode | Text; offset: number }> = [];
    let visibleText = "";
    visit(node, (descendant) => {
      if (descendant.type === "text" || descendant.type === "inlineCode") {
        leaves.push({ node: descendant, offset: visibleText.length });
        visibleText += descendant.value;
        return;
      }
      if (descendant.type === "image" || descendant.type === "imageReference") {
        visibleText += descendant.alt ?? "";
        return;
      }
      if (descendant.type === "break") {
        visibleText += "\n";
      }
    });
    for (const leaf of leaves) {
      contexts.set(leaf.node, { offset: leaf.offset, text: visibleText });
    }
  });
  return contexts;
}

function splitTextNodeOnMentions(
  node: Text,
  context: PhrasingTextContext | undefined,
): PhrasingContent[] {
  const { value } = node;
  return replaceTextMatches(node, THREAD_MENTION_PATTERN, (match) => {
    const serializedThreadId = match[1];
    const messageSeq = match[2] ?? null;
    const rawThreadId = match[3];
    const threadId = serializedThreadId ?? rawThreadId;
    const boundaryText =
      rawThreadId === undefined ? value : (context?.text ?? value);
    const boundaryStart =
      rawThreadId === undefined
        ? match.index
        : (context?.offset ?? 0) + match.index;
    if (
      threadId === undefined ||
      !isBoundedMentionToken(
        boundaryText,
        boundaryStart,
        boundaryStart + match[0].length,
      )
    ) {
      return null;
    }
    return threadMentionNode({
      threadId,
      messageSeq,
      rawThreadId: rawThreadId !== undefined,
      rawThreadInlineCode: false,
    });
  });
}

interface ParsedTextDirective {
  attributes: unknown;
  children: unknown;
  name: string;
  type: "textDirective";
}

function parseTextDirective(node: unknown): ParsedTextDirective | null {
  if (typeof node !== "object" || node === null) {
    return null;
  }
  const candidate = node as {
    attributes?: unknown;
    children?: unknown;
    name?: unknown;
    type?: unknown;
  };
  return candidate.type === "textDirective" &&
    typeof candidate.name === "string"
    ? {
        type: candidate.type,
        name: candidate.name,
        attributes: candidate.attributes,
        children: candidate.children,
      }
    : null;
}

function isUndecoratedTextDirective(directive: ParsedTextDirective): boolean {
  return (
    Array.isArray(directive.children) &&
    directive.children.length === 0 &&
    typeof directive.attributes === "object" &&
    directive.attributes !== null &&
    !Array.isArray(directive.attributes) &&
    Object.keys(directive.attributes).length === 0
  );
}

function collectAuthoredMarkdownLinkNodes(tree: Nodes): WeakSet<object> {
  const linkNodes = new WeakSet<object>();
  visit(tree, (node) => {
    if (node.type !== "link" && node.type !== "linkReference") {
      return;
    }
    visit(node, (descendant) => {
      linkNodes.add(descendant);
    });
  });
  return linkNodes;
}

interface RawThreadIdTextSegment {
  rawThreadId: string | null;
  text: string;
}

export function splitRawThreadIdsInText(
  text: string,
): RawThreadIdTextSegment[] {
  RAW_THREAD_ID_PATTERN.lastIndex = 0;
  const segments: RawThreadIdTextSegment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = RAW_THREAD_ID_PATTERN.exec(text)) !== null) {
    const matchEnd = match.index + match[0].length;
    if (!isBoundedMentionToken(text, match.index, matchEnd)) {
      continue;
    }
    if (match.index > cursor) {
      segments.push({
        rawThreadId: null,
        text: text.slice(cursor, match.index),
      });
    }
    segments.push({ rawThreadId: match[0], text: match[0] });
    cursor = matchEnd;
  }
  if (segments.length === 0) {
    return [{ rawThreadId: null, text }];
  }
  if (cursor < text.length) {
    segments.push({ rawThreadId: null, text: text.slice(cursor) });
  }
  return segments;
}

function inlineBareThreadMentionDirectives(tree: Nodes): void {
  visit(tree, (node, index, parent: Parent | undefined) => {
    const directive = parseTextDirective(node);
    if (
      directive === null ||
      index === undefined ||
      index === 0 ||
      parent === undefined ||
      !isUndecoratedTextDirective(directive)
    ) {
      return;
    }
    const previous = parent.children[index - 1];
    if (
      previous?.type !== "text" ||
      !previous.value.endsWith(THREAD_MENTION_PREFIX)
    ) {
      return;
    }
    const next = parent.children[index + 1];
    const merged = next?.type === "text" ? next : undefined;
    previous.value += `:${directive.name}${merged?.value ?? ""}`;
    const end = (merged ?? node).position?.end;
    if (previous.position !== undefined && end !== undefined) {
      previous.position = { ...previous.position, end };
    }
    parent.children.splice(index, merged === undefined ? 1 : 2);
    return index;
  });
}

function markdownMayContainThreadMention(markdown: string): boolean {
  if (CHARACTER_REFERENCE_PATTERN.test(markdown)) {
    return true;
  }
  const unescaped = markdown.includes("\\")
    ? markdown.replaceAll("\\", "")
    : markdown;
  return (
    unescaped.includes(THREAD_MENTION_PREFIX) ||
    unescaped.search(RAW_THREAD_ID_PATTERN) !== -1
  );
}

export function remarkThreadMentions() {
  return (tree: Nodes, file: { value: unknown }): void => {
    if (
      typeof file.value === "string" &&
      !markdownMayContainThreadMention(file.value)
    ) {
      return;
    }
    inlineBareThreadMentionDirectives(tree);
    const authoredMarkdownLinkNodes = collectAuthoredMarkdownLinkNodes(tree);
    const phrasingTextContexts = collectPhrasingTextContexts(tree);
    visit(
      tree,
      "inlineCode",
      (node: InlineCode, index, parent: Parent | undefined) => {
        if (
          parent === undefined ||
          index === undefined ||
          authoredMarkdownLinkNodes.has(node) ||
          !isRawThreadId(node.value) ||
          !isBoundedMentionToken(
            phrasingTextContexts.get(node)?.text ?? node.value,
            phrasingTextContexts.get(node)?.offset ?? 0,
            (phrasingTextContexts.get(node)?.offset ?? 0) + node.value.length,
          )
        ) {
          return;
        }
        parent.children.splice(
          index,
          1,
          threadMentionNode({
            threadId: node.value,
            messageSeq: null,
            rawThreadId: true,
            rawThreadInlineCode: true,
          }),
        );
        return index + 1;
      },
    );
    visit(tree, "text", (node: Text, index, parent: Parent | undefined) => {
      if (
        parent === undefined ||
        index === undefined ||
        authoredMarkdownLinkNodes.has(node)
      ) {
        return;
      }
      const replacements = splitTextNodeOnMentions(
        node,
        phrasingTextContexts.get(node),
      );
      if (replacements.length === 1 && replacements[0] === node) {
        return;
      }
      parent.children.splice(index, 1, ...replacements);
      return index + replacements.length;
    });
  };
}

interface ThreadMentionElementProps {
  "data-message-seq"?: string;
  "data-raw-thread-id"?: string;
  "data-raw-thread-inline-code"?: string;
  "data-thread-id"?: string;
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "bb-thread-mention": ThreadMentionElementProps;
    }
  }
}

export const EMPTY_THREAD_MENTIONS: readonly PromptTextMention[] = [];

export const ThreadMentionsContext = createContext<
  readonly PromptTextMention[]
>(EMPTY_THREAD_MENTIONS);

function RawThreadMentionPillWithQuery({
  inlineCode,
  threadId,
}: {
  inlineCode: boolean;
  threadId: string;
}) {
  const resource = useRawThreadMentionResource(threadId);
  if (resource === null) {
    return inlineCode ? (
      <code className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-xs">
        {threadId}
      </code>
    ) : (
      threadId
    );
  }
  return <PromptMentionPill resource={resource} serializedText={threadId} />;
}

function ResolvedThreadMentionPill({
  messageSeq,
  resource,
  threadId,
}: {
  messageSeq: number | null;
  resource: PromptMentionResource;
  threadId: string;
}) {
  if (messageSeq !== null) {
    return (
      <MessageMentionPill
        messageSeq={messageSeq}
        resource={resource}
        threadId={threadId}
      />
    );
  }
  return (
    <PromptMentionPill
      resource={resource}
      serializedText={`@thread:${threadId}`}
    />
  );
}

function ThreadMentionPillWithQuery({
  messageSeq,
  threadId,
}: {
  messageSeq: number | null;
  threadId: string;
}) {
  const mentions = useContext(ThreadMentionsContext);
  const liveResource = useThreadMentionResource(threadId);
  const resource =
    liveResource ?? resolveThreadMentionResource(mentions, threadId);
  return (
    <ResolvedThreadMentionPill
      messageSeq={messageSeq}
      resource={resource}
      threadId={threadId}
    />
  );
}

export function ThreadMentionElement(props: ThreadMentionElementProps) {
  const mentions = useContext(ThreadMentionsContext);
  const threadId = props["data-thread-id"] ?? "";
  const rawThreadId = props["data-raw-thread-id"];
  const rawMessageSeq = props["data-message-seq"];
  const messageSeq = rawMessageSeq === undefined ? null : Number(rawMessageSeq);
  const sidebarResource = useSidebarThreadMentionResource(threadId);
  if (threadId.length === 0) {
    return null;
  }
  if (rawThreadId !== undefined) {
    return (
      <RawThreadMentionPillWithQuery
        inlineCode={props["data-raw-thread-inline-code"] !== undefined}
        threadId={threadId}
      />
    );
  }
  const persistedResource = mentions.find(
    (mention) =>
      mention.resource.kind === "thread" &&
      mention.resource.threadId === threadId,
  )?.resource;
  const resource = sidebarResource ?? persistedResource;
  if (resource === undefined) {
    return (
      <ThreadMentionPillWithQuery messageSeq={messageSeq} threadId={threadId} />
    );
  }
  return (
    <ResolvedThreadMentionPill
      messageSeq={messageSeq}
      resource={resource}
      threadId={threadId}
    />
  );
}
