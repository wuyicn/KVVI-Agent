---
description: "提交发布的那一步：把搭建者工作区里的六份契约交给平台，形成一张待所有者审批的草案。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-kvvi-publish

English | 中文

## Summary

Use this package when a builder session must hand its own validated contracts to the platform without leaving the session. It registers one model tool, `publish_submit`, plus a `tools/pre-execute` gate that sends every call of that tool through the deployment's approval seam, so a human presses the confirmation button before the draft enters the publish channel. It submits only: approving and publishing stay with the owner (§9.6.1), and the platform re-judges both.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Model Experience](#model-experience)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it in a builder preset with the platform's URL and the shared runtime-context secret. Both fields are required and have no defaults: a default URL would point a builder at the wrong deployment, and a default secret would be a shared secret committed to a repository.

```yaml
- id: tool-kvvi-publish
  name: '@deepseek-ai/dsh-tool-kvvi-publish'
  config:
    platformUrl: !!js process.env.KVVI_PLATFORM_URL ?? 'http://127.0.0.1:7400'
    contextSecret: !!js process.env.KVVI_INTERNAL_TOKEN ?? ''
```

The tool takes the system code, an optional display name, and an optional workspace-relative contracts directory (default `契约`). It reads the six contracts, refuses when any is missing, and posts one draft. The workspace comes from the session (`session.header.cwd`) — the same source the file and shell tools use, so the tool and the builder's other tools always agree on which directory is being built.

For a new form started in Business, pass the supplied `buildIntentId` unchanged.
The platform validates its company, creator and draft, then groups the form only
after owner-approved publication. Existing-form edits omit this argument. A draft
receipt does not claim that publication or grouping has completed.

### Why the confirmation gate is part of this package

Submitting is not reversible from the builder's side: the draft enters the channel and the owner sees it. The gate returns `ask` for `publish_submit` and delegates every other tool unchanged. `ask` fails closed when no answerer is composed, so an unattended run cannot submit silently — which is the behavior this step needs. Scoping the gate to one tool is deliberate: a gate that covers everything teaches users to approve without reading.

<a id="understand-the-implementation"></a>
## Understand the implementation

The publish channel has two halves, and its own source names them:

| Step | Who | Where |
|---|---|---|
| Submit (with the contracts) | the builder | **this tool** (or the CLI scaffold) |
| Approve + publish | the owner | 企业管理 → 发布 |

The second half already existed. The first half did not: the builder's administration page cannot read the contracts (they live in the workspace, not in the browser), and the builder's tool set had no publish action — so the only working entry was the CLI scaffold, a terminal a builder does not open. The Agent's own skills said "publishing is yours to do in the workbench" while the workbench had no such button.

This package is the one place that satisfies both constraints at once: it runs inside the runtime, so it holds the workspace; and it submits under this session's `BUILDER` identity, so it cannot approve what it submits.

Contract binding follows `工具/发布脚手架.py`'s `read_contracts` exactly — one contract per type, `tool-spec` bound as `{tools: [...]}`, and every dropped file reported back in `notes`. Two bindings of one build would let the same workspace publish different content depending on which entry was used.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **The platform stores one contract per (type, system).** A real build has two views and seven tool files; whichever ones the binder drops are reported, not carried. Resolving this needs a storage shape decision in the platform, not a change here.
- **No dry run.** The tool submits or fails; there is no "show me the diff first" argument. The confirmation panel shows the reason, not the derived diff — an approver-facing diff exists only after submission.
- **No submit for a partial system.** All six contracts must be present; a builder working on one of them has no way to send it alone.

<a id="model-experience"></a>
## Model Experience

The model gets one tool, `publish_submit`, whose description states that it submits but does not approve, and that the user must be told what will be sent before it is called. On success it sees the draft id, its status, whether an open draft for the same change was reused, the platform's change summary, and the binder's notes about what it dropped; on refusal it sees the platform's own code, never a paraphrase.

## Dev Note

The wire client is a second implementation of the runtime-context signature that `kvvi-business` also carries. Merging the two packages would be cheaper, but it would hand the builder the employee's data tools; the two signatures are instead held together by a shared set of test vectors in each package.
