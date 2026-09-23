#!/usr/bin/env python3
"""Materialize independent inputs/oracles; never reads validator outputs."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path

from view_cases import cases
from view_cases_extended import cases as extended_cases
from view_fixtures import fixture_context, asset_for
from integration_fixtures import close_context

DEST=Path(__file__).with_name("0a-core-r1")


def dump(value):
    return json.dumps(value,ensure_ascii=False,indent=2)+"\n"


def write(path,value):
    (DEST/path).write_text(dump(value),encoding="utf-8")


def main():
    table=json.loads((DEST/"cases.json").read_text())
    table["cases"]=[c for c in table["cases"] if c.get("generated_by")!="generate_view_fixtures.py"]
    def register(case,entry="spec"):
        case=deepcopy(case)
        if case['stage']!='structure':case['spec'],case['context']=close_context(case['spec'],case['context'],'VIEW_SCHEMA',entry)
        identifier=case["id"]
        input_path="inputs/view-"+identifier+".json"
        context_path="contexts/view-"+hashlib.sha256(dump(case["context"]).encode()).hexdigest()[:16]+".json"
        checks="structure" if case["stage"]=="structure" else "complete"
        errors=[dict(code=code,severity="ERROR",path=path) for code,path in case["expected"]]
        pending=checks=="complete" and not errors
        item=dict(id="V-"+identifier,groups=[case["group"],"View"],input=input_path,
                  contract="view-schema/lce-safe-v1",entry=entry,checks=checks,generated_by="generate_view_fixtures.py",
                  expected_stage="complete" if pending else case["stage"],
                  expected=dict(suite_revision="0a-core-r1",entry=entry,checks=checks,exit_code=2 if errors else 0,valid=not errors,errors=errors))
        if checks=="complete":
            write(context_path,case["context"]); item["context"]=context_path
        if pending:
            item.update(coverage_status="complete-fixed-fake")
        write(input_path,case["spec"])
        table["cases"].append(item)
    corpus=cases()+extended_cases()
    for case in corpus: register(case)
    original=json.loads((DEST/"inputs/view-prd-7-25-original.json").read_text())
    context=fixture_context(include_all_types=False)
    rebound=deepcopy(original)
    rebound["spec"]["businessSchemaRef"]=deepcopy(asset_for(context,"BUSINESS_SCHEMA")["ref"])
    rebound["spec"]["componentRegistryRef"]=deepcopy(asset_for(context,"COMPONENT_REGISTRY")["ref"])
    rebound["spec"]["componentsTree"][0]["children"][1]["actions"]["onClick"]["actionRef"]=deepcopy(asset_for(context,"CAPABILITY","form.submit")["ref"])
    rebound,context=close_context(rebound,context,'VIEW_SCHEMA','compiled-draft')
    write("inputs/view-prd-7-25-fake.json",rebound)
    write("contexts/view-prd-7-25-fake.json",context)
    register(dict(id="prd-7-25-structure",spec=original,context=context,expected=[],stage="structure",group="V16"),"compiled-draft")
    register(dict(id="prd-7-25-fake-complete",spec=rebound,context=context,expected=[],stage="semantic",group="V16"),"compiled-draft")
    write("cases.json",table)
    print(json.dumps(dict(view_static_cases=len(corpus),view_source_examples=2,shared_cli_cases=len(table["cases"]))))


if __name__=="__main__": main()
