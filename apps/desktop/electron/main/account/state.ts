export type DesktopAccountProfile = {
  id: string;
  username: string;
  status: string;
  deviceLimit: number;
  deviceCount: number;
  totpEnabled: boolean;
};
export type DesktopAccountStatus = {
  phase: "signed-out" | "signing-in" | "signed-in" | "error";
  account?: DesktopAccountProfile;
  /** `name` is how the account lists this computer; present only when owned and known. */
  device?: { deviceId: string; ownership: "unclaimed" | "owned" | "other"; name?: string };
  error?: string;
  secureStorage: boolean;
};
export type DesktopAccountRequest = {
  operation: "status" | "login" | "cancel-login" | "logout" | "claim" | "manage";
};
