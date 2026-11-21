import { describe, expect, it, vi } from "vitest";
import { ControlValidationError } from "../../../packages/backend/src/sessions/validate/error";
import { validateProviderSettings } from "../../../packages/backend/src/sessions/validate/settings";

describe("Provider settings preflight", () => {
  const state = {
    revision: 4,
    models: [{ id: "alias", resolvedModel: "full-id", efforts: ["low"], serviceTierIds: ["fast"] }],
    selected: { model: "full-id" },
    writable: {
      model: true,
      effort: true,
      permissionMode: true,
      serviceTier: true,
      restoreDefaults: false,
    },
  };
  const body = { expectedRevision: 4 };

  it("checks the follower settings scope before using its model catalog", () => {
    const follower = { ...state, writeScope: "verified-scope" };
    const policy = { requireWriteScope: true };
    expect(() =>
      validateProviderSettings({ ...body, model: [] }, follower, policy, () => {}),
    ).toThrow("stale_state");
    expect(
      validateProviderSettings(
        { ...body, expectedSettingsScope: "verified-scope", model: "alias", effort: "low" },
        follower,
        policy,
        () => {},
      ),
    ).toEqual({ expectedSettingsScope: "verified-scope", model: "alias", effort: "low" });
  });

  it("supports effort against the resolved current model only when the provider opts in", () => {
    expect(
      validateProviderSettings(
        { ...body, effort: "low" },
        state,
        { resolvedModel: true },
        () => {},
      ),
    ).toEqual({ effort: "low" });
    expect(() => validateProviderSettings({ ...body, effort: "low" }, state, {}, () => {})).toThrow(
      "unsupported_effort",
    );
  });

  it("checks an elevated permission mode before projecting settings and rejects unwritable modes first", () => {
    const requireFullAccess = vi.fn(() => {
      throw new ControlValidationError(403, "permission_denied");
    });
    const policy = { permissionModes: ["auto", "smart"], fullAccessPermissionModes: ["smart"] };
    expect(() =>
      validateProviderSettings(
        { ...body, permissionMode: "smart" },
        { ...state, writable: { permissionMode: false } },
        policy,
        requireFullAccess,
      ),
    ).toThrow("setting_unavailable");
    expect(requireFullAccess).not.toHaveBeenCalled();
    expect(() =>
      validateProviderSettings(
        { ...body, permissionMode: "smart" },
        state,
        policy,
        requireFullAccess,
      ),
    ).toThrow("permission_denied");
    expect(requireFullAccess).toHaveBeenCalledTimes(1);
    expect(
      validateProviderSettings(
        { ...body, permissionMode: "auto" },
        state,
        policy,
        requireFullAccess,
      ),
    ).toEqual({ permissionMode: "auto" });
  });

  it("keeps the native restore grant separate from the model-derived restore rule", () => {
    const restore = { ...body, restoreDefaults: true };
    const defaults = { modelId: "default-model" };
    expect(validateProviderSettings(restore, { ...state, defaults }, {}, () => {})).toEqual({
      resetDefaults: true,
    });
    expect(() =>
      validateProviderSettings(
        restore,
        { ...state, defaults, executionMode: "devin-print" },
        {},
        () => {},
      ),
    ).toThrow("defaults_unavailable");
    expect(
      validateProviderSettings(
        restore,
        { revision: 4, executionMode: "claude-managed", writable: { restoreDefaults: true } },
        {},
        () => {},
      ),
    ).toEqual({ resetDefaults: true });
  });
});
