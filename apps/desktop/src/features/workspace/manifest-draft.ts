import type { Manifest } from "@/core/types";

/** Adopt external changes unless doing so would overwrite an actual editor draft. */
export async function resolveRefreshedManifest({
  initialManifest,
  initialBaseline,
  initialBaselineIsDefault = false,
  acknowledgedDisk,
  acknowledgedDiskIsDefault = false,
  cachedDraft,
  diskManifest,
  diskIsDefault = false,
  getCurrentManifest,
  confirmDiskVersion,
  onConflictRetained,
}: {
  initialManifest?: Manifest;
  initialBaseline: string;
  initialBaselineIsDefault?: boolean;
  acknowledgedDisk?: string;
  acknowledgedDiskIsDefault?: boolean;
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
  // Only two confirmed preparations can exchange temporary IDs. A deleted real
  // manifest must retain its persisted identity when the user keeps that draft.
  const refreshPreparedIdentity = diskIsDefault && initialBaselineIsDefault;
  const candidate =
    diskManifest && refreshPreparedIdentity
      ? withPreparedIdentity(originalCandidate, diskManifest)
      : originalCandidate;
  if (!diskManifest) return candidate;
  const candidateSnapshot = JSON.stringify(candidate);
  const diskSnapshot = JSON.stringify(diskManifest);
  const baseline = preparedManifestBaseline(initialBaseline, diskManifest, refreshPreparedIdentity);
  const acknowledged = acknowledgedDisk ?? initialBaseline;
  const knownIsDefault =
    acknowledgedDisk !== undefined ? acknowledgedDiskIsDefault : initialBaselineIsDefault;
  const knownDisk = preparedManifestBaseline(
    acknowledged,
    diskManifest,
    diskIsDefault && knownIsDefault,
  );
  const baselineMatches =
    diskSnapshot === baseline &&
    diskIsDefault === initialBaselineIsDefault &&
    diskIsDefault === knownIsDefault;
  const knownDiskMatches = diskSnapshot === knownDisk && diskIsDefault === knownIsDefault;
  const hasDraft = candidate && (editedDuringRefresh || candidateSnapshot !== baseline);
  if (!hasDraft || candidateSnapshot === diskSnapshot) return diskManifest;
  let retainedExternal = !!initialBaseline && !baselineMatches;
  if (acknowledged && !knownDiskMatches && !baselineMatches) {
    const loadDisk = await confirmDiskVersion();
    const latest = getCurrentManifest();
    // A confirmation only covers the draft shown when the dialog opened.
    if (JSON.stringify(latest) !== JSON.stringify(current)) {
      onConflictRetained?.();
      return refreshPreparedIdentity ? withPreparedIdentity(latest, diskManifest) : latest;
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

export function preparedManifestBaseline(baseline: string, disk: Manifest, bothPrepared: boolean) {
  if (!baseline || !bothPrepared) return baseline;
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
