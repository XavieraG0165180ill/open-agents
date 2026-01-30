"use client";

import { useSession } from "@/hooks/use-session";
import { SignInButton } from "./sign-in-button";

export function AuthGuard({
  children,
  loadingFallback,
}: {
  children: React.ReactNode;
  loadingFallback?: React.ReactNode;
}) {
  const { loading, isAuthenticated } = useSession();

  if (loading) {
    return <>{loadingFallback ?? <div>Loading...</div>}</>;
  }

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center gap-4 p-8">
        <p>Please sign in to continue</p>
        <SignInButton />
      </div>
    );
  }

  return <>{children}</>;
}
