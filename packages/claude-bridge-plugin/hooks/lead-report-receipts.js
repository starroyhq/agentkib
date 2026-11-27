const NATIVE_MESSAGE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validNativeMessageId(value) {
  return typeof value === "string" && NATIVE_MESSAGE_ID.test(value);
}

export function leadReportMessageIds(state) {
  return state.connection?.features?.includes("lead-report-message-ids") === true;
}

export function markOutboxUnknown(state, item, pending) {
  item.status = "unknown";
  if (!pending.report) {
    state.sendDisabled = true;
  } else if (
    !item.reportReceiptKey &&
    !pending.competing &&
    state.revision === pending.expectedRevision
  ) {
    // Wait for this prompt's native start, another main turn, or a verified reconnect.
    // The row stays unknown unless there is positive evidence, so it is never selected again.
    state.unconfirmedReport = pending;
  }
}

export async function loadReportMessageId(state, item, read) {
  if (!leadReportMessageIds(state) || item.reportMessageId) return;
  try {
    const messageId = await read(`${item.reportReceiptKey}:native-message`);
    if (validNativeMessageId(messageId)) item.reportMessageId = messageId;
  } catch {
    // This extra evidence only affects presentation of the confirmed delivery.
  }
}

export function acknowledgeReport(state, item) {
  if (state.closed || state.identity?.nativeId !== item.reportSessionId) return;
  state.outbox = state.outbox.filter((entry) => entry !== item);
  state.reportAcks.set(item.id, item.reportMessageId ?? null);
  state.dirty = true;
}

export async function confirmReportReceipt(state, item, write) {
  // The native turn is already verified. If persistence temporarily fails,
  // retain that evidence in memory and never submit this ID again.
  item.reportTurnVerified = true;
  if (item.reportMessageId && leadReportMessageIds(state)) {
    try {
      // Leave the existing receipt key readable by a previous plugin version.
      await write(`${item.reportReceiptKey}:native-message`, item.reportMessageId);
    } catch {
      // A presentation field must never block a delivery acknowledgment.
    }
  }
  try {
    await write(item.reportReceiptKey, "delivered");
  } catch {
    item.status = "unknown";
    return false;
  }
  acknowledgeReport(state, item);
  return true;
}

export async function recoverReportReceipt(state, item, write, readMessages) {
  if (item.reportTurnVerified) return confirmReportReceipt(state, item, write);
  // Reloading may miss both native hooks. The unique marker in a native user
  // row followed by a native assistant row establishes that it opened a turn.
  // A missing row can be compaction or a submit still in progress. It is not
  // permission to submit an already claimed report again.
  if (state.compacting || (item.nextReportReceiptCheck ?? 0) > Date.now()) return false;
  item.nextReportReceiptCheck = Date.now() + 5_000;
  try {
    const rows = await readMessages();
    for (let index = rows.length - 1; index >= 0; index--) {
      if (rows[index]?.role !== "user" || rows[index].text !== item.nativeReportText) continue;
      for (let later = index + 1; later < rows.length; later++) {
        const row = rows[later];
        if (row?.role === "assistant") return confirmReportReceipt(state, item, write);
        if (row?.role === "user") return false;
      }
      return false;
    }
  } catch {
    // An unavailable history never authorizes another native prompt.
  }
  return false;
}
