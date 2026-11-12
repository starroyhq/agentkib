/** Preserve the first surviving visible row when a transcript window is prepended. */
export function captureHistoryScrollAnchor(viewport: HTMLElement): () => void {
  const selector = "[data-history-anchor], [data-event-id]";
  function anchorId(node: HTMLElement): string {
    return node.dataset.historyAnchor
      ? `history:${node.dataset.historyAnchor}`
      : `event:${node.dataset.eventId}`;
  }
  function position(node: HTMLElement): DOMRect | undefined {
    if (node.closest("[hidden]")) return;
    const rect = node.getBoundingClientRect();
    if (rect.height > 0) return rect;
  }
  const top = viewport.getBoundingClientRect().top;
  const height = viewport.scrollHeight;
  const scroll = viewport.scrollTop;
  const candidates = Array.from(viewport.querySelectorAll<HTMLElement>(selector)).flatMap(
    (node) => {
      const rect = position(node);
      return rect && rect.bottom > top ? [{ id: anchorId(node), top: rect.top }] : [];
    },
  );
  return () => {
    const nodes = new Map(
      Array.from(viewport.querySelectorAll<HTMLElement>(selector)).map((node) => [
        anchorId(node),
        node,
      ]),
    );
    for (const candidate of candidates) {
      const node = nodes.get(candidate.id);
      const rect = node && position(node);
      if (!rect) continue;
      viewport.scrollTop += rect.top - candidate.top;
      return;
    }
    viewport.scrollTop = scroll + viewport.scrollHeight - height;
  };
}
