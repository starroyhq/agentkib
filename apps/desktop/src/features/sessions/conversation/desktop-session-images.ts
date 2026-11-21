import { createSessionImageScope } from "@agentkib/session-ui";
import { desktopSessionReadScope } from "./session-platform";

export const desktopSessionImages = createSessionImageScope("desktop", {
  // Read the shared adapter lazily because it also imports app session views.
  getImageSnapshot: (access) => desktopSessionReadScope.getImageSnapshot(access),
  imageInvalidationSource: () => desktopSessionReadScope.imageInvalidationSource?.(),
  subscribeImageInvalidation: (listener) =>
    desktopSessionReadScope.subscribeImageInvalidation?.(listener) ?? (() => {}),
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
} = desktopSessionImages;
