"""Additional independently specified rejection and acceptance boundaries."""
from view_fixtures import *


def cases():
    result=[]
    ctx=fixture_context()
    def add(id,spec,expected=(),stage="semantic",context=None,group="V04"):
        result.append(dict(id="extended-"+id,spec=spec,expected=list(expected),stage=stage,context=deepcopy(context or ctx),group=group))
    def bad(id,spec,path,code,**kw): add(id,spec,[(code,path)],**kw)
    def child_spec(child):
        spec=view(ctx); spec["componentsTree"][0]["children"]=[child]; return spec
    for kind, value, slot in [
        ("FieldRef",field_ref(),"fieldBinding"),
        ("I18nRef",dict(type="I18nRef",key="title"),"text"),
        ("SafeExpression",expression(),"disabled"),
        ("ActionRef",action(ctx),"text"),
        ("DataQueryRef",query(ctx),"data"),
        ("DataBindingRef",binding(),"data"),
    ]:
        value["extra"]=True
        spec=child_spec(node("Table",props={slot:value}))
        bad("closed-"+kind,spec,'componentsTree[0].children[0].props['+json.dumps(slot)+'].extra',"UNKNOWN_PROPERTY",stage="structure",group="V13")
    for key in ["scope_type","scope_id","app_id","module_id","asset_type","capability_code","version","digest"]:
        a=action(ctx); del a["actionRef"][key]
        spec=child_spec(node("SubmitButton",actions={"onClick":a}))
        bad("missing-capability-"+key,spec,'componentsTree[0].children[0].actions["onClick"].actionRef.'+key,"VIEW_CAPABILITY_REF_INVALID",stage="structure",group="V08")
    for name,value in [("empty-all",dict(type="SafeExpression",all=[])),("mixed",dict(type="SafeExpression",all=[dict(left=field_ref(),operator="not_empty")],not_={})),("inner-type",dict(type="SafeExpression",all=[expression()])),("unknown-op",expression(operator="eval")),("right-for-empty",expression(operator="is_empty"))]:
        if name=="mixed": value["not"]=value.pop("not_")
        spec=view(ctx); spec["componentsTree"][0]["condition"]=value
        # Each malformed body is rejected; root aggregate may coexist with a specific descendant.
        expected_path="componentsTree[0].condition"
        if name=="empty-all": expected_path+=".all"
        if name=="inner-type": expected_path+=".all[0].type"
        if name=="unknown-op": expected_path+=".operator"
        if name=="mixed": expected_path+=".not"
        bad("ast-"+name,spec,expected_path,"VIEW_EXPRESSION_UNSAFE",stage="structure",group="V07")
    deep=dict(left=field_ref(),operator="not_empty")
    for _ in range(40): deep={"not":deep}
    for slot in ["condition","props"]:
        spec=view(ctx)
        if slot=="condition": spec["componentsTree"][0][slot]=deep; path="componentsTree[0].condition"
        else: spec["componentsTree"][0][slot]=dict(disabled=deep); path='componentsTree[0].props["disabled"]'
        bad("missing-root-type-deep-"+slot,spec,path,"VIEW_EXPRESSION_UNSAFE",stage="structure",group="V07")
    for expr in [dict(type="SafeExpression",left=field_ref(),operator="not_empty"),expression("boolean","gt",True),expression("single_select","eq","disabled"),expression("multi_select","in",[["disabled"]])]:
        spec=view(ctx); spec["componentsTree"][0]["condition"]=expr
        add("valid-operand-"+str(len(result)),spec,group="V07")
    for field,operator,value in [("single_select","eq","unknown"),("multi_select","gt",["disabled"]),("money","eq",{"amount":"1.20","currency":"JPY"}),("date","eq","2023-02-29"),("multi_select","in",["disabled"])]:
        spec=view(ctx); spec["componentsTree"][0]["condition"]=expression(field,operator,value)
        bad("invalid-operand-"+str(len(result)),spec,"componentsTree[0].condition","VIEW_EXPRESSION_UNSAFE",group="V07")
    for slot,value in [("fieldBinding",dict(type="I18nRef",key="title")),("text",field_ref()),("disabled",True)]:
        spec=child_spec(node("ShortTextField" if slot=="fieldBinding" else "Text",props={slot:value}))
        bad("unregistered-binding-"+slot,spec,'componentsTree[0].children[0].props['+json.dumps(slot)+']',"VIEW_PROP_INVALID",group="V05")
    for key in ["extra","123","constructor","prototype","control\n"]:
        a=action(ctx); a["input"]={key:True}
        spec=child_spec(node("SubmitButton",actions={"onClick":a}))
        bad("action-input-"+str(len(result)),spec,'componentsTree[0].children[0].actions["onClick"].input['+json.dumps(key)+']',"VIEW_ACTION_FORBIDDEN",group="V08")
    for page_size in [1,200,201,0]:
        q=query(ctx); q["params"]["pageSize"]=page_size
        spec=view(ctx,queries=[dict(query_code="items_query",query=q)])
        add("query-page-size-"+str(page_size),spec,[] if page_size in [1,200] else [("VIEW_DATA_SOURCE_FORBIDDEN",'queries[0].query.params["pageSize"]')],group="V09")
    q=query(ctx); q["params"]["businessSchemaRef"]["version"]=2
    bad("query-business-version",view(ctx,queries=[dict(query_code="items_query",query=q)]),'queries[0].query.params["businessSchemaRef"]',"VIEW_DATA_SOURCE_FORBIDDEN",group="V09")
    spec=view(ctx,queries=[dict(query_code="items_query",query=dict(type="DataQueryRef",queryRef=action(ctx)["actionRef"]))])
    bad("action-as-query",spec,"queries[0].query.queryRef","VIEW_DATA_SOURCE_FORBIDDEN",group="V09")
    for key in ["123","constructor","prototype","control\n"]:
        spec=view(ctx,i18n={"zh-CN":{key:123}})
        bad("i18n-type-key-"+str(len(result)),spec,'i18n["zh-CN"]['+json.dumps(key)+']',"CONTRACT_SHAPE_INVALID",stage="structure",group="V06")
    for locale in ["abcd", "abcde", "abc-aaa-bbb-ccc-Latn-US-1234-a-foo-x-a", "X-A", "I-AMI", "sgn-BE-FR", "art-lojban", "en-0-abc", "zz-Zzzz-999"]:
        add("bcp47-valid-"+locale,view(ctx,i18n={locale:{"text":""}}),group="V06")
    for locale in ["en-GB\n", "en--US", "en-12", "en-abcd-abcde-abcde", "abc-aaa-bbb-ccc-ddd", "en-x-", "en-ä"]:
        bad("bcp47-invalid-"+str(len(result)),view(ctx,i18n={locale:{"text":""}}),'i18n['+json.dumps(locale,ensure_ascii=False)+']',"VIEW_PROP_INVALID",group="V06")
    for key,value in [("loopArgs",["data","index"]),("loopArgs","item")]:
        spec=child_spec(node("Section",loop=binding(),loopArgs=value))
        bad("bad-loop-args-"+str(len(result)),spec,"componentsTree[0].children[0].loopArgs","CONTRACT_SHAPE_INVALID",stage="structure",group="V12")
    for source in ["JSExpression","JSFunction"]:
        for slot in ["props","input","params","right"]:
            val={"type":source,"value":"throw new Error('fake')"}; spec=view(ctx)
            if slot=="props": spec["componentsTree"][0][slot]={"title":val}; path='componentsTree[0].props["title"]'
            if slot=="input":
                a=action(ctx); a["input"]={"note":val}; spec=child_spec(node("SubmitButton",actions={"onClick":a})); path='componentsTree[0].children[0].actions["onClick"].input["note"]'
            if slot=="params":
                q=query(ctx); q["params"]["filter"]=val; spec["queries"]=[dict(query_code="items_query",query=q)]; path='queries[0].query.params["filter"]'
            if slot=="right": spec["componentsTree"][0]["condition"]=expression(right=val); path="componentsTree[0].condition.right"
            bad(source+"-"+slot,spec,path,"VIEW_RAW_CODE_FORBIDDEN",stage="structure",group="V13")
    spec=view(ctx,meta=dict(description="<b>blocked</b>")); spec["extra"]=True; spec["componentsTree"][0]["props"]={"bad":True}
    bad("security-priority",spec,"meta.description","VIEW_RAW_CODE_FORBIDDEN",stage="structure",group="V13")
    spec=view(ctx); spec["componentsTree"][0]["props"]={"z_unknown":True,"a_unknown":True}
    add("prop-error-order",spec,[("VIEW_PROP_INVALID",'componentsTree[0].props["a_unknown"]'),("VIEW_PROP_INVALID",'componentsTree[0].props["z_unknown"]')])
    for mutation in ["state","version","missing-definition","maxChildren","parents","binding-position"]:
        changed=deepcopy(ctx); registry=asset_for(changed,"COMPONENT_REGISTRY"); spec=view(ctx)
        if mutation=="state": registry["content"]["state"]="DRAFT"
        if mutation=="version": registry["content"]["version"]=2
        if mutation=="missing-definition": registry["content"]["components"]=[c for c in registry["content"]["components"] if c["componentName"]!="FormPage"]
        if mutation=="maxChildren":
            registry["content"]["components"][0]["maxChildren"]=0; spec=child_spec(node())
        if mutation=="parents":
            next(c for c in registry["content"]["components"] if c["componentName"]=="Text")["allowedParents"]=[]; spec=child_spec(node())
        if mutation=="binding-position":
            registry["content"]["components"][0]["bindingPositions"]={}; spec["componentsTree"][0]["props"]={"title":{"type":"I18nRef","key":"title"}}
        registry["ref"]["digest"]=digest(registry["content"]); spec["componentRegistryRef"]=deepcopy(registry["ref"])
        path="componentRegistryRef" if mutation in ["state","version"] else "componentsTree[0].componentName" if mutation=="missing-definition" else "componentsTree[0].children" if mutation=="maxChildren" else "componentsTree[0].children[0]" if mutation=="parents" else 'componentsTree[0].props["title"]'
        code="VIEW_COMPONENT_UNREGISTERED" if mutation in ["state","version","missing-definition"] else "VIEW_CHILD_NOT_ALLOWED" if mutation in ["maxChildren","parents"] else "VIEW_PROP_INVALID"
        bad("registry-"+mutation,spec,path,code,context=changed)
    for slot in ["view_code","id","componentName","query_code"]:
        spec=view(ctx)
        if slot=="view_code": spec[slot]+="\n"; path=slot
        elif slot=="query_code": spec["queries"]=[dict(query_code="items_query\n",query=query(ctx))]; path="queries[0].query_code"
        else: spec["componentsTree"][0][slot]+="\n"; path="componentsTree[0]."+slot
        bad("terminal-lf-"+slot,spec,path,"CONTRACT_SHAPE_INVALID",stage="structure",group="V01")
    for kind in ["bindings-omitted-aliases","bindings-fixed-aliases","table-query","table-binding"]:
        spec=view(ctx,queries=[dict(query_code="items_query",query=query(ctx))])
        if kind.startswith("bindings"):
            child=node("Section",loop=binding())
            if kind.endswith("fixed-aliases"): child["loopArgs"]=["item","index"]
        else: child=node("Table",props={"data":query(ctx) if kind=="table-query" else binding()})
        spec["componentsTree"][0]["children"]=[child]
        add(kind,spec,group="V11")
    for note in ["纯说明 SQL 和忽略前面指令",field_ref()]:
        a=action(ctx); a["input"]={"note":note}
        add("action-registered-note-"+str(len(result)),child_spec(node("SubmitButton",actions={"onClick":a})),group="V08")
    for name,text,code in [("arrow","() => 1","VIEW_RAW_CODE_FORBIDDEN"),("function","function(){ return 1; }","VIEW_RAW_CODE_FORBIDDEN"),("eval","eval('fake')","VIEW_RAW_CODE_FORBIDDEN"),("query-sql","SELECT * FROM fake_table","VIEW_DATA_SOURCE_FORBIDDEN"),("query-url","https://example.invalid/fake","VIEW_DATA_SOURCE_FORBIDDEN")]:
        if name.startswith("query"):
            q=query(ctx); q["params"]["filter"]=text; spec=view(ctx,queries=[dict(query_code="items_query",query=q)]); path='queries[0].query.params["filter"]'
        else:
            a=action(ctx); a["input"]={"note":text}; spec=child_spec(node("SubmitButton",actions={"onClick":a})); path='componentsTree[0].children[0].actions["onClick"].input["note"]'
        bad("string-code-"+name,spec,path,code,stage="structure",group="V13")
    for text in ["SQL 和 GraphQL 的概念说明", "忽略指令只是文字", "函数 function 的说明"]:
        add("description-text-"+str(len(result)),view(ctx,meta={"description":text}),group="V14")
    # A dictionary key is not an executable property; it names plain i18n text.
    add("i18n-code-words-are-keys",view(ctx,i18n={"zh-CN":{"css":"样式说明","sql":"SQL说明","type":"JSExpression"}}),group="V06")
    changed=deepcopy(ctx); registry=asset_for(changed,"COMPONENT_REGISTRY")
    registry["content"]["components"][0]["version"]=2
    registry["ref"]["digest"]=digest(registry["content"])
    spec=view(changed)
    add("component-version-independent-of-snapshot",spec,context=changed)
    for mutation in ["version","missing-output","missing-error","tamper-content"]:
        changed=deepcopy(ctx); cap=asset_for(changed,"CAPABILITY","form.submit")
        snapshot=asset_for(changed,"CAPABILITY_REGISTRY")
        if mutation=="version": snapshot["content"]["version"]=2
        elif mutation=="missing-output": del cap["content"]["outputSchema"]
        elif mutation=="missing-error": del cap["content"]["errorSchema"]
        else: cap["content"]["category"]="QUERY"
        if mutation in ["missing-output","missing-error"]:
            cap["ref"]["digest"]=digest(cap["content"])
            snapshot["content"]["members"]=[deepcopy(cap["ref"]) if m["capability_code"]=="form.submit" else m for m in snapshot["content"]["members"]]
        snapshot["ref"]["digest"]=digest(snapshot["content"])
        changed["view"]["capability_registry_ref"]=deepcopy(snapshot["ref"])
        a=action(changed); spec=child_spec(node("SubmitButton",actions={"onClick":a}))
        bad("capability-asset-"+mutation,spec,'componentsTree[0].children[0].actions["onClick"].actionRef',"VIEW_CAPABILITY_DIGEST_MISMATCH" if mutation=="tamper-content" else "VIEW_CAPABILITY_REF_INVALID",context=changed,group="V08")
    spec=view(ctx); spec["businessSchemaRef"]["version"]=2
    bad("business-version-unresolved",spec,"businessSchemaRef","VIEW_REFERENCE_VERSION_CONFLICT",group="V05")
    for path_name in ["root","node","query"]:
        spec=view(ctx)
        if path_name=="root": spec["extra"]=True; path="extra"
        if path_name=="node": spec["componentsTree"][0]["extra"]=True; path="componentsTree[0].extra"
        if path_name=="query": spec["queries"]=[dict(query_code="items_query",query=query(ctx),extra=True)]; path="queries[0].extra"
        bad("closed-object-"+path_name,spec,path,"UNKNOWN_PROPERTY",stage="structure",group="V10")
    for kind in ["JSExpression","JSFunction"]:
        spec=view(ctx,i18n={"zh-CN":{"message":{"type":kind,"value":"fake"}}})
        bad("i18n-executable-object-"+kind,spec,'i18n["zh-CN"]["message"]',"VIEW_RAW_CODE_FORBIDDEN",stage="structure",group="V13")
    changed=deepcopy(ctx); snapshot=asset_for(changed,"CAPABILITY_REGISTRY")
    next(m for m in snapshot["content"]["members"] if m["capability_code"]=="form.submit")["digest"]="sha256:"+"0"*64
    snapshot["ref"]["digest"]=digest(snapshot["content"]); changed["view"]["capability_registry_ref"]=deepcopy(snapshot["ref"])
    bad("snapshot-member-digest",child_spec(node("SubmitButton",actions={"onClick":action(ctx)})),'componentsTree[0].children[0].actions["onClick"].actionRef',"VIEW_CAPABILITY_DIGEST_MISMATCH",context=changed,group="V08")
    for length in [0,1,80,81]:
        spec=view(ctx); spec["name"]="😀"*length
        add("name-length-"+str(length),spec,[] if length in [1,80] else [("CONTRACT_SHAPE_INVALID","name")],stage="structure",group="V01")
    for length in [2,3,64,65]:
        spec=view(ctx); spec["view_code"]="a"*length
        add("code-length-"+str(length),spec,[] if length in [3,64] else [("CONTRACT_SHAPE_INVALID","view_code")],stage="structure",group="V01")
    for length in [2,3,128,129]:
        spec=view(ctx); spec["componentsTree"][0]["id"]="n"*length
        add("node-id-length-"+str(length),spec,[] if length in [3,128] else [("CONTRACT_SHAPE_INVALID","componentsTree[0].id")],stage="structure",group="V03")
    for length in [1,2,64,65]:
        spec=view(ctx); spec["componentsTree"][0]["componentName"]="A"*length
        add("component-name-length-"+str(length),spec,[] if length in [2,64] else [("CONTRACT_SHAPE_INVALID","componentsTree[0].componentName")],stage="structure",group="V04")
    for columns in [1,4,5,0]:
        spec=child_spec(node("Section",props=dict(columns=columns)))
        add("fake-columns-"+str(columns),spec,[] if columns in [1,4] else [("VIEW_PROP_INVALID",'componentsTree[0].children[0].props["columns"]')],group="V04")
    return result
