import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { resolveSecretRefProviderSourceMismatch } from "../secrets/ref-contract.js";
import { discoverConfigSecretTargets } from "../secrets/target-registry.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";
import { resolveSecretInputRef } from "./types.secrets.js";
import { withConfigIssuePath } from "./validation-issues.js";

export function collectSecretRefProviderSourceIssues(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry: PluginManifestRegistry;
}): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  for (const target of discoverConfigSecretTargets(params.config, {
    env: params.env,
    manifestRegistry: params.manifestRegistry,
  })) {
    const { ref } = resolveSecretInputRef({
      value: target.value,
      refValue: target.refValue,
      defaults: params.config.secrets?.defaults,
    });
    if (!ref) {
      continue;
    }
    const configuredSource = resolveSecretRefProviderSourceMismatch(params.config, ref);
    if (!configuredSource) {
      continue;
    }
    const path = target.refPath ?? target.path;
    const pathSegments = target.refPathSegments ?? target.pathSegments;
    issues.push(
      withConfigIssuePath(
        {
          path,
          message: `Secret provider "${ref.provider}" has source "${configuredSource}" but ref requests "${ref.source}".`,
        },
        pathSegments,
      ),
    );
  }
  return issues;
}
