import { theme } from "../../../packages/terminal-core/src/theme.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import { tryWriteCompletionCache } from "./shared.js";

/** Optional completion work runs only after the update lifecycle settles. */
export async function refreshUpdateCompletionCache(root: string, jsonMode: boolean): Promise<void> {
  try {
    await tryWriteCompletionCache(root, jsonMode);
  } catch (err) {
    if (!jsonMode) {
      defaultRuntime.log(
        theme.warn(
          `Completion cache update failed: ${formatErrorMessage(err)}. Update will continue; retry with: ${formatCliCommand("openclaw completion --write-state")}`,
        ),
      );
    }
  }
}
