import { describe, it, expect, beforeEach } from "vitest";
import { humanActions } from "../../src/escape_hatch/human_actions.js";

beforeEach(() => {
  humanActions._resetForTests();
});

describe("humanActions", () => {
  it("starts empty so the tool can branch on presence", () => {
    expect(humanActions.query().length).toBe(0);
  });

  it("records + returns in-seq order, latest-first when capped", () => {
    humanActions.record({ kind: "mouse", detail: { x: 1, y: 1 } });
    humanActions.record({ kind: "keyboard", detail: { key: "Enter" } });
    const actions = humanActions.query();
    expect(actions).toHaveLength(2);
    expect(actions[0]!.seq).toBe(1);
    expect(actions[1]!.seq).toBe(2);
  });

  it("sinceSeq filters out older entries", () => {
    humanActions.record({ kind: "mouse" });
    humanActions.record({ kind: "mouse" });
    humanActions.record({ kind: "keyboard" });
    const since1 = humanActions.query(1);
    expect(since1.map((a) => a.seq)).toEqual([2, 3]);
  });

  it("caps at ring capacity without dropping newest", () => {
    for (let i = 0; i < 260; i++) humanActions.record({ kind: "mouse" });
    const all = humanActions.query(undefined, 256);
    expect(all.length).toBe(256);
    expect(all[all.length - 1]!.seq).toBe(260);
  });
});
