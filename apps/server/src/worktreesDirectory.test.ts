import { assert, describe, it } from "@effect/vitest";

import { worktreeFolderName } from "./worktreesDirectory.ts";

const HASH = "0123456789abcdef0123456789abcdef";

describe("worktreeFolderName", () => {
  it("reads as its branch when the branch is short", () => {
    assert.equal(worktreeFolderName("t3/fix-login-redirect", HASH), "t3-fix-login-redirect");
    assert.equal(worktreeFolderName("z".repeat(40), HASH), "z".repeat(40));
  });

  it("keeps the start of a long branch and adds a short code", () => {
    const name = worktreeFolderName(`t3/${"research-gst-refund-types-".repeat(3)}`, HASH);
    assert.equal(name, "t3-research-gst-refund-types-re-01234567");
    assert.isAtMost(Buffer.byteLength(name), 40);
    // No dash or dot is left before the code.
    assert.equal(
      worktreeFolderName(`${"a".repeat(30)}-${"b".repeat(20)}`, HASH),
      `${"a".repeat(30)}-01234567`,
    );
  });

  it("never splits a character", () => {
    const name = worktreeFolderName("😀".repeat(20), HASH);
    assert.isAtMost(Buffer.byteLength(name), 40);
    assert.equal(name, `${"😀".repeat(7)}-01234567`);
  });
});
