import { isDeepStrictEqual } from "node:util";

export function checkRemoteErrorRetry(retryPolicies, errors, previousErrors) {
  const policies = new Set(retryPolicies);
  for (const [name, { retry, ...entry }] of Object.entries(errors)) {
    if (!policies.has(retry)) {
      throw new Error(`Remote error ${name} must declare a valid retry policy.`);
    }
    if (retry !== "unclassified" || previousErrors === undefined) continue;

    // The first version of this check can inherit unchanged entries with no retry field.
    const previous = Object.hasOwn(previousErrors, name) ? previousErrors[name] : undefined;
    if (previous) {
      const { retry: previousRetry, ...previousEntry } = previous;
      if (
        (previousRetry === undefined || previousRetry === "unclassified") &&
        isDeepStrictEqual(entry, previousEntry)
      ) {
        continue;
      }
    }
    throw new Error(`New or changed remote error ${name} cannot be unclassified.`);
  }
}
