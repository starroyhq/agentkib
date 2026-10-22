import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { desktopApi } from "@/core/desktop";
import { compactPath } from "./path-display";

const HomeDirectoryContext = createContext<string | undefined>(undefined);

export function PathDisplayProvider({ children }: { children: ReactNode }) {
  const [homeDirectory, setHomeDirectory] = useState<string>();
  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(() => desktopApi().paths?.displayContext())
      .then((context) => {
        if (active && context) setHomeDirectory(context.homeDirectory);
      })
      .catch(() => {
        // An unavailable display context must not block the page or guess a home directory.
      });
    return () => {
      active = false;
    };
  }, []);
  return <HomeDirectoryContext value={homeDirectory}>{children}</HomeDirectoryContext>;
}

export function usePathDisplay(): (path: string) => string {
  const homeDirectory = useContext(HomeDirectoryContext);
  return useCallback((path: string) => compactPath(path, homeDirectory), [homeDirectory]);
}
