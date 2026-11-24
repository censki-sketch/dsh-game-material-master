# Game Material Master · Codex adapter

This adapter exposes **one `game_material` tool** to Codex. It forwards calls to
the same DSH gateway used by the existing interface: references, jobs, rounds,
generation attempts, processing and exports remain in the original workflow.
It does not implement another material pipeline or include provider credentials.

## Run locally

1. Build and load the plugin from the `gpt` branch in DSH, following the project
   README. A host-side change requires a DSH restart; refreshing its page alone
   does not reload host modules. No restart or installation is performed by the
   adapter's verification script.
2. The running GPT host writes a discovery file at
   `<DSH_HOME>/game-material-master/gpt-bridge.json`; without `DSH_HOME`, this is
   `<user-home>/.dsh/game-material-master/gpt-bridge.json`, matching `src/config.ts`.
   The file contains the loopback bridge URL, a local bearer token and protocol
   version. Keep it local. An explicit discovery path can be selected with
   `DSH_GPT_BRIDGE_CONFIG`; the model never supplies URL or token arguments.
3. Install this repository folder as a local Codex plugin using its
   `.codex-plugin/plugin.json` compatibility manifest. `.mcp.json` starts
   `node ${PLUGIN_ROOT}/gpt-plugin/server.mjs`; it does not contain developer paths.
   This package does not edit global Codex settings or install itself.
4. Ask Codex to use Game Material Master. It first reads the workflow guide and
   current task state, then uses the existing methods and confirmation rules.

Node.js is required; the adapter uses only built-in modules and has no runtime packages.
The bridge must be on HTTP loopback (`127.0.0.1`, `localhost` or `[::1]`). Requests
have a 60-second transport timeout, bypass system HTTP proxies, and never follow
redirects or retry a POST.
A timeout is an unknown result: inspect the original task and operation record
before doing anything that might create another generation attempt.

Successful MCP calls return the original `result`, `operationId` and
`recordedAt`. The user can follow the original preview `openUrl` and job/round
IDs in DSH. Host operation metadata is recorded in `gpt-operations.jsonl`; its
tool-call duration measures the gateway call only, not the complete asynchronous
model-generation duration. Existing task logs remain the source for stages and
artifacts. The adapter does not mark a held output as approved.

The existing inline template contact sheet (`getMotionTemplatePreview`) is also
returned as a native MCP image attachment, so Codex can inspect its poses. Other
video and frame-sheet previews keep their original DSH links; the adapter does
not fetch arbitrary image URLs or read media paths from tool output.
For that inline preview only, text and structured results replace the data URI
with `{contentIndex: 1, mimeType}` and retain the other metadata. The image bytes
appear once in the referenced image block, avoiding duplicate base64 in context.

## Zero-cost verification

```sh
node scripts/verify-gpt-mcp.mjs
```

The test launches the real stdio server against an isolated local fake HTTP
bridge for protocol and failure checks, then the real host bridge and real
`registerStudioTools` dispatcher with a mock gateway. It verifies the original
schema, guide, workflow rounds, UI deep links, operation journal, confirmation
preservation, native preview image, Unicode, redirect refusal and duplicate
request suppression. All configuration and audit files stay in a temporary
directory. It does not read real bridge/provider configuration, start DSH,
call a model, alter user settings or generate billable assets.
