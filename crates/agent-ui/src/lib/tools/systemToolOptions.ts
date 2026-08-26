export type SystemToolRuntimeScope = "chat" | "cron_auto_prompt";

/** 极简模式常驻核心工具集：文件读写/搜索 + Shell + 按需检索。
 *  MemoryManager schema 较大，实测会使常驻工具超过 4K token，故按方案降级为
 *  ToolSearch 延迟加载。 */
export const MINIMAL_MODE_TOOL_NAMES: readonly string[] = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "ToolSearch",
];

export function isMinimalModeToolName(name: string): boolean {
  return MINIMAL_MODE_TOOL_NAMES.includes(name);
}
