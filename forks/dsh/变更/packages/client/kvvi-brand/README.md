# @deepseek-ai/dsh-client-kvvi-brand

KVVI's brand occupants for the DSH web shell.

## Model Experience

This package contributes browser presentation only; it adds no model-visible input, no session event, and no prompt section. Nothing it renders reaches a model request.

## Contribution

Two upstream-declared slots are filled, so both registrations append rather than replace another plugin's occupant:

| Slot | Declared by | Contribution |
|---|---|---|
| `sidebar.brand.mark` | `ui-sidebar` | the KVVI mark |
| `sidebar.brand.name` | `ui-sidebar` | the product name |

Upstream's `ui-brand-official` registers into the same slots but only when `DSH_CLIENT_BUILD_PROFILE === 'official'`. KVVI's builds do not set that variable, so the slots are free and no upstream source file needed editing — a source edit would conflict on every upstream change, while a second occupant of an extension point does not.

## Known Limitations and Deferred Work

- **The name is not locale-owned.** The product name is a proper noun and stays verbatim, which the i18n rule permits, but neither occupant takes copy from a dictionary — so a deployment that wants a different display name must change this package rather than its locale files.
- **No icon pipeline.** The mark is drawn in the component rather than loaded from an asset, so a deployment cannot swap it without shipping a fork; a favicon or manifest icon is not covered here at all.

**Runtime invariant:** No companion is published. This package registers two presentational occupants and observes no relationship between them.
