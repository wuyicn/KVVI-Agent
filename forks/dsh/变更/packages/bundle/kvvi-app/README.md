# @deepseek-ai/dsh-kvvi-app

The KVVI application bundle: a thin patch layer stacked over `dsh-web-app` that mounts the packages the KVVI fork adds.

## Use this package

List it after `dsh-web-app` in a profile's `dsh.profile.bundles`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-kvvi-app"
      ]
    }
  }
}
```

## Understand the implementation

Bundles stack in `dsh.profile.bundles` order: `app-boot` applies each bundle's patch list over the previous one. This bundle therefore **adds** to the layers beneath it and never replaces them — KVVI keeps every row `dsh-base` and `dsh-web-app` mount.

That choice is deliberate. Copying `dsh-web-app`'s rows into a KVVI bundle would fork the Web composition: every upstream change would then need hand-porting, and the copies would drift silently. Stacking keeps KVVI's delta equal to what KVVI actually owns.

**Pruning is not how KVVI removes a capability.** Hiding an entry point is done by occupying the slot it renders into. Row deletion waits until the dependencies between upstream rows have been measured; before that, a removed row can fail silently rather than loudly.

## Model Experience

None. This package contributes no prompt text, no tool, and no model-visible value — it declares a patch layer, and every row it mounts is owned by the package that ships it.

## Known Limitations and Deferred Work

- **The bundle is currently one row.** KVVI's builder console and workbench plugins do not exist yet; they are added here as they are built.
- **The package name uses the upstream `@deepseek-ai/` scope.** The client package gates scan `packages/client/*`, so a foreign scope would let KVVI's packages skip validation. The scope should move to KVVI's own when the fork becomes a separate repository; it is a mechanical rename.

**Runtime invariant:** No companion is published. This package carries Loader rows and mounts other packages; the mounted packages own every runtime relationship, and it holds none of its own.
