import { describe, expect, it } from "vitest";
import { A_TEAM_MEMBER, canSeePerson, hideAiIssueKey } from "../src";

// Who sees which person's name, and the opaque key an old AI-acknowledged issue keeps (B1 2b, issue #30): pure, no database.
// The labels AI text was saved with (nameLabels, nameFinding, nameAnalysisRow, ...) went with in-app AI.

const MAYA = "00000000-0000-4000-8000-00000000000a";
const ANN = "00000000-0000-4000-8000-00000000000b";

describe("canSeePerson", () => {
  it("shows everyone to a reader who sees everyone, and only their own person to anyone else", () => {
    expect(canSeePerson({ seesEveryone: true, ownPersonId: null }, ANN)).toBe(true);
    const member = { seesEveryone: false, ownPersonId: MAYA };
    expect(canSeePerson(member, MAYA)).toBe(true);
    expect(canSeePerson(member, ANN)).toBe(false);
    expect(canSeePerson(member, null)).toBe(false);
    expect(canSeePerson({ seesEveryone: false, ownPersonId: null }, "")).toBe(false);
    expect(A_TEAM_MEMBER).toBe("A team member");
  });
});

describe("hideAiIssueKey", () => {
  const issue = { id: "00000000-0000-4000-8000-0000000000b1", detected_key: "ai:insight:9f3a2c", title: "t" };

  it("gives a reader who doesn't see everyone ai:insight:<issue id>, not the hash of the AI text", () => {
    expect(hideAiIssueKey(issue, false)).toEqual({ ...issue, detected_key: `ai:insight:${issue.id}` });
    expect(hideAiIssueKey(issue, false).detected_key).toMatch(/^ai:insight:[^\s]{1,150}$/);
  });

  it("leaves a reader who sees everyone, and every key that carries ids, alone", () => {
    expect(hideAiIssueKey(issue, true)).toBe(issue);
    for (const key of [`overtime:person:${MAYA}`, `finding:ai:${ANN}`, "perception_gap:step:s1.work", "forecast:x", null]) {
      const row = { ...issue, detected_key: key };
      expect(hideAiIssueKey(row, false)).toBe(row);
    }
  });
});
