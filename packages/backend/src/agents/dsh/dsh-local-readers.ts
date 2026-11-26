import type { NativeHistoryWork } from "../../native-history-work";
import {
  readLocalDshHistory,
  readLocalDshTurn,
  type DshLocalTurnCheckpoint,
} from "./dsh-local-history";
import { dshSessionDirectory } from "./dsh-writer";

export async function readVerifiedDshHistory(
  home: string,
  nativeId: string,
  cwd: string,
  before: number | undefined,
  limit: number,
) {
  const directory = dshSessionDirectory(nativeId, cwd, home);
  return directory ? readLocalDshHistory(directory, nativeId, before, limit) : null;
}

export function dshLocalReaders(home: string, nativeHistory?: NativeHistoryWork) {
  return {
    localHistory(nativeId: string, cwd: string, before: number | undefined, limit: number) {
      return nativeHistory
        ? nativeHistory.read("dsh-history", [home, nativeId, cwd, before, limit]).catch(() => null)
        : readVerifiedDshHistory(home, nativeId, cwd, before, limit);
    },
    async localTurn(nativeId: string, cwd: string, previous?: DshLocalTurnCheckpoint) {
      const directory = dshSessionDirectory(nativeId, cwd, home);
      return directory ? readLocalDshTurn(directory, nativeId, previous) : null;
    },
  };
}
