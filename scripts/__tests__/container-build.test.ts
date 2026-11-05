import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (file: string) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const dockerfile = source("Dockerfile");

describe("production container", () => {
  it("builds without application credentials or test switches", () => {
    // Build args must be this allowlist: the base-image pin, the two
    // provenance values that only feed OCI labels, and the cookie-security
    // decision. next.config's headers() runs at build and is baked into
    // routes-manifest.json, so an intranet http deployment has to choose
    // "no HSTS" before the image exists. Anything else risks a build-time
    // credential sitting in the image history.
    expect([...dockerfile.matchAll(/^ARG (\w+)/gm)].map((match) => match[1]))
      .toEqual(["NODE_VERSION", "USE_SECURE_COOKIES", "PEW_REVISION", "PEW_VERSION"]);
    // The provenance args must reach only LABEL lines — never ENV, so they
    // cannot be read back from a running container.
    expect(dockerfile).not.toMatch(/^ENV\s+PEW_/m);
    expect(dockerfile).not.toMatch(/CF_|AUTH_|WORKER_|E2E_|TOKEN|SECRET|--mount=type=secret/);
    expect(dockerfile).toContain("RUN bun install --frozen-lockfile");
    // The Bun pin must be a concrete patch version; the root-equals-selfhost
    // check below pins the two images to each other.
    expect(dockerfile.match(/^COPY --from=oven\/bun:(\S+)/m)?.[1]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dockerfile).toContain("node ./node_modules/.bin/next build");
  });

  it("pins the Node.js base image to a patch release, not a floating major", () => {
    // A floating major (node:22-slim) resolves to whatever the local cache
    // holds. A build beside a pre-security-release cache shipped Node 22.23.3,
    // which carries CVE-2026-111497 (Brotli decoder OOB write).
    expect(dockerfile.match(/^ARG NODE_VERSION=(.+)$/m)?.[1]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("pins the Bun runtime in the selfhost image to the same patch as the root one", () => {
    // The selfhost Dockerfile is the only image the adapter services run, and
    // it pins Bun independently. Letting the two drift means the images build
    // under different runtimes than CI tests.
    const rootBun = dockerfile.match(/^COPY --from=(oven\/bun:\S+)/m)?.[1];
    const selfhost = source("deploy/selfhost/Dockerfile").match(/^FROM (oven\/bun:\S+)/m)?.[1];
    expect(selfhost).toBe(rootBun);
  });

  it("documents the same Bun patch the images build with", () => {
    // "Use the Bun version CI and the Dockerfile use" is only true while the
    // prose tracks the pin; a forgotten bump sends contributors to a version
    // no gate tests.
    const pin = dockerfile.match(/^COPY --from=oven\/bun:(\S+)/m)?.[1];
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    for (const file of ["README.md", "docs/README.en.md"]) {
      const mentioned = source(file).match(/Bun (\d+\.\d+\.\d+)/);
      expect(mentioned?.[1], `${file} must document Bun ${pin}`).toBe(pin);
    }
  });

  it("runs CI on the same Bun patch the images build with", () => {
    // The image pin and the CI runtime pin are independent literals. Bumping
    // one leaves the tests running a different Bun than the shipped image.
    const pin = dockerfile.match(/^COPY --from=oven\/bun:(\S+)/m)?.[1];
    const ci = source(".github/workflows/ci.yml");
    const versions = [...ci.matchAll(/runtime-version:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) expect(version).toBe(pin);
    const admission = source(".github/workflows/admission-primitive.yml").match(
      /bun-version:\s*"([^"]+)"/,
    )?.[1];
    expect(admission).toBe(pin);
  });

  it("preserves standalone assets and SWC helpers with writable non-root caches", () => {
    expect(dockerfile).toContain("scripts/fix-standalone-swc-helpers.ts --required");
    for (const [from, to] of [
      [".next/standalone", "./"],
      [".next/static", "./packages/web/.next/static"],
      ["public", "./packages/web/public"],
    ]) {
      expect(dockerfile).toContain(
        `COPY --from=builder --chown=node:node /app/packages/web/${from} ${to}`,
      );
    }
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toMatch(/USER node\s+RUN node -e .*sharp.*\.png\(\)\.toBuffer\(\)/);
    expect(dockerfile).toContain('CMD ["node", "packages/web/server.js"]');
    expect(dockerfile).toContain("ENV NODE_ENV=production");
    expect(dockerfile).toContain("ENV PORT=7020");
  });

  it("excludes credentials and generated state at every workspace depth", () => {
    const rules = source(".dockerignore").trim().split("\n");
    expect(rules[0]).toBe("**");
    expect(rules).toEqual(expect.arrayContaining([
      "!package.json", "!bun.lock", "!tsconfig.json", "!packages/", "!packages/**",
      "!scripts/", "!scripts/fix-standalone-swc-helpers.ts",
      "**/.env*", "**/.dev.vars*", "**/*.pem", "**/*.key",
      "**/node_modules", "**/.next*", "**/dist", "**/.wrangler",
    ]));
    expect(rules.slice(rules.indexOf("**/.env*") + 1).some((rule) => rule.startsWith("!")))
      .toBe(false);
  });
});
