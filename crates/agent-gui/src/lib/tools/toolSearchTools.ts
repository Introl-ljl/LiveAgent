// 工具懒加载(ToolSearch):MCP 工具 schema 总量超过阈值时,或极简模式下需要
// 压缩常驻工具时,工具仍全量注册在执行层(pi-agent-core 的 prepareToolCall
// 从 loop 快照查找,必须始终找得到),但**发给模型的请求**只包含常驻/已激活
// 工具——未激活的经 runner 的 requestToolFilter 滤掉(与 provider 原生搜索
// "执行层可见、请求层隐藏"同机制)。模型通过 ToolSearch 检索并激活工具;直接
// 调用未激活工具也会执行成功并自动激活(turn 层 executor wrapper),避免
// "调用成功但下轮看不见"的困惑。激活集按会话保存在内存(跨 turn 持久,重启后
// 模型重新检索一次即可)。

import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { estimateToolsTokens } from "../chat/compaction/tokenLedger";
import {
  type BuiltinToolBundle,
  type BuiltinToolMetadata,
  createBuiltinMetadataMap,
} from "./builtinTypes";

export const TOOL_SEARCH_TOOL_NAME = "ToolSearch";

/**
 * 懒加载阈值(估算 tokens):MCP 工具 schema 总量低于它时全量注入请求,
 * 不启用 ToolSearch——多一次检索回合的代价只在真的省下可观 context 时才值。
 */
export const MCP_TOOL_DEFERRAL_THRESHOLD_TOKENS = 12_000;

/** 单次检索返回的工具数上限;夹在 [1, MAX] 内。 */
export const TOOL_SEARCH_MAX_RESULTS = 10;
const TOOL_SEARCH_DEFAULT_RESULTS = 5;

// 会话级激活集:跨 turn 保持(同一桌面会话进程内),会话销毁时清理。
// 不落盘——重启后的新会话由模型按需重新 ToolSearch,成本是一次工具回合。
const activationByConversation = new Map<string, Set<string>>();

export function getMcpToolActivation(conversationId: string): Set<string> {
  return getDeferredToolActivation(conversationId);
}

export function getDeferredToolActivation(conversationId: string): Set<string> {
  const key = conversationId.trim();
  let set = activationByConversation.get(key);
  if (!set) {
    set = new Set();
    activationByConversation.set(key, set);
  }
  return set;
}

export function clearMcpToolActivation(conversationId: string) {
  clearDeferredToolActivation(conversationId);
}

export function clearDeferredToolActivation(conversationId: string) {
  activationByConversation.delete(conversationId.trim());
}

/** MCP 懒加载目录条目；保留原类型名以兼容现有调用。 */
export type DeferredMcpToolEntry = {
  tool: Tool;
  serverLabel: string;
};

/** 通用延迟工具目录条目：MCP 传 serverLabel，内置工具可传 label。 */
export type DeferredToolEntry = {
  tool: Tool;
  serverLabel?: string;
  label?: string;
};

function normalizeQueryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,;/|]+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

/**
 * 无依赖的轻量评分:词项对 name(×3)/serverLabel 或 label(×2)/description(×1)
 * 的子串命中加权求和。目录只有几十到几百个工具,线性扫描足够;不引入 FTS。
 */
function scoreEntry(entry: DeferredToolEntry, terms: string[]): number {
  const name = entry.tool.name.toLowerCase();
  const description = (entry.tool.description ?? "").toLowerCase();
  const server = (entry.serverLabel ?? entry.label ?? "").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) score += 3;
    if (server.includes(term)) score += 2;
    if (description.includes(term)) score += 1;
  }
  return score;
}

export type ToolSearchResultDetails = {
  kind: "tool_search";
  query: string;
  /** 本次新激活的工具名(规范调用名)。 */
  activated: string[];
  totalDeferred: number;
};

function buildErrorResult(toolCall: ToolCall, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    details: {},
    isError: true,
    timestamp: Date.now(),
  };
}

/**
 * 判定是否启用懒加载:估算全部 MCP 工具 schema 的 token 量与阈值比较。
 * 判定输入是"会进请求的 JSON"(与 tokenLedger 同一估算口径)。
 */
export function shouldDeferMcpTools(
  mcpTools: readonly Tool[],
  thresholdTokens = MCP_TOOL_DEFERRAL_THRESHOLD_TOKENS,
): boolean {
  if (mcpTools.length === 0) return false;
  return estimateToolsTokens(mcpTools as Tool[]) > thresholdTokens;
}

