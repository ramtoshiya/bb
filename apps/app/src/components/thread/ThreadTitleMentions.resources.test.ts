import { describe, expect, it } from "vitest";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import {
  buildThreadTitleMentionResources,
  EMPTY_TITLE_MENTION_RESOURCES,
  resolveSerializedPromptMentions,
  resolveThreadTitleDisplayText,
  type ThreadTitleMentionNavigationSource,
} from "./ThreadTitleMentions";

function navigation(
  overrides: Partial<{
    sectionName: string;
    projectName: string;
    threadTitle: string | null;
    updatedAt: number;
  }> = {},
): ThreadTitleMentionNavigationSource {
  return {
    sections: [{ id: "sec_1", name: overrides.sectionName ?? "Backlog" }],
    projects: [
      {
        id: "proj_app",
        name: overrides.projectName ?? "App",
        threads: [
          makeThreadListEntry({
            id: "thr_app",
            projectId: "proj_app",
            title: overrides.threadTitle ?? "Ship it",
            updatedAt: overrides.updatedAt ?? 1,
          }),
        ],
      },
    ],
    personalProject: {
      id: "personal",
      name: "Personal",
      threads: [makeThreadListEntry({ id: "thr_me", projectId: "personal" })],
    },
  };
}

describe("buildThreadTitleMentionResources", () => {
  it("returns the previous resources for a value-equal payload with new identity", () => {
    const first = buildThreadTitleMentionResources(
      navigation(),
      EMPTY_TITLE_MENTION_RESOURCES,
    );
    expect(first.threadById.get("thr_app")?.title).toBe("Ship it");

    const second = buildThreadTitleMentionResources(
      navigation({ updatedAt: 2 }),
      first,
    );
    expect(second).toBe(first);
  });

  it("replaces only the map that changed and keeps unchanged thread entries", () => {
    const first = buildThreadTitleMentionResources(
      navigation(),
      EMPTY_TITLE_MENTION_RESOURCES,
    );
    const renamedProject = buildThreadTitleMentionResources(
      navigation({ projectName: "Application" }),
      first,
    );
    expect(renamedProject).not.toBe(first);
    expect(renamedProject.projectNamesById.get("proj_app")).toBe("Application");
    expect(renamedProject.sectionNamesById).toBe(first.sectionNamesById);
    expect(renamedProject.threadById).toBe(first.threadById);

    const retitled = buildThreadTitleMentionResources(
      navigation({ projectName: "Application", threadTitle: "Shipped" }),
      renamedProject,
    );
    expect(retitled.threadById).not.toBe(renamedProject.threadById);
    expect(retitled.threadById.get("thr_app")?.title).toBe("Shipped");
    expect(retitled.threadById.get("thr_me")).toBe(
      renamedProject.threadById.get("thr_me"),
    );
    expect(retitled.projectNamesById).toBe(renamedProject.projectNamesById);
  });

  it("drops to the shared empty resources when the payload disappears", () => {
    const first = buildThreadTitleMentionResources(
      navigation(),
      EMPTY_TITLE_MENTION_RESOURCES,
    );
    expect(buildThreadTitleMentionResources(undefined, first)).toBe(
      EMPTY_TITLE_MENTION_RESOURCES,
    );
    expect(
      buildThreadTitleMentionResources(
        undefined,
        EMPTY_TITLE_MENTION_RESOURCES,
      ),
    ).toBe(EMPTY_TITLE_MENTION_RESOURCES);
  });
});

describe("resolveThreadTitleDisplayText", () => {
  const rawId = "thr_dcwivn5n8w";

  function resourcesWithThread(title: string) {
    return {
      ...EMPTY_TITLE_MENTION_RESOURCES,
      threadById: new Map([
        [
          rawId,
          makeThreadListEntry({
            id: rawId,
            projectId: "proj_target",
            title,
            titleFallback: title,
          }),
        ],
      ]),
    };
  }

  it.each([
    [
      "mid-title",
      `Continue from ${rawId} docs/foo.ts`,
      "Continue from Raw title target docs/foo.ts",
    ],
    [
      "before a straight closing quote",
      `Review "${rawId}."`,
      'Review "Raw title target."',
    ],
    [
      "before a curly closing quote",
      `Review \u201c${rawId}.\u201d`,
      "Review \u201cRaw title target.\u201d",
    ],
    [
      "before a Korean particle",
      `${rawId}\ub294 \ud655\uc778`,
      "Raw title target\ub294 \ud655\uc778",
    ],
  ])(
    "shows a known raw thread id %s as its title",
    (_label, title, expected) => {
      expect(
        resolveThreadTitleDisplayText(
          title,
          resourcesWithThread("Raw title target"),
        ),
      ).toBe(expected);
    },
  );
});

describe("resolveThreadTitleDisplayText before Korean text", () => {
  const resources = {
    ...EMPTY_TITLE_MENTION_RESOURCES,
    projectNamesById: new Map([["proj_app", "App"]]),
    sectionNamesById: new Map([["sec_1", "Backlog"]]),
    threadById: new Map([
      [
        "thr_app",
        makeThreadListEntry({
          id: "thr_app",
          projectId: "proj_app",
          title: "Ship it",
        }),
      ],
    ]),
  };

  it.each([
    ["a thread mention", "@thread:thr_app는 확인", "Ship it는 확인"],
    ["a project mention", "@project:proj_app에서 확인", "App에서 확인"],
    ["a section mention", "@section:sec_1에서 확인", "Backlog에서 확인"],
    ["a folder mention", "@folder:sec_1로 이동", "Backlog로 이동"],
    ["a message anchor", "@thread:thr_app#msg=42는", "Ship it#msg=42는"],
  ])(
    "shows %s followed by a Korean particle by name",
    (_label, title, expected) => {
      expect(resolveThreadTitleDisplayText(title, resources)).toBe(expected);
    },
  );

  it("keeps the particle outside a prompt mention's range", () => {
    expect(
      resolveSerializedPromptMentions(
        "😀 @thread:thr_app는 @project:proj_app에서",
        resources,
      ).map(({ start, end }) => [start, end]),
    ).toEqual([
      [3, 18],
      [20, 37],
    ]);
  });

  it("keeps a directory mention followed by a Korean name literal", () => {
    expect(resolveThreadTitleDisplayText("@docs/설계 확인", resources)).toBe(
      "@docs/설계 확인",
    );
  });
});
