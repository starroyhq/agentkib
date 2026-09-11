import { createFileRoute } from "@tanstack/react-router";
import { SessionWorkspace } from "@/features/sessions/session-workspace";
export const Route = createFileRoute("/_session/sessions")({ component: SessionWorkspace });
