---
name: game-material-master
description: Use the local Game Material Master plugin to inspect, prepare, generate, review and export game artwork through its shared workflow and visible operation records. Use for existing DSH material tasks and new character actions, not unrelated coding or standalone images.
---

# Game Material Master for Codex

Use the single `game_material` tool. The DSH plugin owns task storage, action
templates, processing, previews and operation history; the GPT adapter only
connects to that same workflow. Do not create per-character or per-action scripts
to duplicate a capability already provided by the plugin.

1. Read `game_material({action:"guide",topic:"overview"})`, then the relevant
   module guide/method catalogue. Inspect existing tasks and saved assets before
   creating another task or asking for an input already present.
2. Reuse the selected task/round, original references, confirmed parameters and
   source hashes. Motion templates already exist: inspect their start/end poses,
   facing, canvas and valid time range before paying to generate. Idle, fighting
   guard and terminal death are different states; a successful file write does
   not prove that those transitions match.
3. Keep the user's prior authorization and original confirmation gates. Explain
   a paid request before its final submission when approval is missing; do not
   repeatedly ask for approval already granted. Never enable paid settings or
   mark visual approval on the user's behalf merely to advance a pipeline.
4. Submit once and retain the returned task/round/operation IDs. A timeout or
   unknown result is a query/recovery task, not permission to resubmit. Use the
   plugin's existing status/wait/resume methods. Never replay a paid stage to fix
   a missing preview or derived local file.
5. Use built-in processing and frame-range confirmation. Compare original RGB,
   matte and restored output; check facing, first/last poses, clipping, clothing,
   hair and required eye states. Changed backgrounds or failed motion stay held
   for review; do not hide defects by shrinking each frame or silently switching
   to another provider.
6. Return the plugin's preview `openUrl`, task/round IDs, adapter `operationId`,
   actual completed stages and remaining checks. These identify the same work
   visible in the DSH interface. Report elapsed preparation, model waiting and
   local processing separately when timing matters.

The local bridge connection is configured by the plugin, not by model arguments.
Do not read provider credentials, print bridge tokens, alter global Codex
settings or bypass a disabled module. If connection fails, report it and use
existing task records to reconcile any unknown operation.

Templates and verified settings make execution repeatable; model output,
provider availability and quality can still fail. Preserve the failure state,
logs and resume points rather than promising that one successful run guarantees
all future characters/actions.
