"""Independently authored Business inputs and literal expected diagnostics.

No implementation module is imported here. Builders construct inputs only.
"""

from copy import deepcopy

TYPES = (
    "short_text",
    "long_text",
    "boolean",
    "integer",
    "decimal",
    "money",
    "date",
    "datetime",
    "single_select",
    "multi_select",
)
REF = dict(
    scope_type="PLATFORM_CONTROL",
    scope_id="kvvi-platform",
    app_id=None,
    module_id=None,
    asset_type="FIELD_TYPE_REGISTRY",
    asset_id="fake-business-types",
    version=1,
    digest="sha256:" + "a" * 64,
)
CONTEXT = dict(
    fixture=True,
    suite_revision="0a-core-r1",
    business={
        "enabled_types": list(TYPES),
        "generators": [],
        "index_capabilities": {
            kind: (
                []
                if kind == "multi_select"
                else ["NORMAL"] if kind == "long_text" else ["NORMAL", "UNIQUE"]
            )
            for kind in TYPES
        },
        "money_rules": {
            "CNY": {"precision": 38, "scale": 2},
            "JPY": {"precision": 38, "scale": 0},
        },
        "history": None,
    },
)


def option(code="one", enabled=True):
    return dict(code=code, label="相同标签", order=0, enabled=enabled)


def field(kind="short_text", code="title", **extra):
    value = dict(
        field_code=code,
        label="字段",
        type=kind,
        required=False,
        nullable=True,
        write_policy="MUTABLE",
        query=dict(searchable=False, filterable=False, sortable=False),
    )
    if kind == "money":
        value["type_config"] = dict(currency_mode="FIXED", currency="CNY")
    if kind in ("single_select", "multi_select"):
        value["type_config"] = dict(options=[option()])
    value.update(extra)
    return value


def business(fields=None, **extra):
    value = dict(
        schema_code="general_item",
        name="通用事项",
        field_type_registry_ref=deepcopy(REF),
        fields=fields or [field()],
    )
    value.update(extra)
    return value


def section(code="basic", items=None, columns=2):
    return dict(
        section_code=code,
        title="基本",
        columns=columns,
        items=(
            items
            if items is not None
            else [dict(kind="field", field_code="title", col_span=1)]
        ),
    )


def leaf(code="title", operator="not_empty", **extra):
    return dict(field=code, operator=operator, **extra)


def rule(expr=None, **extra):
    return dict(
        rule_code="rule_one", message="请检查", **{"assert": expr or leaf()}, **extra
    )


