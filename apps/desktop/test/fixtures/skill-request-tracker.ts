interface SkillRequestClient {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export function createSkillRequestTracker() {
  const pending = new Set<Promise<unknown>>();
  const observe = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };
  return {
    run<T>(body: () => Promise<T>): Promise<T> {
      // A timeout can leave the test between requests or inside fixture I/O.
      // Track its whole Promise so every awaited continuation finishes first.
      return observe(body());
    },
    track<T extends SkillRequestClient>(client: T): T {
      const request = client.request.bind(client);
      client.request = (method, params) => observe(request(method, params));
      return client;
    },
    async settle() {
      // A test timeout does not cancel filesystem work. Keep each original
      // Promise and rejection, but let started bodies and writes finish first.
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}
