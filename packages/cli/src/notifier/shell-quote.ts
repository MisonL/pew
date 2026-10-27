/**
 * Shell-safe rendering of a single argument for a hook command line.
 *
 * Hook commands are stored as strings that the host tool runs through a shell
 * (`sh -c`), so an argument containing `$`, a backtick or `${...}` would be
 * expanded — a home directory such as `/home/$(id)/...` would execute that
 * substitution on every session. Double quotes do NOT prevent command
 * substitution, so the previous `"..."` escaping was not a boundary.
 *
 * POSIX single quotes suppress every expansion; the only character needing
 * handling is `'` itself, closed and re-opened around an escaped quote. A
 * value in the conservative unquoted set is emitted verbatim, which keeps
 * existing installs byte-identical (their command string is what `status` and
 * `uninstall` match on).
 */

/** Characters safe to pass through unquoted in a POSIX shell word. */
const SAFE_UNQUOTED = /^[A-Za-z0-9_\-./:@]+$/;

/**
 * Characters that stay inert inside double quotes. Paths with none of these
 * keep the exact `"..."` spelling earlier versions wrote, so `status` and
 * `uninstall` still recognise an existing hook byte-for-byte (a macOS home
 * like `/Users/John Doe/...` must not silently become a second hook).
 */
const SAFE_IN_DOUBLE_QUOTES = /^[^"$`\\]+$/;

export function shellArg(value: string): string {
  if (SAFE_UNQUOTED.test(value)) return value;
  if (SAFE_IN_DOUBLE_QUOTES.test(value)) return `"${value}"`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
