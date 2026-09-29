"use client";

// fetch() for the app's own /api routes: attaches the signed-in user's Firebase ID token, which the server requires
// (see api-auth.ts). Use this instead of fetch() for anything under /api/.

import { auth } from "@/lib/firebase";

async function idToken(forceRefresh = false): Promise<string | null> {
  if (!auth) return null;
  try {
    // On a fresh page load Firebase restores the session asynchronously; wait for it rather than sending no token.
    await auth.authStateReady();
    return (await auth.currentUser?.getIdToken(forceRefresh)) ?? null;
  } catch {
    return null;
  }
}

function withToken(init: RequestInit | undefined, token: string | null): RequestInit {
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, withToken(init, await idToken()));
  if (res.status !== 401) return res;
  // An expired token gets one retry with a freshly minted one. (A ReadableStream body can't be replayed; ours are strings.)
  const fresh = await idToken(true);
  return fresh ? fetch(input, withToken(init, fresh)) : res;
}
