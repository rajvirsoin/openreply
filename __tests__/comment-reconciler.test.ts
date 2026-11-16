import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("@/lib/queue/client", () => ({ getDMQueue: () => ({}) }));

import { ownerTaggedUsernames } from "../lib/polling/comment-reconciler";

const OWNER = "owner-1";

describe("ownerTaggedUsernames", () => {
  it("collects @mentions from the owner's top-level comments only", () => {
    const tagged = ownerTaggedUsernames(
      [
        { id: "1", text: "Offer", from: { id: "u1", username: "jo_carroll3871" }, timestamp: "" },
        { id: "2", text: "@Jo_Carroll3871 Check your DMs!", from: { id: OWNER }, timestamp: "" },
        { id: "3", text: "@sakina.hh Just sent you a message.", from: { id: OWNER }, timestamp: "" },
        { id: "4", text: "@someone_else hi", from: { id: "u2" }, timestamp: "" },
      ],
      OWNER
    );
    expect([...tagged].sort()).toEqual(["jo_carroll3871", "sakina.hh"]);
  });

  it("returns an empty set when the owner has not commented", () => {
    expect(
      ownerTaggedUsernames([{ id: "1", text: "Offer", from: { id: "u1" }, timestamp: "" }], OWNER).size
    ).toBe(0);
  });
});
