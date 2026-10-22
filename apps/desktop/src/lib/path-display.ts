function splitPath(path: string): string[] {
  // POSIX filenames may contain literal backslashes.
  const windowsPath = /^[A-Za-z]:[\\/]|^\\\\/.test(path);
  return path.split(windowsPath ? /[\\/]/ : /\//);
}

export function shortPath(path: string): string {
  const parts = splitPath(path).filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
}

export function fileName(path: string): string {
  return splitPath(path).pop() ?? "";
}

/** Display-only shortening. Callers must retain the original path for all operations. */
export function compactPath(path: string, homeDirectory?: string, maxLength = 68): string {
  let display = path;
  if (homeDirectory) {
    const windowsHome = /^[A-Za-z]:[\\/]|^\\\\/.test(homeDirectory);
    const absoluteHome = windowsHome || homeDirectory.startsWith("/");
    const normalize = (value: string) => (windowsHome ? value.replaceAll("\\", "/") : value);
    const home = normalize(homeDirectory).replace(/\/+$/, "");
    const value = normalize(path);
    const hasTraversal = [home, value].some((item) =>
      item.split("/").some((part) => part === "." || part === ".."),
    );
    const prefix = windowsHome ? home.toLowerCase() : home;
    const candidate = windowsHome ? value.toLowerCase() : value;
    // Match a complete directory boundary; sibling homes must never acquire a false ~ prefix.
    if (
      absoluteHome &&
      home &&
      !hasTraversal &&
      (candidate === prefix || candidate.startsWith(`${prefix}/`))
    ) {
      display = `~${value.slice(home.length)}`;
    }
  }
  const characters = Array.from(display);
  const limit = Math.max(3, Math.floor(maxLength));
  if (characters.length <= limit) return display;
  const head = Math.ceil((limit - 1) / 2);
  const tail = Math.floor((limit - 1) / 2);
  return `${characters.slice(0, head).join("")}…${characters.slice(-tail).join("")}`;
}