export function createToolSearchTools(params: {
  conversationId: string;
  /** 被延迟注入的工具目录：MCP 传 serverLabel，内置工具可传 label。 */
  entries: readonly DeferredToolEntry[];
}): BuiltinToolBundle {
  const activation = getMcpToolActivation(params.conversationId);
  const isMcpCatalog =
    params.entries.length > 0 && params.entries.every((entry) => Boolean(entry.serverLabel));
  const labels = [
    ...new Set(
      params.entries.map((entry) => entry.serverLabel ?? entry.label ?? "builtin").filter(Boolean),
    ),
  ];
  const catalogNoun = isMcpCatalog ? "MCP tools" : "deferred tools";
  const labelText =
    labels.length > 5 ? `${labels.slice(0, 5).join(", ")} (+${labels.length - 5} more)` : labels.join(", ");
  const sourceText = isMcpCatalog
    ? `${params.entries.length} MCP tools (from: ${labelText}) are NOT`
    : `${params.entries.length} deferred tools are NOT`;
  const toolSearch: Tool = {
    name: TOOL_SEARCH_TOOL_NAME,
    description: [
      `Search the deferred tool catalog and activate matching tools. ${sourceText} in your tool list yet to save context.`,
      'Call this with a task-oriented query (e.g. "create issue", "query database", "send message") BEFORE assuming a capability is missing. Matched tools are returned with their full schemas and become directly callable from the next step on.',
      "Results are ranked by name/category/description match. Broaden the query if nothing relevant comes back; activation persists for this conversation.",
    ].join("\n"),
    parameters: Type.Object({
      query: Type.String({
        description: "Task-oriented keywords to match against tool names and descriptions.",
      }),
      max_results: Type.Optional(
        Type.Number({
          description: `How many tools to return and activate (default ${TOOL_SEARCH_DEFAULT_RESULTS}, max ${TOOL_SEARCH_MAX_RESULTS}).`,
        }),
      ),
    }),
  };

  async function executeToolCall(toolCall: ToolCall): Promise<ToolResultMessage> {
    if (toolCall.name !== TOOL_SEARCH_TOOL_NAME) {
      return buildErrorResult(toolCall, `Unknown tool: ${toolCall.name}`);
    }
    const args = (toolCall.arguments || {}) as Record<string, unknown>;
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return buildErrorResult(toolCall, "query is required: pass task-oriented keywords.");
    }
    const requested =
      typeof args.max_results === "number" && Number.isFinite(args.max_results)
        ? Math.floor(args.max_results)
        : TOOL_SEARCH_DEFAULT_RESULTS;
    const limit = Math.min(Math.max(requested, 1), TOOL_SEARCH_MAX_RESULTS);

    const terms = normalizeQueryTerms(query);
    const ranked = params.entries
      .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (ranked.length === 0) {
      const details: ToolSearchResultDetails = {
        kind: "tool_search",
        query,
        activated: [],
        totalDeferred: params.entries.length,
      };
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [
          {
            type: "text",
            text: `No deferred ${catalogNoun} matched "${query}". ${params.entries.length} tools available from: ${labelText}. Try broader or different keywords.`,
          },
        ],
        details,
        isError: false,
        timestamp: Date.now(),
      };
    }

    const activated: string[] = [];
    for (const { entry } of ranked) {
      if (!activation.has(entry.tool.name)) {
        activation.add(entry.tool.name);
        activated.push(entry.tool.name);
      }
    }
    const lines = ranked.map(({ entry }) =>
      [
        `## ${entry.tool.name}`,
        entry.tool.description ?? "",
        "```json",
        JSON.stringify(entry.tool.parameters ?? {}),
        "```",
      ].join("\n"),
    );
    const details: ToolSearchResultDetails = {
      kind: "tool_search",
      query,
      activated,
      totalDeferred: params.entries.length,
    };
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [
        {
          type: "text",
          text: [
            `Activated ${ranked.length} tool(s) — callable directly from now on:`,
            "",
            ...lines,
          ].join("\n"),
        },
      ],
      details,
      isError: false,
      timestamp: Date.now(),
    };
  }

  return {
    groupId: "system",
    tools: [toolSearch],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        TOOL_SEARCH_TOOL_NAME,
        {
          groupId: "system",
          kind: "tool_search",
          // 只读:仅查目录并改写会话内激活集,不触碰任何外部状态。
          isReadOnly: true,
          displayCategory: "system",
        },
      ],
    ]),
  };
}

/**
 * 请求层可见性谓词:非 MCP 业务工具恒可见;MCP 业务工具需已激活。判定必须用
 * kind === "mcp"(业务工具专属),不能用裸 groupId——McpManager 也在 groupId
 * "mcp" 下,但它不进延迟目录,按 groupId 隐藏会让它从模型请求中永久消失。
 * ToolSearch 自身恒可见。runner 每轮请求都会重新评估,激活后下一轮立即生效。
 */
export function buildMcpRequestToolFilter(params: {
  conversationId: string;
  metadataByName: Map<string, BuiltinToolMetadata>;
}): (toolName: string) => boolean {
  const activation = getMcpToolActivation(params.conversationId);
  return (toolName: string) => {
    const metadata = params.metadataByName.get(toolName);
    if (metadata?.groupId !== "mcp" || metadata.kind !== "mcp") return true;
    return activation.has(toolName);
  };
}

/**
 * 通用请求层可见性谓词：只在 `deferredToolNames` 中的工具需要已激活才可见，
 * 其余工具（常驻工具、ToolSearch、未列入延迟目录的工具）恒可见。
 */
export function buildDeferredToolRequestFilter(params: {
  conversationId: string;
  metadataByName: Map<string, BuiltinToolMetadata>;
  deferredToolNames: readonly string[] | ReadonlySet<string>;
}): (toolName: string) => boolean {
  const activation = getDeferredToolActivation(params.conversationId);
  const deferred = new Set(params.deferredToolNames);
  return (toolName: string) => {
    if (!deferred.has(toolName)) return true;
    return activation.has(toolName);
  };
}
