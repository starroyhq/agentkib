export interface WorkspaceDiffContextLine {
  path: string;
  oldLine: number;
  newLine: number;
  text: string;
  source: "host";
}

export interface WorkspaceDiffContext {
  lines: WorkspaceDiffContextLine[];
  truncated?: true;
}

export interface WorkspaceDiff {
  patch: string;
  binary: boolean;
  submodule: boolean;
  encoding_lossy: boolean;
  truncated: boolean;
  context?: WorkspaceDiffContext;
}
