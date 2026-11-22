import { bindSessionNavigation } from "@agentkib/session-ui";
import { useNavigate } from "@tanstack/react-router";

export const useSessionNavigate = bindSessionNavigation(useNavigate);
