"use client";

import { createContext, useContext } from "react";

interface SidebarContextValue {
  toggleMobileSidebar: () => void;
}

export const SidebarContext = createContext<SidebarContextValue>({
  toggleMobileSidebar: () => {},
});

export const useSidebar = () => useContext(SidebarContext);
