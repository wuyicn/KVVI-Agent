"""Fixed Fake assets and independently specified View test inputs.

These are approved-scope test assets, not new public component standards.
No validator is imported; digest construction is fixture binding, not an oracle.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path

from business_cases import CONTEXT, TYPES, business, field, option

VIEW_ID = "urn:kvvi:meta-schema:0a-core-r1:view-schema-lce-safe-v1"
FIELD_COMPONENTS = dict(zip(TYPES, [
    "ShortTextField", "LongTextField", "BooleanField", "IntegerField",
    "DecimalField", "MoneyField", "DateField", "DateTimeField",
    "SingleSelectField", "MultiSelectField",
]))
PAGES = ["FormPage", "ListPage", "DetailPage"]
LAYOUTS = ["Section", "Grid"]
DISPLAY = ["Table", "Text", "Description", "StatusBadge"]
ACTIONS = dict(zip(
    ["SaveDraftButton", "SubmitButton", "CancelButton", "OpenRecordLink"],
    ["form.save_draft", "form.submit", "form.cancel", "navigation.open_record"],
))
COMPONENTS = PAGES + LAYOUTS + list(FIELD_COMPONENTS.values()) + DISPLAY + list(ACTIONS)


def digest(value):
    # All fixture values are in c14n's validated integer/Unicode input domain.
    raw = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def ref(kind, code, content, platform=True):
    return dict(
        scope_type="PLATFORM_CONTROL" if platform else "TENANT",
        scope_id="kvvi-platform" if platform else "11111111-1111-4111-8111-111111111111",
        app_id=None if platform else "22222222-2222-4222-8222-222222222222",
        module_id=None if platform else "33333333-3333-4333-8333-333333333333",
        asset_type=kind,
        **{"capability_code" if kind == "CAPABILITY" else "asset_id": code},
        version=1, digest=digest(content),
    )


def closed(properties, required=()):
    return dict(type="object", properties=properties, required=list(required), additionalProperties=False)


def safe(kind):
    return {"$ref": VIEW_ID + "#/$defs/" + kind}


def fixture_context(include_all_types=True):
    ctx = deepcopy(CONTEXT)
    folder = Path(__file__).with_name("0a-core-r1")
    assets = json.loads((folder / "contexts/business-prd-7-14-fake.json").read_text())["fake_assets"]

    def asset(kind, code, content, platform=True):
        entry = dict(ref=ref(kind, code, content, platform), content=content)
        assets.append(entry)
        return deepcopy(entry["ref"])

    source = Path(__file__).with_name("0a-core-r1") / "inputs/business-prd-7-14-fake.json"
    bs = json.loads(source.read_text())["spec"]
    # Include every basic type in a distinct stable field for adaptation tests.
    existing = {f["field_code"] for f in bs["fields"]}
    for kind in TYPES if include_all_types else []:
        if kind not in existing:
            bs["fields"].append(field(kind, kind))
    for f in bs["fields"] if include_all_types else []:
        if f["type"] in ("single_select", "multi_select"):
            f["type_config"]["options"].append(option("disabled", False))
    business_ref = asset("BUSINESS_SCHEMA", "general_item", bs, False)
    text = {"anyOf": [{"type": "string"}, safe("I18nRef")]}
    components = []
    for name in COMPONENTS:
        properties = {}
        required = []
        bindings = {}
        if name in PAGES + LAYOUTS:
            properties["title"] = text
            bindings["title"] = ["I18nRef"]
        if name in LAYOUTS:
            properties["columns"] = dict(type="integer", minimum=1, maximum=4)
        if name in FIELD_COMPONENTS.values():
            properties.update(fieldBinding=safe("FieldRef"), labelMode={"const": "BUSINESS_SCHEMA"},
                              colSpan=dict(type="integer", minimum=1, maximum=4))
            required = ["fieldBinding"]
            bindings["fieldBinding"] = ["FieldRef"]
        if name in DISPLAY + list(ACTIONS):
            properties["text"] = text
            bindings["text"] = ["I18nRef"]
        if name in DISPLAY:
            properties["value"] = safe("FieldRef")
            bindings["value"] = ["FieldRef"]
        if name == "Table":
            properties["data"] = {"anyOf": [safe("DataBindingRef"), safe("DataQueryRef")]}
            bindings["data"] = ["DataBindingRef", "DataQueryRef"]
        properties["disabled"] = safe("SafeExpression")
        bindings["disabled"] = ["SafeExpression"]
        components.append(dict(
            componentName=name, version=1, state="PUBLISHED", description="固定 Fake 组件，不渲染",
            propsSchema=closed(properties, required), bindingPositions=bindings,
            allowedParents=[] if name in PAGES else PAGES + LAYOUTS,
            allowedChildren=COMPONENTS[3:] if name in PAGES + LAYOUTS else [],
            maxChildren=500 if name in PAGES + LAYOUTS else 0,
            viewTypes=[dict(FormPage="FORM", ListPage="LIST", DetailPage="DETAIL")[name]] if name in PAGES else ["FORM", "LIST", "DETAIL"],
            loopSupported=name in LAYOUTS + ["Text"],
            fieldTypes=[kind for kind, component in FIELD_COMPONENTS.items() if component == name],
            events={"onClick": [ACTIONS[name]]} if name in ACTIONS else {},
            adapter=dict(fixture=True, implementation="no-renderer", digest=digest({"fake": name})),
        ))
    component_ref = asset("COMPONENT_REGISTRY", "vue_element_approved", dict(fixture=True, version=1, state="PUBLISHED", components=components))
    members = []
    for code in list(ACTIONS.values()) + ["records.list", "records.get", "options.list"]:
        action = code in ACTIONS.values()
        props = {}
        required = []
        if code in ("form.save_draft", "form.submit"):
            props["note"] = {"anyOf": [{"type": "string"}, safe("FieldRef")]}
        if code == "navigation.open_record":
            props["recordId"] = dict(type="string", minLength=1)
            required = ["recordId"]
        if not action:
            props["businessSchemaRef"] = {"const": business_ref}
            required = ["businessSchemaRef"]
            if code == "records.list":
                props["pageSize"] = dict(type="integer", minimum=1, maximum=200)
            elif code == "records.get":
                props["recordId"] = dict(type="string", minLength=1)
                required.append("recordId")
            else:
                props["field"] = safe("FieldRef")
                required.append("field")
        record = closed({"id": {"type": "string"}, "title": {"type": "string"}}, ["id", "title"])
        content = dict(
            fixture=True, capability_code=code, version=1, state="PUBLISHED",
            category="ACTION" if action else "QUERY", inputSchema=closed(props, required),
            outputSchema=closed({"ok": {"type": "boolean"}}, ["ok"]) if action else closed({"items": {"type": "array", "items": record, "maxItems": 200}}, ["items"]),
            errorSchema=closed({"code": {"enum": ["FAKE_REJECTED"]}, "retryable": {"const": False}}, ["code", "retryable"]),
            authorization=["FAKE_ONLY"], scope="current_business", sideEffects=False,
            idempotency="fixture-no-write", retry="never", runtimeDigest=digest({"fake": code}),
            timeoutMs=1000, rateLimit=1, maxResults=0 if action else 200,
            itemKeys=[] if action else ["id"], recovery="return-fixed-error", auditEvents=["fake.validation"],
        )
        members.append(asset("CAPABILITY", code, content))
    capability_ref = asset("CAPABILITY_REGISTRY", "fake-capabilities", dict(fixture=True, version=1, state="PUBLISHED", members=members))
    ctx["fake_assets"] = assets
    ctx["view"] = dict(capability_registry_ref=capability_ref, deleted_node_ids=[])
    return ctx


def asset_for(ctx, kind, code=None):
    return next(a for a in ctx["fake_assets"] if a["ref"]["asset_type"] == kind and
                (code is None or a["ref"].get("asset_id", a["ref"].get("capability_code")) == code))


def node(name="Text", id="node_text", **extra):
    return dict(id=id, componentName=name, **extra)


def view(ctx, kind="FORM", **extra):
    return dict(view_code="general_item_" + kind.lower(), name="测试页面", view_type=kind,
                businessSchemaRef=deepcopy(asset_for(ctx, "BUSINESS_SCHEMA")["ref"]),
                componentRegistryRef=deepcopy(asset_for(ctx, "COMPONENT_REGISTRY")["ref"]),
                componentsTree=[node(dict(FORM="FormPage", LIST="ListPage", DETAIL="DetailPage")[kind], "page_root")], **extra)


def query(ctx, code="records.list"):
    params = {"businessSchemaRef": deepcopy(asset_for(ctx, "BUSINESS_SCHEMA")["ref"])}
    if code == "records.list": params["pageSize"] = 20
    if code == "records.get": params["recordId"] = "fake-record"
    if code == "options.list": params["field"] = field_ref("category")
    return dict(type="DataQueryRef", queryRef=deepcopy(asset_for(ctx, "CAPABILITY", code)["ref"]), params=params)


def field_ref(code="title"):
    return dict(type="FieldRef", fieldRef=code)


def expression(code="quantity", operator="gt", right=100):
    return dict(type="SafeExpression", left=field_ref(code), operator=operator, right=right)


def action(ctx, code="form.submit"):
    out = dict(type="ActionRef", actionRef=deepcopy(asset_for(ctx, "CAPABILITY", code)["ref"]))
    if code == "navigation.open_record": out["input"] = dict(recordId="fake-record")
    return out


def binding(**extra):
    return dict(type="DataBindingRef", queryCode="items_query", itemKey="id", maxItems=200, **extra)


def canonical_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
