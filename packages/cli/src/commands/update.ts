/**
 * Update pew to the latest version.
 *
 * Uses base-cli utilities for version checking and update execution.
 */

import { detectPackageManager, getUpdateCommand } from "@nocoo/base-cli";
import { exec as execCallback } from "node:child_process";

const PACKAGE_NAME = "@nocoo/pew";

export interface UpdateOptions {
  /** Current CLI version (from CLI_VERSION) */
  currentVersion: string;
  /** Override for testing — replaces the actual exec */
  execFn?: (cmd: string) => Promise<{ stdout: string; stderr: string }>;
  /**
   * Resolve the latest published version; undefined = the registry could not
   * be read. Defaults to `npm view @nocoo/pew version`.
   */
  latestVersionFn?: () => Promise<string | undefined>;
  /** Bypass the version gate (allow downgrade / reinstall of an equal version). */
  force?: boolean;
}

export interface UpdateResult {
  success: boolean;
  output: string;
  error?: string;
  /** The version gate found nothing newer to install; no command was run. */
  skipped?: boolean;
  /** The published version the gate compared against. */
  latestVersion?: string;
  /**
   * The install ran with the version gate bypassed (`--force`). The CLI warns
   * about it: a forced install can replace a local/self-hosted build with a
   * published package that does not know `--host`.
   */
  forced?: boolean;
}

function defaultExec(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execCallback(cmd, { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

/**
 * Latest version published on the registry, or undefined when it cannot be
 * determined. `npm view` is used even when the install itself runs through
 * bun/pnpm/yarn: the package is published to the npm registry and every
 * supported manager can read it.
 */
function defaultLatestVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execCallback(`npm view ${PACKAGE_NAME} version`, { timeout: 30_000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      const version = stdout.trim().split(/\s+/).pop() ?? "";
      resolve(/^\d+\.\d+\.\d+/.test(version) ? version : undefined);
    });
  });
}

/**
 * Numeric dotted compare; a prerelease suffix ("-beta.1") ranks below the
 * release it precedes. Prerelease-to-prerelease ordering is not needed by
 * this gate — both sides are simply "not newer".
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const [core, pre] = v.split("-", 2);
    const nums = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre: pre ?? "" };
  };
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i];
  }
  return a.pre === "" && b.pre !== "";
}

/**
 * Update pew to the latest version.
 * Detects package manager and runs appropriate install command.
 *
 * The version gate exists because this build can be NEWER than the published
 * package (a branch/fork build). Installing "@latest" over it is a silent
 * downgrade that can also re-install a global binary which shadows this one —
 * on 2026-10-20 exactly that shipped a self-hosted user's queue to the SaaS:
 * the older binary ignored --host, uploaded to the default host, and the
 * operator saw no error. So: refuse unless the published version is strictly
 * newer; `--force` overrides for deliberate reinstall/downgrade.
 */
export async function executeUpdate(opts: UpdateOptions): Promise<UpdateResult> {
  const exec = opts.execFn ?? defaultExec;

  if (!opts.force) {
    const latest = await (opts.latestVersionFn ?? defaultLatestVersion)();
    if (latest === undefined) {
      return {
        success: false,
        output: "",
        error: `could not determine the latest published version of ${PACKAGE_NAME}; refusing to update (check registry access, or rerun with --force)`,
      };
    }
    if (!isNewerVersion(latest, opts.currentVersion)) {
      return {
        success: true,
        skipped: true,
        latestVersion: latest,
        output: `published ${latest} is not newer than the running ${opts.currentVersion}`,
      };
    }
  }

  const pm = detectPackageManager(PACKAGE_NAME);

  // Fallback to npm if package manager detection fails
  const command = pm ? getUpdateCommand(pm, PACKAGE_NAME) : `npm install -g ${PACKAGE_NAME}@latest`;

  try {
    const { stdout, stderr } = await exec(command);
    const output = (stdout + stderr).trim();
    return { success: true, output, forced: opts.force === true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: "", error: message };
  }
}
