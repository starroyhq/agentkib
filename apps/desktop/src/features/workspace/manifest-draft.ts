import type { Manifest } from "@/core/types";

/** Adopt external changes unless doing so would overwrite an actual editor draft. */
export async function resolveRefreshedManifest({
  initialManifest,
  initialBaseline,
  acknowledgedDisk,
  cachedDraft,
  diskManifest,
  diskIsDefault = false,
  getCurrentManifest,
  confirmDiskVersion,
  onConflictRetained,
}: {
  initialManifest?: Manifest;
  initialBaseline: string;
  acknowledgedDisk?: string;
  cachedDraft?: Manifest;
  diskManifest?: Manifest;
  diskIsDefault?: boolean;
  getCurrentManifest: () => Manifest | undefined;
  confirmDiskVersion: () => Promise<boolean>;
  onConflictRetained?: () => void;
}): Promise<Manifest | undefined> {
  const current = getCurrentManifest();
  const editedDuringRefresh = JSON.stringify(current) !== JSON.stringify(initialManifest);
  const originalCandidate = editedDuringRefresh ? current : (initialManifest ?? cachedDraft);
  const candidate =
    diskManifest && diskIsDefault
      ? withPreparedIdentity(originalCandidate, diskManifest)
      : originalCandidate;
  if (!diskManifest) return candidate;
  const candidateSnapshot = JSON.stringify(candidate);
  const diskSnapshot = JSON.stringify(diskManifest);
  const baseline = preparedManifestBaseline(initialBaseline, diskManifest, diskIsDefault);
  const acknowledged = acknowledgedDisk ?? initialBaseline;
  const knownDisk = preparedManifestBaseline(acknowledged, diskManifest, diskIsDefault);
  const hasDraft = candidate && (editedDuringRefresh || candidateSnapshot !== baseline);
  if (!hasDraft || candidateSnapshot === diskSnapshot) return diskManifest;
  let retainedExternal = !!initialBaseline && diskSnapshot !== baseline;
  if (acknowledged && diskSnapshot !== knownDisk && diskSnapshot !== baseline) {
    const loadDisk = await confirmDiskVersion();
    const latest = getCurrentManifest();
    // A confirmation only covers the draft shown when the dialog opened.
    if (JSON.stringify(latest) !== JSON.stringify(current)) {
      onConflictRetained?.();
      return diskIsDefault ? withPreparedIdentity(latest, diskManifest) : latest;
    }
    if (loadDisk) return diskManifest;
    retainedExternal = true;
  }
  // Acknowledgment suppresses the same dialog, not the draft's original baseline.
  // Loaders still need to preserve that baseline when an external version was kept.
  if (retainedExternal) onConflictRetained?.();
  return candidate;
}

function withPreparedIdentity(manifest: Manifest | undefined, disk: Manifest) {
  if (!manifest || manifest.workspace.id === disk.workspace.id) return manifest;
  // A missing manifest gets a fresh server-side draft ID on every read. Use the latest
  // prepared ID without treating it as a user's edit or changing any persisted identity.
  return { ...manifest, workspace: { ...manifest.workspace, id: disk.workspace.id } };
}

export function preparedManifestBaseline(baseline: string, disk: Manifest, diskIsDefault: boolean) {
  if (!baseline || !diskIsDefault) return baseline;
  try {
    const previous = JSON.parse(baseline) as Manifest;
    if (!previous?.workspace || typeof previous.workspace.id !== "string") return baseline;
    return JSON.stringify(withPreparedIdentity(previous, disk));
  } catch {
    return baseline;
  }
}

export function draftSectionCount(manifest: Manifest | undefined, baseline: string): number {
  if (!manifest || !baseline || JSON.stringify(manifest) === baseline) return 0;
  try {
    const saved = JSON.parse(baseline) as Manifest;
    return (Object.keys(manifest) as Array<keyof Manifest>).filter(
      (key) => JSON.stringify(manifest[key]) !== JSON.stringify(saved[key]),
    ).length;
  } catch {
    // Keep the draft visible if an unavailable baseline prevents a precise count.
    return 1;
  }
}
