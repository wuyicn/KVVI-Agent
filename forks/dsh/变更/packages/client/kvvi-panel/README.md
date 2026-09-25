# @deepseek-ai/dsh-client-kvvi-panel

KVVI's business panel for the DSH web client: one sidebar entry plus one overlay page.

## Model Experience

This package contributes browser presentation only; it adds no model-visible input, no
session event, and no prompt section. The overlay reads KVVI business data over HTTP
from the KVVI platform service, which is outside the session log by design: nothing it
displays reaches a model request, so nothing about it needs to be reconstructable from
the log.

## Contribution

Two upstream-declared `list` slots are filled, so both registrations append rather than
replace another plugin's occupant:

| Slot | Declared by | Contribution |
|---|---|---|
| `sidebar.footer.action` | `ui-sidebar` | the entry at the sidebar foot |
| `shell.overlay` | `ui-layout` | the panel itself |

The two occupy different slots, so neither can render the other. They communicate
through one namespaced DOM event (`kvvi-panel:open`) rather than a module-level mutable
shared by every consumer.

## Known Limitations and Deferred Work

- **The panel cannot reach the platform service yet.** The browser loads the DSH client
  from the platform process's port, while KVVI's platform service listens on a different
  origin (`7400`) and sends no CORS headers, so the direct `fetch` fails and the panel
  shows "连不上平台服务". The read has to be bridged: either the platform service serves
  the client's origin, or the fetch moves to the DSH host half and reaches the client
  through a cordis service. That decision belongs to the product, not to this package.
- **Contents are stubs.** The 待办, 我的系统, and 聚合口径 blocks state plainly that the
  platform has no endpoint for them yet; only 我的权限 has a real source. They are not
  placeholders that pretend to work.
- **Copy is inline rather than locale-owned.** `verify-client-ui-i18n` will reject the
  hardcoded strings; moving them into a typed dictionary is required before this ships.
