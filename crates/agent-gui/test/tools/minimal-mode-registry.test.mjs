import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import { createFakeStoreIpc } from "../subagents/harness.mjs";

const loader = createTsModuleLoader({
  mocks: {
    "@tauri-apps/api/path": {
      async homeDir() {
        return "/Users/test";
      },
    },
    "@tauri-apps/api/core": {
      async invoke(command) {
        if (command === "mcp_list_tools") {
          return [
            {
              serverId: "docs",
              serverLabel: "Docs",
              name: "search",
              description: "Search docs",
              inputSchema: { type: "object" },
            },
          ];
        }
        throw new Error(`Unexpected invoke: ${command}`);
      },
    },
  },
});

const { buildBuiltinToolRegistry } = loader.loadModule("src/lib/tools/builtinRegistry.ts");
const { createFileToolState } = loader.loadModule("src/lib/tools/fileToolState.ts");
const { estimateTextTokens } = loader.loadModule("src/lib/chat/compaction/tokenLedger.ts");
const { serializeToolCatalog } = loader.loadModule("@liveagent/ui/lib/trajectory/sections.ts");
const { buildToolsSuffix } = loader.loadModule("src/lib/chat/runner/toolExecutionPrompt.ts");
const {
  buildDeferredToolRequestFilter,
  getMcpToolActivation,
} = loader.loadModule("src/lib/tools/toolSearchTools.ts");
const { createSubagentConversationStore } = loader.loadModule("src/lib/subagents/store.ts");
const { createSubagentScheduler } = loader.loadModule("src/lib/subagents/scheduler.ts");

const RESIDENT_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "ToolSearch",
];

function dummyTaskStateStore() {
  return {
    runId: "run-minimal",
    getState: () => undefined,
    commitState: async () => {},
  };
}

async function buildMinimalRegistry(extra = {}) {
  const conversationId = extra.conversationId ?? "conv-minimal";
  return buildBuiltinToolRegistry({
    workdir: "/workspace",
    providerId: "codex",
    fileState: createFileToolState(),
    skillsEnabled: true,
    runtimeScope: "chat",
    getMcpSettings: () => ({ servers: [], selected: [] }),
    minimalMode: true,
    toolSearch: { conversationId },
    taskStateStore: dummyTaskStateStore(),
    askUserQuestionConversationId: conversationId,
    ...extra,
  });
}

function deferredNames(registry) {
  return new Set(registry.deferredToolNames ?? []);
}

function visibleTools(registry, conversationId) {
  const filter = buildDeferredToolRequestFilter({
    conversationId,
    metadataByName: registry.metadataByName,
    deferredToolNames: registry.deferredToolNames ?? [],
  });
  return registry.tools.filter((tool) => filter(tool.name));
}

async function buildMinimalRegistryWithSubagents(conversationId = "conv-subagents") {
  const store = createSubagentConversationStore({
    conversationId,
    ipc: createFakeStoreIpc(),
  });
  const scheduler = createSubagentScheduler();
  return {
    registry: await buildMinimalRegistry({
      conversationId,
      subagentRuntime: {
        providerId: "codex",
        model: "gpt-5",
        runtime: { baseUrl: "https://api.example.test/v1", apiKey: "test-key" },
        sessionId: "parent-session",
        templates: [],
        store,
        scheduler,
      },
    }),
    store,
  };
}

test("minimal mode keeps full execution layer and marks deferred tools", async () => {
  const registry = await buildMinimalRegistry();
  const names = registry.tools.map((tool) => tool.name);
  assert.equal(registry.toolDeferralActive, true);
  assert.equal(registry.mcpToolDeferralActive, false);

  // 执行层仍然完整：Delete/List/Image/ManagedProcess 等保留可执行。
  for (const toolName of ["Delete", "List", "Image", "ManagedProcess", "McpManager", "SkillsManager"]) {
    assert.ok(names.includes(toolName), `${toolName} should remain in execution registry`);
  }

  const deferred = deferredNames(registry);
  for (const toolName of [
    "Delete",
    "List",
    "Image",
    "ManagedProcess",
    "ProcessWait",
    "ProcessStop",
    "ReadTerminal",
    "SkillsManager",
    "MemoryManager",
    "McpManager",
    "CronTaskManager",
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
    "AskUserQuestion",
  ]) {
    assert.ok(deferred.has(toolName), `${toolName} should be deferred`);
  }
  for (const toolName of RESIDENT_TOOL_NAMES) {
    assert.equal(deferred.has(toolName), false, `${toolName} should be resident`);
  }
});

