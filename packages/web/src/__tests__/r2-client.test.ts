import { describe, it, expect, vi } from "vitest";

// The handler's own config is only materialized on first use (it is a lazily
// resolved provider), so the wiring is asserted at construction instead.
vi.mock("@smithy/node-http-handler", () => ({
  NodeHttpHandler: vi.fn().mockImplementation(function (this: Record<string, unknown>, options: unknown) {
    this.options = options;
  }),
}));

const { buildR2RequestHandler, R2_CONNECTION_TIMEOUT_MS, R2_REQUEST_TIMEOUT_MS } = await import("@/lib/r2");
const { NodeHttpHandler } = await import("@smithy/node-http-handler");

describe("R2 request handler", () => {
  it("bounds connection and request time so a wedged R2 cannot park the route", () => {
    // The default Smithy handler waits for a request indefinitely. The logo
    // upload runs synchronously inside the route, so that wait is the caller
    // request; the client must be given a handler that gives up on its own.
    buildR2RequestHandler();

    expect(vi.mocked(NodeHttpHandler)).toHaveBeenCalledWith({
      connectionTimeout: R2_CONNECTION_TIMEOUT_MS,
      requestTimeout: R2_REQUEST_TIMEOUT_MS,
    });
    expect(R2_CONNECTION_TIMEOUT_MS).toBe(5_000);
    expect(R2_REQUEST_TIMEOUT_MS).toBe(30_000);
  });
});
