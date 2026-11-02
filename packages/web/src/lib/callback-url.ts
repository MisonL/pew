/**
 * Sanitize the `callbackUrl` query parameter the login page hands to
 * `signIn()` and `window.location`.
 *
 * Only a same-origin absolute path is accepted. The naive check
 * `startsWith("/") && !startsWith("//")` is not enough: browsers treat `\` as
 * `/` in special-scheme URLs, so `/\evil.com` resolves to `https://evil.com/`
 * and the "path" becomes an open redirect. Control characters and whitespace
 * are rejected for the same reason — the URL parser strips or normalizes some
 * of them, which can turn a harmless-looking path into `//host`.
 */
export function safeCallbackUrl(raw: string | null | undefined): string {
  return raw && /^\/(?!\/)[^\s\\]*$/.test(raw) ? raw : "/dashboard";
}
