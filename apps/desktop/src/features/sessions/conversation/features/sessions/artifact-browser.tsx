import {
  ArtifactBrowser as SharedArtifactBrowser,
  type ArtifactBrowserControls,
} from "@agentkib/session-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SheetClose, SheetTitle } from "@/components/ui/sheet";
import { ArtifactPanel } from "./artifact-panel";
import { LivePreview } from "./live-preview";
import { useSession } from "./session-context";

const components = {
  ArtifactPanel,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  SheetClose,
  SheetTitle,
};

export function ArtifactBrowser(props: ArtifactBrowserControls = {}) {
  const session = useSession();
  const { access } = session;
  const scope = JSON.stringify([
    session.origin,
    access?.status,
    access?.bootId,
    access?.device?.id,
    access?.historySearchScope,
    access?.accountLogin?.bound,
    access?.accountLogin?.accountId,
  ]);
  return (
    <SharedArtifactBrowser
      key={scope}
      {...props}
      session={session}
      surface="desktop"
      components={components}
      livePreview={<LivePreview />}
    />
  );
}
