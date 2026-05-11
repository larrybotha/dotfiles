/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 * Patterns checked: rm -rf, sudo, chmod/chown 777, pass, gpg decrypt/export-secret
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const dangerousPatterns = [
    /\brm\s+(-rf?|--recursive)/i,
    /\bsudo\b/i,
    /\b(chmod|chown)\b.*777/i,
    /\bpass\s/i,
    /\bgpg2?\s.*(--decrypt|-d)\b/i, // direct decryption of password-store .gpg files
    /\bgpg2?\s.*(--export-secret-keys?|--export-secret-subkeys?)\b/i, // secret key extraction
    /\bgpg2?\s.*(--armor).*--export\b/i, // armored export of keys (may include secret)
  ];

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;
    const isDangerous = dangerousPatterns.some((p) => p.test(command));

    if (isDangerous) {
      if (!ctx.hasUI) {
        // In non-interactive mode, block by default
        return {
          block: true,
          reason: "Dangerous command blocked (no UI for confirmation)",
        };
      }

      const choice = await ctx.ui.select(
        `! Dangerous command:\n\n  ${command}\n\nAllow?`,
        ["Yes", "No"],
      );

      if (choice !== "Yes") {
        return { block: true, reason: "Blocked by user" };
      }
    }

    return undefined;
  });
}
