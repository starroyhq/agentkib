import type { SessionConnectionPanels } from "../session-connection-panels";
import { DshBridgePanel } from "./dsh-bridge-panel";

export const pluginBridgePanels = { Settings: DshBridgePanel } satisfies SessionConnectionPanels;
