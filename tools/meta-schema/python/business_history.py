"""Static compatibility classification; never executes migrations or scans data."""

from diagnostics import diagnostic, sorted_unique
from values import fits_decimal


def validate_history(spec, context, prefix):
    history = context.get("business", {}).get("history")
    if not history:
        return []  # Task4 must establish which historical baseline applies.
    old = history["previous_spec"]
    errors = []

    def add(code, path):
        errors.append(
            diagnostic(code, (prefix + "." if prefix and prefix != "$" else "") + path)
        )

    if spec["schema_code"] != old["schema_code"]:
        add("SCHEMA_CODE_INVALID", "schema_code")
    before = {f["field_code"]: f for f in old["fields"]}
    after = {f["field_code"]: f for f in spec["fields"]}
    # A logical omission is not proof of physical deletion or a renamed identity.
    removed = set(before) - set(after)
    identity_changes = history.get("field_identity_changes", [])
    renamed = {
        item["previous_code"]: item["current_code"]
        for item in identity_changes
        if item["previous_code"] in removed and item["current_code"] in after
    }
    if removed & set(history.get("used_fields", [])):
        add("BREAKING_CHANGE_FORBIDDEN", "fields")
    elif removed - set(renamed):
        add("MIGRATION_REQUIRED", "fields")
    deleted = set(history.get("deleted_field_codes", []))
    for i, f in enumerate(spec["fields"]):
        p = f"fields[{i}]"
        code = f["field_code"]
        prior = before.get(code)
        if code in deleted or code in renamed.values():
            add("FIELD_CODE_INVALID", p + ".field_code")
        if prior is None:
            if f["required"]:
                add("MIGRATION_REQUIRED", p)
            continue
        if f["type"] != prior["type"]:
            add("BREAKING_CHANGE_FORBIDDEN", p + ".type")
            continue
        needs_migration = False
        breaking = False
        for key in ("required", "nullable", "write_policy"):
            if f[key] != prior[key]:
                needs_migration = True
        if ("default" in f) != ("default" in prior) or f.get("default") != prior.get(
            "default"
        ):
            needs_migration = True
        kind = f["type"]
        oldlim = prior.get("constraints", {})
        newlim = f.get("constraints", {})
        oldcfg = prior.get("type_config", {})
        newcfg = f.get("type_config", {})
        samples = history.get("value_samples", {}).get(code, [])
        if kind in ("short_text", "long_text"):
            default = 255 if kind == "short_text" else 5000
            maximum = newlim.get("max_length", default)
            if maximum < oldlim.get("max_length", default):
                needs_migration = True
                breaking = any(isinstance(v, str) and len(v) > maximum for v in samples)
        if kind == "decimal":
            oldps = (oldcfg.get("precision", 18), oldcfg.get("scale", 2))
            newps = (newcfg.get("precision", 18), newcfg.get("scale", 2))
            if oldps != newps:
                needs_migration = True
                breaking = any(
                    v is not None and not fits_decimal(v, *newps) for v in samples
                )
        if kind == "money" and oldcfg != newcfg:
            breaking = True
        if kind in ("single_select", "multi_select"):
            oldopts = {v["code"] for v in oldcfg["options"]}
            newopts = {v["code"] for v in newcfg["options"]}
            removed = oldopts - newopts
            if removed & set(history.get("used_options", {}).get(code, [])):
                add("BREAKING_CHANGE_FORBIDDEN", p + ".type_config.options")
            elif removed:
                needs_migration = True
        # Constraint changes beyond proven compatible expansion need an impact plan.
        for key in set(oldlim) | set(newlim):
            if (
                kind == "short_text"
                and key == "min_length"
                and oldlim.get(key, 0) == newlim.get(key, 0)
            ):
                continue
            if key == "max_length" and kind in ("short_text", "long_text"):
                continue
            if (
                kind == "multi_select"
                and key == "max_items"
                and oldlim.get(key, 20) == newlim.get(key, 20)
            ):
                continue
            if (
                kind == "short_text"
                and key == "trim"
                and oldlim.get(key, False) == newlim.get(key, False)
            ):
                continue
            if oldlim.get(key) != newlim.get(key):
                needs_migration = True
        if breaking:
            add("BREAKING_CHANGE_FORBIDDEN", p)
        elif needs_migration:
            add("MIGRATION_REQUIRED", p)
    oldindexes = {i["index_code"]: i for i in old.get("indexes", [])}
    for i, index in enumerate(spec.get("indexes", [])):
        if index["kind"] == "UNIQUE" and oldindexes.get(index["index_code"]) != index:
            add("MIGRATION_REQUIRED", f"indexes[{i}]")
    return sorted_unique(errors)
