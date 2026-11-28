"use client";

import { useEffect, useState } from "react";
import { Banner } from "@nocoo/basalt/components/banner";
import { Button } from "@/components/ui/button";
import { describeSkippedHint, describeSyncOutcome } from "@/lib/sync-outcome";
import type { SyncOutcomeDto } from "@/lib/rpc-types";

interface Props {
  onComplete?: (outcome: SyncOutcomeDto) => void;
}

type State =
  | { kind: "idle" }
  | { kind: "syncing" }
  | { kind: "ok"; outcome: SyncOutcomeDto }
  | { kind: "partial"; outcome: SyncOutcomeDto }
  | { kind: "skipped"; outcome: SyncOutcomeDto; hint: string }
  | { kind: "error"; message: string };

const AUTO_DISMISS_MS = 4000;

export function ForceSyncButton({ onComplete }: Props) {
  const [state, setState] = useState<State>({ kind: "idle" });

  useEffect(() => {
    if (state.kind === "idle" || state.kind === "syncing") return;
    const t = setTimeout(() => setState({ kind: "idle" }), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [state]);

  const handleClick = async () => {
    setState({ kind: "syncing" });
    try {
      const res = await fetch("/api/admin/pricing/rebuild", { method: "POST" });
      const body = (await res.json().catch(() => null)) as (SyncOutcomeDto & { error?: string }) | null;

      // Status alone cannot tell "prices changed" from "this run published
      // nothing because a newer result already won" — both answer 200 when
      // nothing failed. A discarded run told the operator "Prices updated".
      const view = describeSyncOutcome(res.status, body);
      const outcome = body as SyncOutcomeDto;
      if (view.kind === "ok") {
        setState({ kind: "ok", outcome });
        onComplete?.(outcome);
        return;
      }
      if (view.kind === "partial") {
        setState({ kind: "partial", outcome });
        onComplete?.(outcome);
        return;
      }
      if (view.kind === "skipped") {
        setState({ kind: "skipped", outcome, hint: describeSkippedHint(view.reason) });
        onComplete?.(outcome);
        return;
      }
      setState({ kind: "error", message: "Could not refresh prices. Please try again." });
    } catch {
      setState({
        kind: "error",
        message: "Could not refresh prices. Please try again.",
      });
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <Button onClick={handleClick} disabled={state.kind === "syncing"} variant="secondary" size="sm">
        {state.kind === "syncing" ? "Refreshing…" : "Refresh prices"}
      </Button>
      {state.kind === "ok" && (
        <Banner
          variant="secondary"
          size="sm"
          description="Prices updated"
        />
      )}
      {state.kind === "partial" && (
        <Banner
          variant="alert"
          size="sm"
          description="Some prices could not be refreshed"
        />
      )}
      {state.kind === "skipped" && (
        // Not "Prices updated": this run wrote nothing. Why varies — a newer
        // result already published, or a KV read failure — and a single
        // sentence for both misreported the KV case.
        <Banner
          variant="secondary"
          size="sm"
          description={state.hint}
        />
      )}
      {state.kind === "error" && (
        <Banner variant="error" size="sm" description={state.message} />
      )}
    </span>
  );
}
