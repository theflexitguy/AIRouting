'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import {
  User as FirebaseUser,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  createUserWithEmailAndPassword,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { User } from '@/types';
import { apiFetch } from '@/lib/api-client';

interface AuthContextType {
  user: FirebaseUser | null;
  userProfile: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Creates the login and a brand-new company (chosen by the server); resolves to the new company id. */
  createAccount: (email: string, password: string, companyName: string) => Promise<string>;
}

const AuthContext = createContext<AuthContextType>({} as AuthContextType);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [userProfile, setUserProfile] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Demo mode: Firebase not configured — skip auth entirely
    if (!auth) {
      setLoading(false);
      return;
    }
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser && db) {
        try {
          const profileDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
          if (profileDoc.exists()) {
            setUserProfile(profileDoc.data() as User);
          }
        } catch (error) {
          console.error('Error fetching user profile:', error);
        }
      } else {
        setUserProfile(null);
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const signIn = async (email: string, password: string) => {
    if (!auth) throw new Error('Firebase not configured. Add your Firebase credentials to Vercel.');
    await signInWithEmailAndPassword(auth, email, password);
  };

  const signOut = async () => {
    if (!auth) return;
    await firebaseSignOut(auth);
  };

  const createAccount = async (email: string, password: string, companyName: string) => {
    if (!auth || !db) throw new Error('Firebase not configured.');
    const { user: newUser } = await createUserWithEmailAndPassword(auth, email, password);
    // The server creates the profile and the company: browsers are not allowed to write users/{uid} (a browser that
    // could would be able to name any company and join it as an admin).
    const res = await apiFetch('/api/account/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyName }),
    });
    if (!res.ok) throw new Error('Account setup failed.');
    const { companyId } = (await res.json()) as { companyId: string };
    setUserProfile({ uid: newUser.uid, email, companyId, role: 'admin' } as User);
    return companyId;
  };

  return (
    <AuthContext.Provider value={{ user, userProfile, loading, signIn, signOut, createAccount }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
