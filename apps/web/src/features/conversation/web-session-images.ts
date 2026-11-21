import { createSessionImageScope } from "@agentkib/session-ui";
import { webSessionReadScope } from "./session-platform";

export const webSessionImages = createSessionImageScope("web", {
  // Read the shared adapter lazily because it also imports app session views.
  getImageSnapshot: (access) => webSessionReadScope.getImageSnapshot(access),
});

export const {
  acceptSessionImageAccess,
  createSessionImageLoader,
  forgetSessionImages,
  invalidateSessionImages,
  mountSessionImages,
  noteSessionImageBoot,
  readSessionImageAccess,
  restoreSessionImages,
  sessionImageCacheScope,
  sessionImageRevision,
  setSessionImageIndexEnabled,
} = webSessionImages;
