# tool/ — business tools for a deployed KVVI system

## Summary

The `tool/` group exposes **one deployed company's business data** to a model as model-facing tools. It is not a generic capability family like [`fs/`](../fs/README.md) or [`web/`](../web/README.md): its tools have no meaning outside a KVVI deployment, because every one of them is a call into that company's platform service under that employee's identity.

The single package here is [`kvvi-business/`](kvvi-business/README.md). It holds a narrow contract client and seven tools; the platform endpoints it calls, the identity rules it obeys, and the tools it deliberately does **not** register are documented in its own README rather than repeated here.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`kvvi-business/`](kvvi-business/README.md) | Model-facing record and workflow tools over the KVVI platform's `/api/v1`, signed with the session context the runtime already carries | registers into `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

- [KVVI business tools](../../docs/subsystems/kvvi-business-tools.md) — the identity path, the closed tool set, and the tools that are not registered.
- [Agent presets](../preset/README.md) — which composition mounts these tools (`kvvi-worker` only).

-----

<a id="dev-note"></a>
## Dev Note

**Why this is its own group.** Every other group answers "what capability family does this package implement?"; these packages answer "what does this deployment's business data look like to a model?" That question only has an answer inside a KVVI deployment, and the answer changes with the customer's contracts rather than with the harness. Keeping them in `core/` or `web/` would put a product's vocabulary into the harness's own capability map.
