const queuePanels = {
  "deepseek-harness": { surface: "managed", serial: false },
  devin: { surface: "managed", serial: true },
  antigravity: { surface: "basic", serial: true },
} as const;

export type SessionQueuePanelAgent = keyof typeof queuePanels;

/** Selects the queue panel in the composer. Live capabilities still govern its actions. */
export function sessionQueuePanel(value: string | undefined) {
  if (!value || !Object.hasOwn(queuePanels, value)) return undefined;
  const agent = value as SessionQueuePanelAgent;
  return { agent, ...queuePanels[agent] };
}
