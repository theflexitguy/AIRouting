"use client";

import { useAuth } from "@/contexts/AuthContext";

type Role = "admin" | "dispatcher" | "viewer";

export function useRequireRole(allowedRoles: Role[]) {
  const { userProfile } = useAuth();
  const role = (userProfile?.role as Role) || "viewer";
  return {
    role,
    allowed: allowedRoles.includes(role),
    isAdmin: role === "admin",
    isDispatcher: role === "dispatcher",
    isViewer: role === "viewer",
  };
}

export function RoleGate({
  roles,
  children,
  fallback,
}: {
  roles: Role[];
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const { allowed } = useRequireRole(roles);
  if (!allowed) return fallback ?? null;
  return <>{children}</>;
}
