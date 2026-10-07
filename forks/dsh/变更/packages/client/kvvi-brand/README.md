# @deepseek-ai/dsh-client-kvvi-brand

KVVI's brand occupants for the DSH web shell: the company's own branding where the
platform has one, the product's own brand everywhere else.

## Model Experience

This package contributes browser presentation only; it adds no model-visible input, no session event, and no prompt section. Nothing it renders reaches a model request. It does make one browser request of its own — a `GET /api/v1/company/branding` against the platform, once per plugin activation — which never reaches the runtime or the model.

## Contribution

Five slots are filled, so every registration appends rather than replaces
another plugin's occupant:

| Slot | Declared by | With company branding | Without |
|---|---|---|---|
| `sidebar.brand.mark` | `ui-sidebar` | the company logo | the KVVI mark |
| `sidebar.brand.name` | `ui-sidebar` | the company name | the product name |
| `conversation.hero.brand.mark` | `ui-conversation` | the company logo | the KVVI mark |
| `conversation.hero.title` | `ui-conversation` | the company tagline | the owner's own headline |
| `conversation.hero.badge` | `ui-conversation` | nothing | the owner's own badge |

Upstream's `ui-brand-official` registers into the two sidebar slots but only when
`DSH_CLIENT_BUILD_PROFILE === 'official'`. KVVI's builds do not set that variable,
so those slots are free. The hero's headline and badge are hard-coded entries in
the conversation package's locale dictionary, and `ctx.locale.register` refuses a
duplicate (namespace, locale) pair, so a second package cannot retranslate them;
`ui-conversation` declares the two slots and this package fills them.

The five registrations are installed as one declaration-aware generator: each
waits on its own slot's declaration, so the set works whether this row activates
before or after the declarers, and the whole set withdraws when a declaration
collapses.

### One read, one store

`apply` creates one branding store handle and one live instance, and hands the
same handle to all five registrations. The framework's per-entry store instance
would give the sidebar its own copy of a fact the hero also reads, which is
exactly the disagreement a shared store prevents. A read failure renders the
built-in brand — the store keeps "the platform refused", "the network failed",
and "this company set nothing" as three different states, and the last of them is
a successful read rather than a failure.

### The product name

The name occupant reads `process.env.DSH_CLIENT_TITLE`, the build's product
identity, which already titles the browser document and the layout's product
header. It owns no product-name literal of its own: a second copy is a second
source, and the two drift. The hero copy comes from the conversation package's
dictionary for the same reason — those two occupants declare
`locale: 'conversation'` and translate the owner's entry rather than restating it.

## Known Limitations and Deferred Work

- **No icon pipeline.** The fallback mark is drawn in the component rather than
  loaded from an asset, so a deployment cannot swap it without shipping a fork; a
  favicon or manifest icon is not covered here at all. A company logo is loaded
  from the URL the platform stores, which the deployment therefore has to host.
- **A name-only company loses the hero badge.** The badge is a product identity
  statement rather than a field, so it disappears as soon as the company has
  stated anything; a company that set a name and a logo but no tagline keeps the
  owner's headline without the badge beside it. That combination is the one place
  the two rules visibly disagree.
- **The brand read is not retried.** A failure leaves the built-in brand on
  screen until the plugin reloads; there is no backoff or re-read on focus.

**Runtime invariant:** No companion is published. This package registers five
presentational occupants over one store and observes no relationship between them
that an independent observation could diverge from.
