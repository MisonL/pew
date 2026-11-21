import { describe, it, expect, vi, beforeEach } from "vitest";

// The handler under test delegates to Auth.js; the mock records what reached
// it, so the cap is asserted at the boundary that matters.
vi.mock("@/auth", () => ({
  handlers: {
    GET: vi.fn(async () => new Response("session")),
    POST: vi.fn(async (request: Request) => new Response(String((await request.text()).length))),
  },
}));

const { GET, POST } = await import("@/app/api/auth/[...nextauth]/route");
const { handlers } = (await import("@/auth")) as unknown as {
  handlers: { GET: ReturnType<typeof vi.fn>; POST: ReturnType<typeof vi.fn> };
};

function url(): string {
  return "http://localhost:7020/api/auth/callback/credentials";
}

describe("POST /api/auth/[...nextauth]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 413 without touching Auth.js when Content-Length exceeds the cap", async () => {
    const body = "x".repeat(1024);
    const request = new Request(url(), {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "999999999" },
      body,
    });

    const res = await POST(request as never);

    expect(res.status).toBe(413);
    expect(handlers.POST).not.toHaveBeenCalled();
  });

  it("returns 413 for a chunked body that grows past the cap", async () => {
    // No Content-Length: the header shortcut cannot see this body, so the
    // stream itself has to be bounded.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 20; i++) controller.enqueue(encoder.encode("y".repeat(1024)));
        controller.close();
      },
    });
    const request = new Request(url(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);

    const res = await POST(request as never);

    expect(res.status).toBe(413);
    expect(handlers.POST).not.toHaveBeenCalled();
  });

  it("passes a bounded body through to Auth.js intact", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("csrfToken=abc"));
        controller.close();
      },
    });
    const request = new Request(url(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: stream,
      duplex: "half",
    } as RequestInit);

    const res = await POST(request as never);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(String("csrfToken=abc".length));
    expect(handlers.POST).toHaveBeenCalledOnce();
  });

  it("leaves GET untouched", async () => {
    const res = await GET(new Request(url()) as never);

    expect(await res.text()).toBe("session");
    expect(handlers.GET).toHaveBeenCalledOnce();
  });
});
