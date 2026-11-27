import { REMOTE_ERROR_CODES as codes } from "@agentkib/runtime-protocol";
import { devinExecutable } from "./devin-executable";
import { devinChildEnvironment, devinLoginStatus } from "./devin-managed-runner";

/** Probes the account once for many candidates, without opening ACP or keeping account data. */
export class DevinRoleLogin {
  #probe?: { executable: string; expiresAt: number; status: ReturnType<typeof devinLoginStatus> };

  async refusal(inherited: NodeJS.ProcessEnv) {
    const environment = devinChildEnvironment({ ...process.env, ...inherited });
    const executable = devinExecutable(environment);
    if (!executable) return codes.devinCliUnavailable;
    if (this.#probe?.executable !== executable || this.#probe.expiresAt <= Date.now()) {
      const probe = {
        executable,
        expiresAt: Infinity,
        status: devinLoginStatus(executable, environment),
      };
      this.#probe = probe;
      void probe.status.then(() => {
        probe.expiresAt = Date.now() + 5_000;
      });
    }
    const login = await this.#probe.status;
    if (login === "logged-out") return codes.devinLoginRequired;
    if (login === "unverified") return codes.devinAuthProbeFailed;
  }
}
