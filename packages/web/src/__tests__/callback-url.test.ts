import { describe, it, expect } from "vitest";
import { safeCallbackUrl } from "../lib/callback-url";

describe("safeCallbackUrl", () => {
  it("keeps a same-origin absolute path", () => {
    expect(safeCallbackUrl("/dashboard")).toBe("/dashboard");
    expect(safeCallbackUrl("/settings/general?tab=2#top")).toBe("/settings/general?tab=2#top");
    expect(safeCallbackUrl("/")).toBe("/");
  });

  it("falls back to the dashboard for anything that is not a path", () => {
    expect(safeCallbackUrl(null)).toBe("/dashboard");
    expect(safeCallbackUrl(undefined)).toBe("/dashboard");
    expect(safeCallbackUrl("")).toBe("/dashboard");
    expect(safeCallbackUrl("https://evil.com/")).toBe("/dashboard");
    expect(safeCallbackUrl("dashboard")).toBe("/dashboard");
  });

  it("rejects protocol-relative and backslash-steered targets", () => {
    // Browsers treat `\` as `/` in special-scheme URLs: `/\evil.com` is
    // `//evil.com` after normalization and resolves to https://evil.com/.
    expect(safeCallbackUrl("//evil.com")).toBe("/dashboard");
    expect(safeCallbackUrl("/\\evil.com")).toBe("/dashboard");
    expect(safeCallbackUrl("/\\/evil.com")).toBe("/dashboard");
    expect(safeCallbackUrl("\\\\evil.com")).toBe("/dashboard");
  });

  it("rejects values containing whitespace or control characters", () => {
    // A tab or newline is stripped by the URL parser, so "/\t/evil.com"
    // normalizes to "//evil.com" and becomes an open redirect.
    expect(safeCallbackUrl("/\t/evil.com")).toBe("/dashboard");
    expect(safeCallbackUrl("/ /evil.com")).toBe("/dashboard");
    expect(safeCallbackUrl("/\n/dashboard")).toBe("/dashboard");
  });
});