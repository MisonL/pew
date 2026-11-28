import { ErrorBanner } from "@/components/ui/error-banner";

/**
 * Body for an admin page whose admin check could not answer.
 *
 * The page guards redirect home when the check says "not an admin"; when it
 * could not answer at all, redirecting is indistinguishable from losing
 * access. Show a retryable message instead.
 */
export function AdminAvailabilityNotice() {
  return (
    <div className="space-y-4 md:space-y-6">
      <ErrorBanner
        messagePrefix="Could not verify your admin access"
        error="The admin check is temporarily unavailable. Reload the page to retry."
      />
    </div>
  );
}