test("minimal mode request filter exposes exactly the resident tools", async () => {
  const { registry } = await buildMinimalRegistryWithSubagents();
  const visible = visibleTools(registry, "conv-subagents");
  const names = visible.map((tool) => tool.name).sort();
  assert.deepEqual(names, [...RESIDENT_TOOL_NAMES].sort());
  assert.equal(visible.some((tool) => tool.name === "Agent"), false);
  assert.equal(visible.some((tool) => tool.name === "SendMessage"), false);
});

test("ToolSearch searches and activates deferred built-in tools", async () => {
  const registry = await buildMinimalRegistry({ conversationId: "conv-search-builtin" });
  const search = registry.tools.find((tool) => tool.name === "ToolSearch");
  assert.ok(search);

  const result = await registry.executeToolCall({
    type: "toolCall",
    id: "call-search-delete",
    name: "ToolSearch",
    arguments: { query: "delete file", max_results: 3 },
  });
  assert.equal(result.isError, false);
  assert.equal(result.details.kind, "tool_search");
  assert.ok(result.details.activated.includes("Delete"));

  const filter = buildDeferredToolRequestFilter({
    conversationId: "conv-search-builtin",
    metadataByName: registry.metadataByName,
    deferredToolNames: registry.deferredToolNames ?? [],
  });
  assert.equal(filter("Delete"), true);
  assert.equal(filter("List"), false);
});

test("minimal mode does not hide MCP business tools from ToolSearch activation", async () => {
  const conversationId = "conv-mcp-minimal";
  const registry = await buildMinimalRegistry({
    conversationId,
    getMcpSettings: () => ({
      selected: ["docs"],
      servers: [
        {
          id: "docs",
          enabled: true,
          transport: "stdio",
          command: "mock-mcp-server",
          args: [],
          url: "",
          env: {},
          headers: {},
          timeoutMs: 60_000,
        },
      ],
    }),
  });
  const deferred = deferredNames(registry);
  assert.ok(deferred.has("mcp_docs_search"));

  const filter = buildDeferredToolRequestFilter({
    conversationId,
    metadataByName: registry.metadataByName,
    deferredToolNames: registry.deferredToolNames ?? [],
  });
  assert.equal(filter("mcp_docs_search"), false);
  getMcpToolActivation(conversationId).add("mcp_docs_search");
  assert.equal(filter("mcp_docs_search"), true);
});

test("minimal mode plan registry keeps resident read-only tools plus ExitPlanMode", async () => {
  const registry = await buildMinimalRegistry({
    conversationId: "conv-plan-minimal",
    planMode: { conversationId: "conv-plan-minimal" },
  });
  const names = registry.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["ExitPlanMode", "Glob", "Grep", "Read"]);
  const exitPlanMode = registry.tools.find((tool) => tool.name === "ExitPlanMode");
  assert.match(exitPlanMode.description, /same minimal toolset/);
  assert.doesNotMatch(exitPlanMode.description, /full tools/);
});

test("minimal visible tool schema and compact suffix stay small", async () => {
  const conversationId = "conv-token-snapshot";
  const { registry } = await buildMinimalRegistryWithSubagents(conversationId);
  const visible = visibleTools(registry, conversationId);
  const schemaTokens = estimateTextTokens(serializeToolCatalog(visible));
  assert.ok(schemaTokens < 4000, `visible tool schema estimated ${schemaTokens} tokens`);

  const suffix = buildToolsSuffix(
    "/workspace",
    visible.map((tool) => tool.name),
    "linux",
    undefined,
    { compact: true },
  );
  const suffixTokens = estimateTextTokens(suffix);
  assert.ok(suffixTokens < 1000, `compact tool suffix estimated ${suffixTokens} tokens`);
});
