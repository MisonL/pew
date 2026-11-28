import { describe, expect, it } from "vitest";
import { ledgerRecoveryMessage } from "./ledger-error";

describe("ledgerRecoveryMessage", () => {
  it("names the file and gives a recovery path, since reset keeps it", () => {
    // `pew reset` deliberately keeps both durable ledgers, so "Invalid … ledger"
    // alone left every later sync failing with no hint of what to touch.
    const message = ledgerRecoveryMessage("usage evidence");
    expect(message).toContain("Invalid usage evidence ledger");
    expect(message).toContain("pew reset");
    expect(message).toContain("move it aside");
  });

  it("distinguishes the accounting ledger", () => {
    expect(ledgerRecoveryMessage("accounting")).toMatch(/^Invalid accounting ledger/);
  });
});
