import { createFileRoute } from "@tanstack/react-router";
import { SessionLayout } from "@/features/sessions/session-layout";
export const Route = createFileRoute("/_session")({ component: SessionLayout });
