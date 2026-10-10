/** Runs cleanup after an async operation settles without making callers use `try/finally`. */
export async function withAsyncCleanup<T>(
  operation: () => T | Promise<T>,
  cleanup: () => void,
): Promise<T> {
  try {
    return await operation();
  } finally {
    cleanup();
  }
}
