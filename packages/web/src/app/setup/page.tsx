"use client";

import { Banner } from "@nocoo/basalt/components/banner";
import { Button } from "@nocoo/basalt/components/button";
import { Input } from "@nocoo/basalt/components/input";
import { LoadingScreen } from "@nocoo/basalt/components/loading-screen";
import { signIn } from "next-auth/react";
import Image from "next/image";
import { Suspense, useState } from "react";
import { BadgeAmbientGlow, BadgeCard } from "@/components/brand/badge-card";
import { SiteFooter } from "@/components/layout/site-footer";

/**
 * First-run setup wizard: creates the initial administrator.
 *
 * The server decides whether this is allowed (users table empty). A successful
 * POST /api/auth/register in bootstrap mode makes this user an admin, then we
 * sign them in and send them to the dashboard.
 */
function SetupContent() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Setup failed");
        setLoading(false);
        return;
      }
      // Admin created — sign in with the just-set credentials.
      const result = await signIn("credentials", { email, password, redirect: false });
      if (result?.error) {
        setError("Account created. Please sign in.");
        setLoading(false);
        return;
      }
      window.location.href = "/dashboard";
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-basalt-background">
      <div className="flex flex-1 items-center justify-center p-4">
        <BadgeAmbientGlow />
        <div className="flex flex-col items-center">
          <BadgeCard
            badge="SETUP"
            className="w-80"
            contentClassName="items-center px-6 pt-6 pb-5"
          >
            <Image src="/logo-80.png" alt="pew" width={80} height={80} />
            <p className="mt-5 text-lg font-semibold text-basalt-foreground">Set up pew</p>
            <p className="mt-1 text-center text-xs text-basalt-muted-foreground">
              Create the first account. It becomes the administrator.
            </p>

            <div className="mt-5 h-px w-full bg-basalt-border" />

            <form
              className="mt-5 w-full space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!loading) submit();
              }}
            >
              <Input
                type="email"
                autoComplete="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="rounded-xl py-3"
              />
              <Input
                type="text"
                autoComplete="name"
                placeholder="Display name (optional)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="rounded-xl py-3"
              />
              <Input
                type="password"
                autoComplete="new-password"
                placeholder="Password (min 8 characters)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="rounded-xl py-3"
              />
              <Input
                type="password"
                autoComplete="new-password"
                placeholder="Confirm password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="rounded-xl py-3"
              />
              {error && <Banner variant="error" size="sm" description={error} />}
              <Button
                type="submit"
                variant="secondary"
                className="w-full rounded-xl py-3"
                disabled={!email || !password || !confirm || loading}
                loading={loading}
              >
                {loading ? "Creating..." : "Create administrator"}
              </Button>
            </form>
          </BadgeCard>
        </div>
      </div>
      <SiteFooter />
    </div>
  );
}

export default function SetupPage() {
  return (
    <Suspense
      fallback={
        <LoadingScreen
          label="Loading"
          mark={<Image src="/logo-80.png" alt="" width={32} height={32} />}
        />
      }
    >
      <SetupContent />
    </Suspense>
  );
}
