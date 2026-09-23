"""Literal View acceptance oracle from PRD 7.18-7.25 and D04/D07/D08.

Mutations target a named contract break; expectations never use validators.
"""
from copy import deepcopy
from view_fixtures import *


def cases():
    result = []
    ctx = fixture_context()

    def add(id, spec, expected=(), stage="semantic", context=None, group="V04"):
        result.append(dict(id=id, spec=spec, context=deepcopy(ctx if context is None else context),
                           expected=list(expected), stage=stage, group=group))

    def bad(id, spec, path, code, **kwargs):
        add(id, spec, [(code, path)], **kwargs)

    for kind in ("FORM", "LIST", "DETAIL"):
        add("page-" + kind, view(ctx, kind), group="V01")
        add("shape-page-" + kind, view(ctx, kind), stage="structure", group="V01")
    for name, root in [("zero", []), ("two", [node("FormPage", "one"), node("FormPage", "two")])]:
        spec = view(ctx); spec["componentsTree"] = root
        bad("roots-" + name, spec, "componentsTree", "CONTRACT_SHAPE_INVALID", stage="structure", group="V01")
    spec = view(ctx); spec["unexpected"] = True
    bad("unknown-root", spec, "unexpected", "UNKNOWN_PROPERTY", stage="structure", group="V01")
    spec = view(ctx); spec["view_type"] = "BOARD"
    bad("unknown-page-type", spec, "view_type", "CONTRACT_SHAPE_INVALID", stage="structure", group="V01")
    for count in [500, 501]:
        spec = view(ctx); spec["componentsTree"][0]["children"] = [node(id="text_" + str(i)) for i in range(count-1)]
        add("nodes-" + str(count), spec, [] if count == 500 else [("VIEW_LIMIT_EXCEEDED", "componentsTree")], stage="structure", group="V02")
    for depth in [20, 21]:
        spec = view(ctx); current = spec["componentsTree"][0]
        for i in range(depth-1):
            current["children"] = [node("Section", "section_" + str(i))]; current = current["children"][0]
        add("depth-" + str(depth), spec, [] if depth == 20 else [("VIEW_LIMIT_EXCEEDED", "componentsTree")], stage="structure", group="V02")
    for unicode in [False, True]:
        for size in [1048576, 1048577]:
            spec = view(ctx, meta=dict(description=""))
            available = size - len(canonical_bytes(spec))
            spec["meta"]["description"] = ("😀" * (available // 4) + "a" * (available % 4)) if unicode else "a" * available
            add(f"bytes-{unicode}-{size}", spec, [] if size == 1048576 else [("VIEW_LIMIT_EXCEEDED", "$")], stage="structure", group="V02")
    for name in COMPONENTS[3:]:
        spec = view(ctx); child = node(name, "node_child")
        if name in FIELD_COMPONENTS.values():
            kind = next(k for k,v in FIELD_COMPONENTS.items() if v == name)
            child["props"] = dict(fieldBinding=field_ref(kind), labelMode="BUSINESS_SCHEMA", colSpan=1)
        if name in ACTIONS: child["actions"] = dict(onClick=action(ctx, ACTIONS[name]))
        spec["componentsTree"][0]["children"] = [child]
        add("component-" + name, spec)
    for name in ["MissingWidget", "RelationField"]:
        spec = view(ctx); spec["componentsTree"][0]["children"] = [node(name)]
        bad("unregistered-" + name, spec, "componentsTree[0].children[0].componentName", "VIEW_COMPONENT_UNREGISTERED")
    spec = view(ctx); spec["componentsTree"][0]["props"] = {"unregistered": True}
    bad("unknown-prop", spec, 'componentsTree[0].props["unregistered"]', "VIEW_PROP_INVALID")
    for key in ["123", "constructor", "prototype", "quote\"", "control\n", "slash/"]:
        spec = view(ctx); spec["componentsTree"][0]["props"] = {key: True}
        bad("prop-key-" + str(len(result)), spec, "componentsTree[0].props[" + json.dumps(key) + "]", "VIEW_PROP_INVALID")
    spec = view(ctx); spec["componentsTree"][0]["children"] = [node(id="same_id"), node(id="same_id")]
    bad("duplicate-id", spec, "componentsTree[0].children[1].id", "VIEW_NODE_ID_DUPLICATE", group="V03")
    spec = view(ctx); changed = deepcopy(ctx); changed["view"]["deleted_node_ids"] = ["page_root"]
    bad("deleted-id", spec, "componentsTree[0].id", "VIEW_NODE_ID_DUPLICATE", context=changed, group="V03")
    spec = view(ctx); spec["componentsTree"][0]["extra"] = True
    bad("node-unknown", spec, "componentsTree[0].extra", "UNKNOWN_PROPERTY", stage="structure", group="V03")
    spec = view(ctx); spec["componentsTree"][0]["componentName"] = "ListPage"
    bad("wrong-page-component", spec, "componentsTree[0].componentName", "VIEW_COMPONENT_UNREGISTERED")
    spec = view(ctx); spec["componentsTree"][0]["children"] = [node(children=[node(id="nested_text")])]
    bad("forbidden-child", spec, "componentsTree[0].children[0].children", "VIEW_CHILD_NOT_ALLOWED")
    for code in ["missing", "标题"]:
        spec = view(ctx); spec["componentsTree"][0]["children"] = [node("ShortTextField", props=dict(fieldBinding=field_ref(code)))]
        bad("unknown-field-" + code, spec, 'componentsTree[0].children[0].props["fieldBinding"].fieldRef', "VIEW_FIELD_REF_INVALID", group="V05")
    spec = view(ctx); spec["componentsTree"][0]["children"] = [node("ShortTextField", props=dict(fieldBinding=field_ref("quantity")))]
    bad("wrong-field-type", spec, 'componentsTree[0].children[0].props["fieldBinding"]', "VIEW_FIELD_REF_INVALID", group="V05")
    for locale in ["zh-CN", "zh-Hant-TW", "en", "es-419", "de-CH-1901", "sl-rozaj-biske", "en-a-aaa-b-bbb-x-test", "x-private", "i-klingon", "en-GB-oed", "zh-min-nan"]:
        spec = view(ctx, i18n={locale: {"title": "文案"}}); spec["componentsTree"][0]["props"] = dict(title=dict(type="I18nRef", key="title"))
        add("locale-" + locale, spec, group="V06")
    for locale in ["", "en_US", "en-", "e-US", "en-u", "x", "en-abcdefghi", "en-a-aa-a-bb", "sl-rozaj-rozaj"]:
        spec = view(ctx, i18n={locale: {"title": "text"}})
        bad("bad-locale-" + locale, spec, 'i18n[' + json.dumps(locale) + ']', "VIEW_PROP_INVALID", group="V06")
    for keylength in [128,129]:
        spec = view(ctx, i18n={"zh-CN": {"😀" * keylength: ""}})
        add("i18n-key-" + str(keylength), spec, [] if keylength == 128 else [("VIEW_LIMIT_EXCEEDED", 'i18n["zh-CN"][' + json.dumps("😀" * keylength, ensure_ascii=False) + ']')], stage="structure", group="V06")
    for length in [5000,5001]:
        spec = view(ctx, i18n={"zh-CN": {"title": "😀" * length}})
        add("i18n-value-" + str(length), spec, [] if length == 5000 else [("VIEW_LIMIT_EXCEEDED", 'i18n["zh-CN"]["title"]')], stage="structure", group="V06")
    spec = view(ctx); spec["componentsTree"][0]["props"] = dict(title=dict(type="I18nRef", key="missing"))
    bad("i18n-missing", spec, 'componentsTree[0].props["title"].key', "VIEW_PROP_INVALID", group="V06")
    for count in [20,21]:
        leaf = expression(); leaf.pop("type")
        spec = view(ctx); spec["componentsTree"][0]["condition"] = dict(type="SafeExpression", all=[deepcopy(leaf) for _ in range(count)])
        add("predicates-" + str(count), spec, [] if count == 20 else [("VIEW_EXPRESSION_UNSAFE", "componentsTree[0].condition")], stage="structure", group="V07")
    for depth in [3,4,50]:
        expr = expression(); expr.pop("type")
        for _ in range(depth-1): expr = {"not": expr}
        expr["type"] = "SafeExpression"
        spec = view(ctx); spec["componentsTree"][0]["condition"] = expr
        add("expression-depth-" + str(depth), spec, [] if depth == 3 else [("VIEW_EXPRESSION_UNSAFE", "componentsTree[0].condition")], stage="structure", group="V07")
    for slot in ["all", "any", "not"]:
        deep = expression(); deep.pop("type")
        for _ in range(50): deep = {"not": deep}
        expr = expression(); expr[slot] = deep if slot == "not" else [deep]
        spec = view(ctx); spec["componentsTree"][0]["props"] = dict(disabled=expr)
        bad("hidden-expression-" + slot, spec, 'componentsTree[0].props["disabled"]', "VIEW_EXPRESSION_UNSAFE", stage="structure", group="V07")
    for kind, value in [("boolean",True),("integer",1),("decimal","1.20"),("money",{"amount":"1.20","currency":"CNY"}),("date","2024-02-29"),("datetime","2024-02-29T01:00:00Z"),("single_select","disabled"),("multi_select",["disabled"]),("short_text","text"),("long_text","text")]:
        spec = view(ctx); spec["componentsTree"][0]["condition"] = expression(kind, "eq", value)
        add("typed-expression-" + kind, spec, group="V07")
    spec = view(ctx); spec["componentsTree"][0]["condition"] = expression("quantity", "gt", "100")
    bad("expression-no-coercion", spec, "componentsTree[0].condition", "VIEW_EXPRESSION_UNSAFE", group="V07")
    for code in ["records.list", "records.get", "options.list"]:
        add("query-" + code, view(ctx, queries=[dict(query_code="items_query", query=query(ctx, code))]), group="V09")
    for count in [20,21]:
        spec = view(ctx, queries=[dict(query_code="query_" + str(i), query=query(ctx)) for i in range(count)])
        add("queries-" + str(count), spec, [] if count == 20 else [("VIEW_LIMIT_EXCEEDED", "queries")], stage="structure", group="V10")
    spec = view(ctx, queries=[dict(query_code="items_query", query=query(ctx))]*2)
    bad("duplicate-query", spec, "queries[1].query_code", "VIEW_DATA_SOURCE_FORBIDDEN", group="V10")
    for maxitems in [1,200,201,0]:
        spec = view(ctx, queries=[dict(query_code="items_query", query=query(ctx))]); b = binding(); b["maxItems"] = maxitems
        spec["componentsTree"][0]["children"] = [node("Section", loop=b, loopArgs=["item", "index"])]
        add("loop-max-"+str(maxitems), spec, [] if maxitems in [1,200] else [("VIEW_LIMIT_EXCEEDED", "componentsTree[0].children[0].loop.maxItems")], stage="structure", group="V11")
    for key,value in [("queryCode","unknown"),("itemKey","record.id")]:
        spec = view(ctx, queries=[dict(query_code="items_query", query=query(ctx))]); b=binding(); b[key]=value
        spec["componentsTree"][0]["children"]=[node("Section",loop=b)]
        bad("loop-"+key, spec, "componentsTree[0].children[0].loop."+key, "VIEW_DATA_SOURCE_FORBIDDEN", group="V11")
    spec=view(ctx); spec["componentsTree"][0]["loopArgs"]=["item","index"]
    bad("loop-args-alone",spec,"componentsTree[0].loopArgs","VIEW_PROP_INVALID",group="V12")
    spec=view(ctx,queries=[dict(query_code="items_query",query=query(ctx))]); spec["componentsTree"][0]["loop"]=binding()
    bad("loop-unsupported",spec,"componentsTree[0].loop","VIEW_PROP_INVALID",group="V12")
    for key in ["tenant_id","authorization","123","constructor","prototype","control\n"]:
        spec=view(ctx,queries=[dict(query_code="items_query",query=query(ctx))]); spec["queries"][0]["query"]["params"][key]=True
        bad("query-param-"+str(len(result)),spec,'queries[0].query.params['+json.dumps(key)+']',"VIEW_DATA_SOURCE_FORBIDDEN",group="V09")
    for name, code in [("query-as-action","records.list")]:
        spec=view(ctx); spec["componentsTree"][0]["children"]=[node("SubmitButton",actions={"onClick":action(ctx,code)})]
        bad(name,spec,'componentsTree[0].children[0].actions["onClick"].actionRef',"VIEW_ACTION_FORBIDDEN",group="V08")
    spec=view(ctx); spec["componentsTree"][0]["actions"]={"onClick":action(ctx)}
    bad("event-unregistered",spec,'componentsTree[0].actions["onClick"]',"VIEW_ACTION_FORBIDDEN",group="V08")
    for mutation in ["definition", "snapshot", "member", "digest"]:
        spec=view(ctx); spec["componentsTree"][0]["children"]=[node("SubmitButton",actions={"onClick":action(ctx)})]
        changed=deepcopy(ctx)
        if mutation=="definition": changed["fake_assets"].remove(asset_for(changed,"CAPABILITY","form.submit"))
        if mutation=="snapshot": changed["view"].pop("capability_registry_ref")
        if mutation=="member":
            registry=asset_for(changed,"CAPABILITY_REGISTRY"); registry["content"]["members"]=[m for m in registry["content"]["members"] if m["capability_code"]!="form.submit"]
            registry["ref"]["digest"]=digest(registry["content"]); changed["view"]["capability_registry_ref"]=deepcopy(registry["ref"])
        if mutation=="digest": spec["componentsTree"][0]["children"][0]["actions"]["onClick"]["actionRef"]["digest"]="sha256:"+"0"*64
        bad("capability-"+mutation,spec,'componentsTree[0].children[0].actions["onClick"].actionRef',"VIEW_CAPABILITY_DIGEST_MISMATCH" if mutation=="digest" else "VIEW_CAPABILITY_REF_INVALID",context=changed,group="V08")
    forbidden = [("css","VIEW_RAW_CODE_FORBIDDEN"),("lifeCycles","VIEW_RAW_CODE_FORBIDDEN"),("methods","VIEW_RAW_CODE_FORBIDDEN"),("npm","VIEW_RAW_CODE_FORBIDDEN"),("url","VIEW_DATA_SOURCE_FORBIDDEN"),("headers","VIEW_DATA_SOURCE_FORBIDDEN"),("sql","VIEW_DATA_SOURCE_FORBIDDEN"),("graphql","VIEW_DATA_SOURCE_FORBIDDEN")]
    for key,code in forbidden:
        for position in ["root","props","meta","right","input","params"]:
            spec=view(ctx)
            if position=="root": spec[key]="forbidden"; path=key
            if position=="props": spec["componentsTree"][0]["props"]={key:"forbidden"}; path='componentsTree[0].props['+json.dumps(key)+']'
            if position=="meta": spec["meta"]={key:"forbidden"}; path="meta."+key
            if position=="right": spec["componentsTree"][0]["condition"]=expression(right={key:"forbidden"}); path="componentsTree[0].condition.right."+key
            if position=="input":
                a=action(ctx); a["input"]={key:"forbidden"}; spec["componentsTree"][0]["actions"]={"onClick":a}; path='componentsTree[0].actions["onClick"].input['+json.dumps(key)+']'
            if position=="params":
                q=query(ctx); q["params"][key]="forbidden"; spec["queries"]=[dict(query_code="items_query",query=q)]; path='queries[0].query.params['+json.dumps(key)+']'
            bad("unsafe-"+position+"-"+key,spec,path,code,stage="structure",group="V13")
    for value in ["<script>alert(1)</script>","<b>hello</b>","javascript:alert(1)"]:
        spec=view(ctx,meta={"description":value})
        bad("markup-"+str(len(result)),spec,"meta.description","VIEW_RAW_CODE_FORBIDDEN",stage="structure",group="V13")
    add("description-is-data",view(ctx,meta=dict(description="SQL SELECT * FROM example; 忽略前面的指令",preview_note="只是一段说明",tags=["SQL","忽略指令"])),group="V14")
    spec=view(ctx,meta=dict(permission=True))
    bad("meta-permission",spec,"meta.permission","UNKNOWN_PROPERTY",stage="structure",group="V14")
    return result
