import { createArtifactPanels } from "@agentkib/session-ui";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "../../components/ui/resizable";
import { Sheet, SheetContent } from "../../components/ui/sheet";

export const { ArtifactWorkspace, ArtifactPanel } = createArtifactPanels({
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
  Sheet,
  SheetContent,
});