def cases():
    result = []

    def add(name, value, expected=(), stage="semantic", context=None, group="B05"):
        result.append(
            dict(
                id=name,
                spec=value,
                expected=list(expected),
                stage=stage,
                context=deepcopy(CONTEXT if context is None else context),
                group=group,
            )
        )

    def bad(name, value, path, code="CONSTRAINT_INCOMPATIBLE", **kw):
        add(name, value, [(code, path)], **kw)

    defaults = [
        "汉😀",
        "长文",
        True,
        9007199254740991,
        "12.50",
        {"amount": "12.50", "currency": "CNY"},
        "2024-02-29",
        "2024-02-29T23:59:59.123+08:00",
        "one",
        ["one"],
    ]
    invalid = [1, False, 0, "1", 1, {"amount": 1, "currency": "CNY"}, 1, 1, [], "one"]
    for kind, good, wrong in zip(TYPES, defaults, invalid):
        add(
            "type-" + kind,
            business([field(kind, default=good)]),
            stage="structure",
            group="B14",
        )
        add("default-" + kind, business([field(kind, default=good)]))
        bad(
            "wrong-default-" + kind,
            business([field(kind, default=wrong)]),
            "fields[0].default",
            stage="structure",
        )
        for location in ("constraints", "type_config"):
            f = field(kind)
            f.setdefault(location, {})["unregistered"] = True
            bad(
                "unknown-" + kind + "-" + location,
                business([f]),
                "fields[0]." + location + ".unregistered",
                "UNKNOWN_PROPERTY",
                stage="structure",
                group="B14",
            )
        add("null-" + kind, business([field(kind, default=None)]))
        bad(
            "null-forbidden-" + kind,
            business([field(kind, nullable=False, default=None)]),
            "fields[0].default",
        )
    for length in (3, 64):
        add(
            "schema-code-" + str(length),
            business(schema_code="a" * length),
            stage="structure",
            group="B01",
        )
    for length in (2, 65):
        bad(
            "schema-code-" + str(length),
            business(schema_code="a" * length),
            "schema_code",
            "SCHEMA_CODE_INVALID",
            stage="structure",
            group="B01",
        )
        bad(
            "field-code-" + str(length),
            business([field(code="a" * length)]),
            "fields[0].field_code",
            "FIELD_CODE_INVALID",
            stage="structure",
            group="B04",
        )
    for prop, good, over in [("name", 80, 81), ("description", 500, 501)]:
        add(
            "root-" + prop + "-max",
            business(**{prop: "😀" * good}),
            stage="structure",
            group="B01",
        )
        bad(
            "root-" + prop + "-over",
            business(**{prop: "😀" * over}),
            prop,
            "CONTRACT_SHAPE_INVALID",
            stage="structure",
            group="B01",
        )
    for prop, good, over in [("label", 80, 81), ("description", 300, 301)]:
        add(
            "field-" + prop + "-max",
            business([field(**{prop: "😀" * good})]),
            stage="structure",
        )
        bad(
            "field-" + prop + "-over",
            business([field(**{prop: "😀" * over})]),
            "fields[0]." + prop,
            "CONTRACT_SHAPE_INVALID",
            stage="structure",
        )
    for key in ("searchable", "filterable", "sortable"):
        f = field()
        del f["query"][key]
        bad(
            "query-missing-" + key,
            business([f]),
            "fields[0].query." + key,
            "CONTRACT_SHAPE_INVALID",
            stage="structure",
        )
    for key in ("schema_code", "field_type_registry_ref", "name", "fields"):
        s = business()
        del s[key]
        bad(
            "root-missing-" + key,
            s,
            key,
            "CONTRACT_SHAPE_INVALID",
            stage="structure",
            group="B01",
        )
    for prop, rows, limit in [
        ("fields", [field(code="f_" + str(i)) for i in range(101)], 100),
        (
            "indexes",
            [
                dict(index_code="idx_" + str(i), kind="NORMAL", fields=["title"])
                for i in range(21)
            ],
            20,
        ),
        ("record_rules", [rule(rule_code_unused=True) for i in range(51)], 50),
    ]:
        if prop == "record_rules":
            rows = [
                dict(rule_code="rule_" + str(i), message="检查", **{"assert": leaf()})
                for i in range(51)
            ]
        add(
            prop + "-limit",
            business(**{prop: rows[:limit]}),
            stage="structure",
            group="B02",
        )
        bad(
            prop + "-over",
            business(**{prop: rows}),
            prop,
            "CONTRACT_SHAPE_INVALID",
            stage="structure",
            group="B02",
        )
    s = business()
    s["fields"] = []
    bad(
        "fields-empty",
        s,
        "fields",
        "CONTRACT_SHAPE_INVALID",
        stage="structure",
        group="B02",
    )
    bad("required-nullable", business([field(required=True)]), "fields[0].nullable")
    bad(
        "system-unbound",
        business([field(write_policy="SYSTEM")]),
        "fields[0].write_policy",
    )
    c = deepcopy(CONTEXT)
    c["business"]["generators"] = [
        {"schema_code": "general_item", "field_code": "title", "type": "short_text"}
    ]
    add("system-bound", business([field(write_policy="SYSTEM")]), context=c)
    for name in [
        "id",
        "tenant_id",
        "form_code",
        "schema_version",
        "status",
        "owner_id",
        "created_by",
        "updated_by",
        "created_at",
        "updated_at",
        "data",
        "record_no",
    ]:
        bad(
            "reserved-" + name,
            business([field(code=name)]),
            "fields[0].field_code",
            "FIELD_CODE_INVALID",
            group="B04",
        )
    add(
        "prototype-legal",
        business([field(code="constructor"), field(code="prototype")]),
        group="B04",
    )
    bad(
        "duplicate-field",
        business([field(), field(label="不同")]),
        "fields[1].field_code",
        "FIELD_CODE_DUPLICATE",
        group="B04",
    )
    add(
        "duplicate-label-valid",
        business([field(code="aaa"), field(code="bbb")]),
        group="B04",
    )
    for name in ["file", "subtable", "single_relation"]:
        bad(
            "type-disabled-" + name,
            business([field(name)]),
            "fields[0].type",
            "FIELD_TYPE_UNREGISTERED",
            stage="structure",
            group="B17",
        )
    for kind, good, badlength in [
        ("short_text", 255, 256),
        ("long_text", 20000, 20001),
    ]:
        for n in (1, good):
            add(
                kind + "-length-" + str(n),
                business([field(kind, constraints={"max_length": n})]),
                stage="structure",
            )
        for n in (0, badlength):
            bad(
                kind + "-length-" + str(n),
                business([field(kind, constraints={"max_length": n})]),
                "fields[0].constraints.max_length",
                stage="structure",
            )
    bad(
        "text-min-max",
        business([field(constraints={"min_length": 3, "max_length": 2})]),
        "fields[0].constraints",
    )
    add(
        "unicode-length-two",
        business([field(default="😀汉", constraints={"max_length": 2})]),
    )
    bad(
        "unicode-length-over",
        business([field(default="😀汉a", constraints={"max_length": 2})]),
        "fields[0].default",
    )
    bad(
        "long-default-over-effective",
        business([field("long_text", default="a" * 5001)]),
        "fields[0].default",
    )
    for pattern in [
        "(a+)+$",
        "a|b",
        "(?<=a)b",
        r"(a)\1",
        "a++",
        "a{2,1}",
        "[z-a]",
        "a" * 201,
    ]:
        bad(
            "pattern-invalid-" + str(len(result)),
            business([field(constraints={"pattern": pattern})]),
            "fields[0].constraints.pattern",
        )
    for pattern, value in [
        ("^[A-Z][a-z]{1,3}$", "Abc"),
        (r"^\d+\s\w?$", "12 a"),
        ("a.*z", "xxabzxx"),
        ("^a{2}$", "aa"),
    ]:
        add(
            "pattern-good-" + str(len(result)),
            business([field(default=value, constraints={"pattern": pattern})]),
        )
    bad(
        "pattern-nomatch",
        business([field(default="aa", constraints={"pattern": "^a$"})]),
        "fields[0].default",
    )
    bad(
        "integer-reverse",
        business([field("integer", constraints={"minimum": 2, "maximum": 1})]),
        "fields[0].constraints",
    )
    bad(
        "integer-range",
        business([field("integer", default=0, constraints={"minimum": 1})]),
        "fields[0].default",
    )
    for val in ["+1", "01", "1e2", "1.", "-.2"]:
        bad(
            "decimal-lexical-" + str(len(result)),
            business([field("decimal", default=val)]),
            "fields[0].default",
            stage="structure",
        )
    for cfg in [{"precision": 39}, {"scale": 13}, {"precision": 0}]:
        key = next(iter(cfg))
        bad(
            "decimal-config-" + str(len(result)),
            business([field("decimal", type_config=cfg)]),
            "fields[0].type_config." + key,
            stage="structure",
        )
    bad(
        "decimal-scale-precision",
        business([field("decimal", type_config={"precision": 1})]),
        "fields[0].type_config",
    )
    add(
        "decimal-38-digits",
        business(
            [
                field(
                    "decimal",
                    default="123456789012345678901234567890123456.12",
                    type_config={"precision": 38, "scale": 2},
                )
            ]
        ),
    )
    bad(
        "decimal-39-digits",
        business(
            [
                field(
                    "decimal",
                    default="1234567890123456789012345678901234567.12",
                    type_config={"precision": 38, "scale": 2},
                )
            ]
        ),
        "fields[0].default",
    )
    bad(
        "decimal-lexical-trap",
        business(
            [
                field(
                    "decimal",
                    default="10.00",
                    constraints={"minimum": "2.00", "maximum": "9.00"},
                )
            ]
        ),
        "fields[0].default",
    )
    bad(
        "decimal-bounds-reverse",
        business(
            [field("decimal", constraints={"minimum": "10.00", "maximum": "2.00"})]
        ),
        "fields[0].constraints",
    )
    bad(
        "decimal-fraction-over",
        business([field("decimal", default="1.000")]),
        "fields[0].default",
    )
    for val in [
        {"amount": "10.00", "currency": "USD"},
        {"amount": "1.001", "currency": "CNY"},
    ]:
        bad(
            "money-invalid-" + str(len(result)),
            business([field("money", default=val)]),
            "fields[0].default",
        )
    bad(
        "money-range",
        business(
            [
                field(
                    "money",
                    default={"amount": "10.00", "currency": "CNY"},
                    constraints={"maximum": "9.00"},
                )
            ]
        ),
        "fields[0].default",
    )
    c = deepcopy(CONTEXT)
    c["business"]["money_rules"] = {}
    bad(
        "money-no-rule",
        business([field("money")]),
        "fields[0].type_config",
        "DEPENDENCY_VALIDATOR_UNAVAILABLE",
        context=c,
    )
    for val in ["2023-02-29", "2024-02-30", "0000-01-01", "2024-13-01"]:
        bad(
            "date-invalid-" + val,
            business([field("date", default=val)]),
            "fields[0].default",
        )
    bad(
        "date-bounds-reverse",
        business(
            [
                field(
                    "date",
                    constraints={"minimum": "2025-01-01", "maximum": "2024-01-01"},
                )
            ]
        ),
        "fields[0].constraints",
    )
    bad(
        "date-range",
        business(
            [field("date", default="2023-01-01", constraints={"minimum": "2024-01-01"})]
        ),
        "fields[0].default",
    )
    for val in [
        "2024-02-29T12:00:00",
        "2024-02-29T12:00:60Z",
        "2024-02-29T24:00:00Z",
        "2023-02-29T12:00:00Z",
        "2024-02-29T12:00:00+24:00",
    ]:
        bad(
            "datetime-invalid-" + str(len(result)),
            business([field("datetime", default=val)]),
            "fields[0].default",
        )
    for n in (1, 200):
        add(
            "options-" + str(n),
            business(
                [
                    field(
                        "single_select",
                        type_config={"options": [option(str(i)) for i in range(n)]},
                    )
                ]
            ),
            stage="structure",
        )
    for n in (0, 201):
        bad(
            "options-" + str(n),
            business(
                [
                    field(
                        "single_select",
                        type_config={"options": [option(str(i)) for i in range(n)]},
                    )
                ]
            ),
            "fields[0].type_config.options",
            stage="structure",
        )
    bad(
        "options-duplicate",
        business(
            [field("single_select", type_config={"options": [option(), option()]})]
        ),
        "fields[0].type_config.options[1].code",
    )
    for kind, value in [
        ("single_select", "missing"),
        ("multi_select", ["missing"]),
        ("multi_select", ["one", "one"]),
    ]:
        bad(
            "options-default-" + str(len(result)),
            business([field(kind, default=value)]),
            "fields[0].default",
        )
    bad(
        "options-disabled",
        business(
            [
                field(
                    "single_select",
                    default="one",
                    type_config={"options": [option(enabled=False)]},
                )
            ]
        ),
        "fields[0].default",
    )
    for n in (1, 50):
        add(
            "multi-limit-" + str(n),
            business([field("multi_select", constraints={"max_items": n})]),
            stage="structure",
        )
    bad(
        "multi-limit-51",
        business([field("multi_select", constraints={"max_items": 51})]),
        "fields[0].constraints.max_items",
        stage="structure",
    )
    opts = [option(str(i)) for i in range(21)]
    bad(
        "multi-default-21",
        business(
            [
                field(
                    "multi_select",
                    default=[str(i) for i in range(21)],
                    type_config={"options": opts},
                )
            ]
        ),
        "fields[0].default",
    )
    for kind in ("integer", "boolean", "decimal", "money", "date", "datetime"):
        f = field(kind)
        f["query"]["searchable"] = True
        bad("search-" + kind, business([f]), "fields[0].query.searchable", group="B20")
    for kind in ("long_text", "multi_select"):
        f = field(kind)
        f["query"]["sortable"] = True
        bad("sort-" + kind, business([f]), "fields[0].query.sortable", group="B20")
    for n in (20, 21):
        s = business(
            layout={"sections": [section("sec_" + str(i), items=[]) for i in range(n)]}
        )
        if n == 20:
            add("sections-20", s, stage="structure", group="B15")
        else:
            bad(
                "sections-21",
                s,
                "layout.sections",
                "CONTRACT_SHAPE_INVALID",
                stage="structure",
                group="B15",
            )
    add(
        "layout-platform",
        business(
            layout={
                "sections": [
                    section(items=[dict(kind="field", field_code="status", col_span=1)])
                ]
            }
        ),
        group="B15",
    )
    for name, items, path in [
        (
            "unknown",
            [dict(kind="field", field_code="missing", col_span=1)],
            "layout.sections[0].items[0].field_code",
        ),
        (
            "span",
            [dict(kind="field", field_code="title", col_span=3)],
            "layout.sections[0].items[0].col_span",
        ),
        (
            "repeat",
            [dict(kind="field", field_code="title", col_span=1)] * 2,
            "layout.sections[0].items[1].field_code",
        ),
    ]:
        bad(
            "layout-" + name,
            business(layout={"sections": [section(items=items)]}),
            path,
            group="B15",
        )
    for n in (4, 5):
        s = business(
            [field(code="f_" + str(i)) for i in range(n)],
            indexes=[
                dict(
                    index_code="idx_one",
                    kind="NORMAL",
                    fields=["f_" + str(i) for i in range(n)],
                )
            ],
        )
        if n == 4:
            add("index-fields-4", s, stage="structure", group="B21")
        else:
            bad(
                "index-fields-5",
                s,
                "indexes[0].fields",
                "CONTRACT_SHAPE_INVALID",
                stage="structure",
                group="B21",
            )
    for codes, path in [
        (["title", "title"], "indexes[0].fields[1]"),
        (["missing"], "indexes[0].fields[0]"),
        (["constructor"], "indexes[0].fields[0]"),
    ]:
        bad(
            "index-invalid-" + str(len(result)),
            business(indexes=[dict(index_code="idx_one", kind="NORMAL", fields=codes)]),
            path,
            group="B21",
        )
    bad(
        "long-unique",
        business(
            [field("long_text")],
            indexes=[dict(index_code="idx_one", kind="UNIQUE", fields=["title"])],
        ),
        "indexes[0].fields[0]",
        group="B21",
    )
    add("rule-simple", business(record_rules=[rule()]), group="B18")
    add(
        "rule-20",
        business(
            record_rules=[rule({"all": [leaf()] * 10}, when={"any": [leaf()] * 10})]
        ),
        group="B19",
    )
    bad(
        "rule-21",
        business(
            record_rules=[rule({"all": [leaf()] * 11}, when={"any": [leaf()] * 10})]
        ),
        "record_rules[0]",
        group="B19",
    )
    add(
        "rule-depth-3",
        business(record_rules=[rule({"not": {"not": leaf()}})]),
        group="B19",
    )
    bad(
        "rule-depth-4",
        business(record_rules=[rule({"not": {"not": {"not": leaf()}}})]),
        "record_rules[0].assert",
        group="B19",
    )
    for expr in [
        {"all": []},
        dict(all=[leaf()], any=[leaf()]),
        leaf(operator="execute", value="secret"),
        leaf(value="not-allowed"),
    ]:
        bad(
            "rule-shape-" + str(len(result)),
            business(record_rules=[rule(expr)]),
            "record_rules[0].assert",
            "ARBITRARY_EXPRESSION_FORBIDDEN",
            stage="structure",
            group="B18",
        )
    for kind, op, val in [
        ("short_text", "eq", 1),
        ("integer", "gt", "2"),
        ("boolean", "gt", 1),
        ("multi_select", "eq", "one"),
        ("date", "eq", {"amount": "1", "currency": "CNY"}),
        ("single_select", "in", "one"),
    ]:
        bad(
            "rule-typed-" + str(len(result)),
            business([field(kind)], record_rules=[rule(leaf(operator=op, value=val))]),
            "record_rules[0].assert",
            group="B19",
        )
    add(
        "rule-array-equality",
        business(
            [field("multi_select")],
            record_rules=[rule(leaf(operator="eq", value=["one"]))],
        ),
        group="B19",
    )
    add(
        "rule-scalar-in",
        business(
            [field("integer")], record_rules=[rule(leaf(operator="in", value=[1, 2]))]
        ),
        group="B19",
    )
    bad(
        "rule-unknown-constructor",
        business(record_rules=[rule(leaf("constructor"))]),
        "record_rules[0].assert.field",
        group="B19",
    )
    for key in ["evil\nkey", "evil\tkey", "evil\x00key"]:
        s = business()
        s[key] = True
        literal = {
            "evil\nkey": '["evil\\nkey"]',
            "evil\tkey": '["evil\\tkey"]',
            "evil\x00key": '["evil\\u0000key"]',
        }[key]
        bad(
            "unknown-control-" + str(len(result)),
            s,
            literal,
            "UNKNOWN_PROPERTY",
            stage="structure",
            group="B01",
        )
    previous = business()

    def history_context(old=previous, **extra):
        c = deepcopy(CONTEXT)
        c["business"]["history"] = dict(
            previous_spec=deepcopy(old),
            used_fields=[],
            used_options={},
            deleted_field_codes=[],
            value_samples={},
            **extra
        )
        return c

    for name, changes in [
        ("label", {"label": "新标签"}),
        ("description", {"description": "说明"}),
        ("deprecated", {"deprecated": True}),
    ]:
        add(
            "history-compatible-" + name,
            business([field(**changes)]),
            context=history_context(),
            group="B22",
        )
    add(
        "history-optional-added",
        business([field(), field(code="added")]),
        context=history_context(),
        group="B22",
    )
    add(
        "history-layout",
        business(layout={"sections": []}),
        context=history_context(),
        group="B22",
    )
    add(
        "history-normal-index",
        business(indexes=[dict(index_code="idx_one", kind="NORMAL", fields=["title"])]),
        context=history_context(),
        group="B22",
    )
    bad(
        "history-schema-renamed",
        business(schema_code="renamed"),
        "schema_code",
        "SCHEMA_CODE_INVALID",
        context=history_context(),
        group="B22",
    )
    bad(
        "history-field-removal-unused",
        business([field(code="renamed")]),
        "fields",
        "MIGRATION_REQUIRED",
        context=history_context(),
        group="B22",
    )
    for state in ("used", "unknown"):
        c = history_context()
        if state == "used":
            c["business"]["history"]["used_fields"] = ["title"]
        else:
            del c["business"]["history"]["used_fields"]
        bad(
            "history-field-removal-" + state,
            business([field(code="other")]),
            "fields",
            "BREAKING_CHANGE_FORBIDDEN" if state == "used" else "MIGRATION_REQUIRED",
            context=c,
            group="B22",
        )
    c = history_context()
    c["business"]["history"]["field_identity_changes"] = [
        {"previous_code": "title", "current_code": "renamed"}
    ]
    bad(
        "history-field-known-rename",
        business([field(code="renamed")]),
        "fields[0].field_code",
        "FIELD_CODE_INVALID",
        context=c,
        group="B22",
    )
    c = history_context()
    c["business"]["history"]["deleted_field_codes"] = ["reused"]
    bad(
        "history-field-reused",
        business([field(), field(code="reused")]),
        "fields[1].field_code",
        "FIELD_CODE_INVALID",
        context=c,
        group="B22",
    )
    for name, changes in [
        ("required", {"required": True, "nullable": False}),
        ("nullable", {"nullable": False}),
        ("default", {"default": "new"}),
        ("create-only", {"write_policy": "CREATE_ONLY"}),
    ]:
        bad(
            "history-migration-" + name,
            business([field(**changes)]),
            "fields[0]",
            "MIGRATION_REQUIRED",
            context=history_context(),
            group="B22",
        )
    bad(
        "history-type-changed",
        business([field("long_text")]),
        "fields[0].type",
        "BREAKING_CHANGE_FORBIDDEN",
        context=history_context(),
        group="B22",
    )
    bad(
        "history-required-added",
        business(
            [field(), field(code="added", required=True, nullable=False, default="a")]
        ),
        "fields[1]",
        "MIGRATION_REQUIRED",
        context=history_context(),
        group="B22",
    )
    bad(
        "history-unique-index",
        business(indexes=[dict(index_code="idx_one", kind="UNIQUE", fields=["title"])]),
        "indexes[0]",
        "MIGRATION_REQUIRED",
        context=history_context(),
        group="B22",
    )
    for kind, old, new, witness in [
        ("short_text", {}, {"constraints": {"max_length": 2}}, "abc"),
        (
            "decimal",
            {"type_config": {"precision": 8, "scale": 2}},
            {"type_config": {"precision": 4, "scale": 2}},
            "123.00",
        ),
    ]:
        c = history_context(business([field(kind, **old)]))
        bad(
            "history-shrink-unproven-" + kind,
            business([field(kind, **new)]),
            "fields[0]",
            "MIGRATION_REQUIRED",
            context=c,
            group="B22",
        )
        c["business"]["history"]["value_samples"] = {"title": [witness]}
        bad(
            "history-shrink-truncates-" + kind,
            business([field(kind, **new)]),
            "fields[0]",
            "BREAKING_CHANGE_FORBIDDEN",
            context=c,
            group="B22",
        )
    c = history_context(business([field("decimal")]))
    add(
        "history-effective-decimal-unchanged",
        business([field("decimal", type_config={"precision": 18, "scale": 2})]),
        context=c,
        group="B22",
    )
    bad(
        "history-decimal-expand",
        business([field("decimal", type_config={"precision": 20, "scale": 2})]),
        "fields[0]",
        "MIGRATION_REQUIRED",
        context=c,
        group="B22",
    )
    old = business([field("single_select")])
    c = history_context(old)
    add(
        "history-option-added",
        business(
            [field("single_select", type_config={"options": [option(), option("two")]})]
        ),
        context=c,
        group="B22",
    )
    add(
        "history-option-disable",
        business(
            [field("single_select", type_config={"options": [option(enabled=False)]})]
        ),
        context=c,
        group="B22",
    )
    c["business"]["history"]["used_options"] = {"title": ["one"]}
    bad(
        "history-used-option-delete",
        business([field("single_select", type_config={"options": [option("two")]})]),
        "fields[0].type_config.options",
        "BREAKING_CHANGE_FORBIDDEN",
        context=c,
        group="B22",
    )
    for kind, value in [("single_select", "one"), ("multi_select", ["one"])]:
        s = business(
            [field(kind, type_config={"options": [option(enabled=False)]})],
            record_rules=[rule(leaf(operator="eq", value=value))],
        )
        add("rule-disabled-readable-" + kind, s, group="B19")
    # Each closed object gets a real engine unknown-key assertion.
    locations = [
        ("fields[0]", lambda s: s["fields"][0]),
        ("fields[0].query", lambda s: s["fields"][0]["query"]),
        (
            "fields[0].type_config.options[0]",
            lambda s: s["fields"][0]["type_config"]["options"][0],
        ),
        ("indexes[0]", lambda s: s["indexes"][0]),
        ("layout", lambda s: s["layout"]),
        ("layout.sections[0]", lambda s: s["layout"]["sections"][0]),
        (
            "layout.sections[0].items[0]",
            lambda s: s["layout"]["sections"][0]["items"][0],
        ),
        ("record_number", lambda s: s["record_number"]),
        ("record_rules[0]", lambda s: s["record_rules"][0]),
    ]
    numbered = deepcopy(REF)
    numbered["asset_type"] = "SEQUENCE_POLICY"
    for location, get in locations:
        s = business(
            [field("single_select")],
            indexes=[dict(index_code="idx_one", kind="NORMAL", fields=["title"])],
            layout={"sections": [section()]},
            record_rules=[rule()],
            record_number=dict(
                field_code="record_no", label="编号", sequence_policy_ref=numbered
            ),
        )
        get(s)["unregistered"] = True
        bad(
            "closed-" + location,
            s,
            location + ".unregistered",
            "UNKNOWN_PROPERTY",
            stage="structure",
            group="B14",
        )
    bad(
        "money-unknown-default",
        business(
            [
                field(
                    "money",
                    default=dict(amount="1.00", currency="CNY", unregistered=True),
                )
            ]
        ),
        "fields[0].default.unregistered",
        "UNKNOWN_PROPERTY",
        stage="structure",
        group="B10",
    )
    for prop, asset in [("field_type_registry_ref", "SEQUENCE_POLICY")]:
        s = business()
        s[prop]["asset_type"] = asset
        bad(
            "registry-wrong-type",
            s,
            prop + ".asset_type",
            "REFERENCE_INVALID",
            stage="structure",
            group="B03",
        )
    add(
        "number-valid",
        business(
            record_number=dict(
                field_code="record_no", label="编号", sequence_policy_ref=numbered
            )
        ),
        stage="structure",
        group="B03",
    )
    bad(
        "number-collision",
        business(
            record_number=dict(
                field_code="title", label="编号", sequence_policy_ref=numbered
            )
        ),
        "fields[0].field_code",
        "FIELD_CODE_INVALID",
        group="B04",
    )
    bad(
        "number-platform-reserved",
        business(
            record_number=dict(
                field_code="status", label="编号", sequence_policy_ref=numbered
            )
        ),
        "record_number.field_code",
        "FIELD_CODE_INVALID",
        group="B04",
    )
    for kind in ["short_text", "long_text", "single_select", "multi_select"]:
        f = field(kind)
        f["query"]["searchable"] = True
        add("search-allowed-" + kind, business([f]), group="B20")
    add(
        "prototype-all-lookups",
        business(
            [field(code="constructor"), field(code="prototype")],
            indexes=[
                dict(index_code="constructor", kind="NORMAL", fields=["constructor"])
            ],
            layout={
                "sections": [
                    section(
                        "prototype",
                        [dict(kind="field", field_code="constructor", col_span=1)],
                    )
                ]
            },
            record_rules=[rule(leaf("prototype"))],
        ),
        group="B04",
    )
    for kind, limit, value in [
        ("integer", {"minimum": -9007199254740991}, -9007199254740991),
        ("decimal", {"minimum": "-10.00", "maximum": "-2.00"}, "-3.00"),
        (
            "money",
            {"minimum": "-10.00", "maximum": "-2.00"},
            {"amount": "-3.00", "currency": "CNY"},
        ),
    ]:
        add(
            "negative-bound-" + kind,
            business([field(kind, default=value, constraints=limit)]),
        )
    add(
        "datetime-long-fraction",
        business(
            [
                field(
                    "datetime",
                    default="2024-01-01T00:00:00.123456789012345678901234567890123456789-23:59",
                )
            ]
        ),
        group="B11",
    )
    add(
        "decimal-zero-scale",
        business(
            [field("decimal", default="0.1", type_config={"precision": 1, "scale": 1})]
        ),
        group="B09",
    )
    for val in ["1\n", "1\r", "1\t"]:
        bad(
            "decimal-terminal-control-" + str(len(result)),
            business([field("decimal", default=val)]),
            "fields[0].default",
            stage="structure",
            group="B09",
        )
    bad(
        "code-terminal-newline",
        business(schema_code="valid\n"),
        "schema_code",
        "SCHEMA_CODE_INVALID",
        stage="structure",
        group="B01",
    )
    for key in ("description",):
        bad(
            "description-html",
            business(**{key: "<script>alert(1)</script>"}),
            key,
            "ARBITRARY_EXPRESSION_FORBIDDEN",
            group="B01",
        )
    bad(
        "layout-html",
        business(
            layout={
                "sections": [
                    section(items=[dict(kind="description", text="<b>unsafe</b>")])
                ]
            }
        ),
        "layout.sections[0].items[0].text",
        "ARBITRARY_EXPRESSION_FORBIDDEN",
        group="B15",
    )
    add(
        "description-plain-instructions",
        business(description="这里说明 SQL 的含义，不调用服务。"),
        group="B01",
    )
    for kind, value in [
        ("date", "2024-01-01\n"),
        ("datetime", "2024-01-01T00:00:00Z\n"),
    ]:
        bad(
            "terminal-newline-" + kind,
            business([field(kind, default=value)]),
            "fields[0].default",
            group="B11",
        )
    bad(
        "rule-decimal-terminal-newline",
        business(
            [field("decimal")], record_rules=[rule(leaf(operator="eq", value="1\n"))]
        ),
        "record_rules[0].assert",
        group="B19",
    )
    add(
        "rule-boolean-ordered",
        business(
            [field("boolean")], record_rules=[rule(leaf(operator="gt", value=True))]
        ),
        group="B19",
    )
    c = history_context()
    add(
        "history-effective-min-length-unchanged",
        business([field(constraints={"min_length": 0})]),
        context=c,
        group="B22",
    )
    for char in ("\u00a0", "\u3000", "\ufeff"):
        add(
            "pattern-whitespace-" + str(ord(char)),
            business([field(default=char, constraints={"pattern": r"^\s$"})]),
            group="B06",
        )
        add(
            "trim-whitespace-" + str(ord(char)),
            business(
                [
                    field(
                        default=char + "a" + char,
                        constraints={"trim": True, "max_length": 1},
                    )
                ]
            ),
            group="B06",
        )
    for char in ("\u0085", "\u200b"):
        bad(
            "pattern-not-whitespace-" + str(ord(char)),
            business([field(default=char, constraints={"pattern": r"^\s$"})]),
            "fields[0].default",
            group="B06",
        )
        add(
            "pattern-complement-" + str(ord(char)),
            business([field(default=char, constraints={"pattern": r"^\S$"})]),
            group="B06",
        )
    s = business()
    del s["field_type_registry_ref"]["app_id"]
    bad(
        "registry-missing-app-id",
        s,
        "field_type_registry_ref.app_id",
        "REFERENCE_INVALID",
        stage="structure",
        group="B03",
    )
    for columns in (1, 4):
        add(
            "layout-columns-" + str(columns),
            business(layout={"sections": [section(columns=columns)]}),
            stage="structure",
            group="B15",
        )
    bad(
        "layout-columns-5",
        business(layout={"sections": [section(columns=5)]}),
        "layout.sections[0].columns",
        "CONTRACT_SHAPE_INVALID",
        stage="structure",
        group="B15",
    )
    bad(
        "index-empty-fields",
        business(indexes=[dict(index_code="idx_one", kind="NORMAL", fields=[])]),
        "indexes[0].fields",
        "CONTRACT_SHAPE_INVALID",
        stage="structure",
        group="B21",
    )
    idx = dict(index_code="idx_one", kind="NORMAL", fields=["title"])
    bad(
        "index-code-duplicate",
        business(indexes=[idx, deepcopy(idx)]),
        "indexes[1].index_code",
        group="B21",
    )
    bad(
        "rule-code-duplicate",
        business(record_rules=[rule(), rule()]),
        "record_rules[1].rule_code",
        group="B18",
    )
    for kind, where, key, value in [
        ("decimal", "constraints", "precision", 18),
        ("integer", "type_config", "options", []),
        ("money", "constraints", "currency", "CNY"),
    ]:
        f = field(kind)
        f.setdefault(where, {})[key] = value
        bad(
            "misplaced-" + kind + "-" + key,
            business([f]),
            "fields[0]." + where + "." + key,
            "UNKNOWN_PROPERTY",
            stage="structure",
            group="B14",
        )
    bad(
        "money-dynamic-mode",
        business(
            [
                field(
                    "money", type_config={"currency_mode": "DYNAMIC", "currency": "CNY"}
                )
            ]
        ),
        "fields[0].type_config.currency_mode",
        stage="structure",
        group="B10",
    )
    for size in (1, 64):
        add(
            "option-code-" + str(size),
            business(
                [field("single_select", type_config={"options": [option("a" * size)]})]
            ),
            stage="structure",
            group="B12",
        )
    bad(
        "option-code-65",
        business([field("single_select", type_config={"options": [option("a" * 65)]})]),
        "fields[0].type_config.options[0].code",
        stage="structure",
        group="B12",
    )
    for key in ("code", "label", "order", "enabled"):
        o = option()
        del o[key]
        bad(
            "option-missing-" + key,
            business([field("single_select", type_config={"options": [o]})]),
            "fields[0].type_config.options[0]." + key,
            "CONTRACT_SHAPE_INVALID",
            stage="structure",
            group="B12",
        )
    for key in ("searchable", "filterable", "sortable"):
        f = field()
        f["query"][key] = "false"
        bad(
            "query-wrong-bool-" + key,
            business([f]),
            "fields[0].query." + key,
            "CONTRACT_SHAPE_INVALID",
            stage="structure",
            group="B05",
        )
    platform_layout = business(
        layout={
            "sections": [
                section(items=[dict(kind="field", field_code="id", col_span=1)])
            ]
        }
    )
    add("layout-platform-id-structure", platform_layout, stage="structure", group="B15")
    add("layout-platform-id-semantic", platform_layout, group="B15")
    for kind in ("NORMAL", "UNIQUE"):
        bad(
            "multi-index-not-enabled-" + kind,
            business(
                [field("multi_select")],
                indexes=[dict(index_code="idx_one", kind=kind, fields=["title"])],
            ),
            "indexes[0].fields[0]",
            group="B21",
        )
    c = deepcopy(CONTEXT)
    del c["business"]["index_capabilities"]
    bad(
        "index-capabilities-missing",
        business(indexes=[dict(index_code="idx_one", kind="NORMAL", fields=["title"])]),
        "indexes[0].fields[0]",
        "DEPENDENCY_VALIDATOR_UNAVAILABLE",
        context=c,
        group="B21",
    )
    for key in ("amount", "currency"):
        value = {"amount": "1.00", "currency": "CNY"}
        del value[key]
        bad(
            "money-default-missing-" + key,
            business([field("money", default=value)]),
            "fields[0].default." + key,
            "CONTRACT_SHAPE_INVALID",
            stage="structure",
            group="B10",
        )
    # Review round 1: every recursive slot is scanned before union validation.
    deep = leaf()
    for _ in range(200):
        deep = {"not": deep}

    def slot(name, expression):
        return [expression] if name in ("all", "any") else expression

    bad(
        "review-plain-deep-control",
        business(record_rules=[rule(deep)]),
        "record_rules[0].assert",
        stage="structure",
        group="B19",
    )
    for shallow in ("all", "any", "not"):
        for hidden in ("all", "any", "not"):
            if shallow == hidden:
                continue
            expr = {shallow: slot(shallow, leaf()), hidden: slot(hidden, deep)}
            bad(
                "review-mixed-" + shallow + "-" + hidden + "-deep",
                business(record_rules=[rule(expr)]),
                "record_rules[0].assert",
                stage="structure",
                group="B19",
            )
    for hidden in ("all", "any", "not"):
        expr = {
            key: slot(key, deep if key == hidden else leaf())
            for key in ("all", "any", "not")
        }
        bad(
            "review-triple-" + hidden + "-deep",
            business(record_rules=[rule(expr)]),
            "record_rules[0].assert",
            stage="structure",
            group="B19",
        )
    for shallow, hidden in (
        ("all", "any"),
        ("any", "all"),
        ("all", "not"),
        ("any", "not"),
    ):
        wide = {"all": [leaf()] * 21}
        expr = {shallow: [leaf()], hidden: [leaf()] * 21 if hidden != "not" else wide}
        bad(
            "review-hidden-wide-" + shallow + "-" + hidden,
            business(record_rules=[rule(expr)]),
            "record_rules[0]",
            stage="structure",
            group="B19",
        )
    for count in (20, 21):
        # No single slot exceeds 20; when + assert must include both mixed slots.
        when = {"all": [leaf()] * 9, "any": [leaf()] * (count - 10)}
        bad(
            "review-joint-mixed-budget-" + str(count),
            business(record_rules=[rule(when=when)]),
            "record_rules[0].when" if count == 20 else "record_rules[0]",
            (
                "ARBITRARY_EXPRESSION_FORBIDDEN"
                if count == 20
                else "CONSTRAINT_INCOMPATIBLE"
            ),
            stage="structure",
            group="B19",
        )
    for expr, name in [
        ({"all": [leaf()], "not": leaf()}, "all-not"),
        ({"any": [leaf()], "not": leaf()}, "any-not"),
        ({"all": [leaf()], "any": [leaf()]}, "all-any"),
        ({"all": [leaf()], "any": [leaf()], "not": leaf()}, "triple"),
    ]:
        bad(
            "review-shallow-mixed-" + name,
            business(record_rules=[rule(expr)]),
            "record_rules[0].assert",
            "ARBITRARY_EXPRESSION_FORBIDDEN",
            stage="structure",
            group="B18",
        )
    for hidden in ("all", "any", "not"):
        expr = {key: slot(key, leaf()) for key in ("all", "any", "not")}
        expr[hidden] = {"all": [leaf()] * 19} if hidden == "not" else [leaf()] * 19
        bad(
            "review-triple-" + hidden + "-wide",
            business(record_rules=[rule(expr)]),
            "record_rules[0]",
            stage="structure",
            group="B19",
        )
    # Option labels have string type only; field label limits do not apply here.
    for name, label in (
        ("empty", ""),
        ("81", "a" * 81),
        ("long-unicode", "😀汉" * 1024),
    ):
        item = option()
        item["label"] = label
        add(
            "option-label-source-" + name,
            business([field("single_select", type_config={"options": [item]})]),
            stage="structure",
            group="B12",
        )
    item = option()
    item["label"] = 123
    bad(
        "option-label-source-nonstring",
        business([field("single_select", type_config={"options": [item]})]),
        "fields[0].type_config.options[0].label",
        stage="structure",
        group="B12",
    )
    bad(
        "field-label-empty-still-invalid",
        business([field(label="")]),
        "fields[0].label",
        "CONTRACT_SHAPE_INVALID",
        stage="structure",
        group="B05",
    )
    return result
