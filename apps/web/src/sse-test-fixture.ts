export class TestSseConnection {
  readonly response: Response;
  closed = false;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private readonly encoder = new TextEncoder();

  constructor(private readonly signal?: AbortSignal | null) {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: this.finish,
    });
    this.response = new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    if (signal?.aborted) this.abort();
    else signal?.addEventListener("abort", this.abort, { once: true });
  }

  emit(event: string, data: unknown = {}) {
    this.emitFrames([{ event, data }]);
  }

  emitFrames(frames: { event: string; data: unknown }[]) {
    if (this.closed) return;
    const chunk = frames
      .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      .join("");
    this.controller.enqueue(this.encoder.encode(chunk));
  }

  disconnect() {
    if (this.closed) return;
    this.finish();
    this.controller.error(new Error("Connection interrupted"));
  }

  private finish = () => {
    this.closed = true;
    this.signal?.removeEventListener("abort", this.abort);
  };

  private abort = () => {
    if (this.closed) return;
    this.finish();
    this.controller.close();
  };
}
