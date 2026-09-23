#!/usr/bin/env python3
"""Explicit authoring operation: freeze literal cases and audit mappings, never CLI results.

Not run by CI. Review changes to these independent inventories with the fixture source.
Seed: 0 (deterministic enumeration; no random generation).
"""
import hashlib
import json
from pathlib import Path
import run_unit_checks

ROOT=Path(__file__).resolve().parents[2]
DEST=Path(__file__).resolve().parent
TYPES=('short_text','long_text','boolean','integer','decimal','money','date','datetime','single_select','multi_select')


def main():
    cases=json.loads((DEST/'0a-core-r1/cases.json').read_text())['cases']
    by_id={c['id']:c for c in cases}
    def select(prefix):return [c['id'] for c in cases if c['id'].startswith(prefix)]
    def units(*names):return ['unit:'+name for name in names]
    coverage={}
    trace=ROOT/'docs/superpowers/specs/2026-09-08-0a-meta-schema-core-traceability.md'
    for line in trace.read_text().splitlines():
        parts=[s.strip() for s in line.split('|')]
        if len(parts)<6 or len(parts[1])!=3 or parts[1][0] not in 'CBVAE' or not parts[1][1:].isdigit():continue
        group=parts[1]
        if group in {'B16','V15','A08','E04'}:continue
        coverage[group]={'scope':parts[3], 'positive':[c['id'] for c in cases if group in c['groups'] and c['expected']['valid']], 'negative':[c['id'] for c in cases if group in c['groups'] and not c['expected']['valid']]}
    def attach(group, refs):
        for ref in refs:
            branch='positive' if by_id[ref]['expected']['valid'] else 'negative'
            if ref not in coverage[group][branch]:coverage[group][branch].append(ref)
    for group,prefixes in {'B06':['B-short_text-length-','B-text-min-max','B-pattern-','B-unicode-length-'], 'B07':['B-long_text-length-','B-long-default-over-effective'], 'B08':['B-integer-','B-negative-bound-integer'], 'B09':['B-decimal-'], 'B10':['B-money-'], 'B11':['B-date-','B-datetime-'], 'B12':['B-options-'], 'B13':['B-multi-'], 'B17':['B-type-'], 'V05':['V-component-ShortTextField'], 'V12':['V-loop-max-','V-extended-bindings-'], 'V13':['V-description-is-data'], 'C09':['B-description-plain-instructions','V-description-is-data','B-description-html']}.items():
        for prefix in prefixes:attach(group,select(prefix))
    coverage['C04']['positive']+=units('test_bundle.SharedDefinitionTests.test_asset_ref_accepts_exact_eight_keys_with_explicit_nulls')
    coverage['C04']['negative']+=units('test_bundle.SharedDefinitionTests.test_asset_ref_rejects_each_missing_key_at_the_property_path','test_bundle.SharedDefinitionTests.test_asset_ref_rejects_zero_latest_and_uppercase_digest','test_bundle.SharedDefinitionTests.test_asset_ref_rejects_unknown_key_before_generic_shape_errors')
    coverage['C05']['positive']+=units('test_bundle.SharedDefinitionTests.test_capability_ref_replaces_asset_id_without_widening_shape')
    coverage['C05']['negative']+=units('test_bundle.SharedDefinitionTests.test_capability_ref_rejects_each_missing_key_at_the_property_path','test_bundle.SharedDefinitionTests.test_capability_ref_replaces_asset_id_without_widening_shape')
    coverage['C08']['positive']+=units('test_business.BusinessTests.test_frozen_business_expectations_and_in_memory_immutability','test_view.ViewTests.test_frozen_view_expectations_and_in_memory_immutability')
    coverage['C10']['positive']+=units('test_bundle.BundleIntegrityTests.test_manifest_bound_bundle_self_checks_offline')
    coverage['C10']['negative']+=units('test_delivery.ActualLoaderFaultTests.test_actual_loaders_reject_hash_rebound_unused_invalid_definitions','test_delivery.ActualLoaderFaultTests.test_actual_loaders_reject_manifest_source_dialect_json_and_path_faults','test_delivery.ActualLoaderFaultTests.test_real_clis_fail_execution_for_rebound_invalid_unused_bundle')
    coverage['C10']['positive']+=units('test_integration.Integration.test_unused_registry_definitions_are_checked_at_every_schema_boundary')
    coverage['C10']['negative']+=units('test_integration.Integration.test_unused_registry_definitions_are_checked_at_every_schema_boundary','test_delivery.ActualLoaderFaultTests.test_trusted_registry_actual_parsers_reject_unused_invalid_definitions')
    coverage['C05']['positive']+=units('test_delivery.InvocationResourceTests.test_projection_reuse_is_exact_schema_scoped_and_expires_with_invocation','test_delivery.InvocationResourceTests.test_reused_annotation_probe_recomputes_each_instances_evaluated_keys')
    coverage['E03']['positive']+=units('test_evidence.EvidenceFaultTests.test_toolchain_collects_all_locked_actual_dependencies','test_evidence.EvidenceFaultTests.test_toolchain_dependency_shape_and_source_locked_versions_are_strict','test_evidence.EvidenceFaultTests.test_toolchain_uses_source_lock_versions_not_current_installations','test_evidence.EvidenceFaultTests.test_full_report_rejects_version_tampering_even_with_recomputed_checksum')
    coverage['E03']['negative']+=units('test_evidence.EvidenceFaultTests.test_toolchain_dependency_shape_and_source_locked_versions_are_strict','test_evidence.EvidenceFaultTests.test_toolchain_uses_source_lock_versions_not_current_installations','test_evidence.EvidenceFaultTests.test_collector_rejects_actual_dependency_version_drift','test_evidence.EvidenceFaultTests.test_full_report_rejects_version_tampering_even_with_recomputed_checksum')
    attach('E01',['C02-app-compiled-empty-valid','I-three-contract-closed'])
    for group,method in [('E02','test_evidence.EvidenceFaultTests.test_case_result_and_language_inventory_faults_fail'),('E03','test_evidence.EvidenceFaultTests.test_bindings_reject_each_changed_class_and_stale_source')]:
        for branch in ('positive','negative'):coverage[group][branch]+=units(method)
    coverage['E03']['negative']+=units('test_evidence.EvidenceFaultTests.test_run_refuses_overwrite_and_escape')
    for group in ('B23','V16'):
        coverage[group]['negative_not_applicable']='本行是原文转换与Fake重绑两个正向示例；反例由所属结构、语义及引用条款单独验收，不能编造示例反例。'
    for group,boundary in {
        'C03':'登记外壳形状和Fake快照绑定不证明真实身份、认证来源或服务端版本分配。',
        'C07':'本批仅验证Fake正文摘要、稳定身份和历史对照；真实注册分配和不可变存储仍属后续运行时。',
        'C08':'本批验证首失败阶段、诊断和输入不变性；真实编译、预览、授权和发布服务尚未接入。',
        'C09':'本批自然语言作为字符串数据及结构禁执行形状；真实AI工具指令隔离与服务端秘密扫描仍属运行时。实际本地Gitleaks记录另列作者验证文档。',
        'B22':'本批仅消费Fake历史和使用扫描证据进行静态兼容判断；未执行真实迁移、数据扫描或迁移批准。',
        'A07':'本批仅Fake引用完整元组及快照匹配；真实ArtifactManifest注册、授权及发布责任仍待后续实现。',
    }.items():coverage[group]['runtime_boundary']=boundary
    # Every named witness is a literal case; machine inventory is an audit aid, not proof of R behavior.
    closed={
        'common AssetRef':units('test_bundle.SharedDefinitionTests.test_asset_ref_rejects_unknown_key_before_generic_shape_errors'),
        'common CapabilityRef':units('test_bundle.SharedDefinitionTests.test_capability_ref_replaces_asset_id_without_widening_shape'),
        'common Audit':['C03-app-audit-unknown-property'],
        'Business CompiledDraft':['T5-closed-business-draft'], 'View CompiledDraft':['T5-closed-view-draft'], 'App CompiledDraft':['T5-closed-app-root'],
        'Business RegisteredContract':['T5-registered-schema_id-unknown'], 'View RegisteredContract':['T5-registered-view_id-unknown'],
        'App RegisteredContract':units('test_bundle.EnvelopeShapeTests.test_registered_base_is_shared_and_unclosed_until_final_entry'),
        'Business Spec':select('B-unknown-control-'), 'App Spec':['T5-closed-app-spec'], 'App Route':['T5-closed-app-route'],
        'Business money default':['B-money-unknown-default'], 'Business LayoutItem description':['T5-closed-description-layout-item'],
        'View meta':['V-meta-permission'],
        'View registered props and action/query parameters':select('V-unknown-prop')+select('I-r4-query-wrong-member-shape')+select('I-r4-action-wrong-member-shape'),
    }
    for case in cases:
        if case['id'].startswith(('B-closed-','V-extended-closed-','T5-expr-branch-')) and not case['expected']['valid']:closed[case['id']]=[case['id']]
    for kind in TYPES:
        for location in ('constraints','type_config'):closed['Business '+kind+' '+location]=['B-unknown-'+kind+'-'+location]
    boundaries={
        'safe integers +/-9007199254740991':select('T5-safe-integer-')+['T5-raw-out-of-range'],
        'nonnegative base 0/max/-1':select('T5-base-version-'), 'positive reference version 1/max/0':select('T5-ref-version-'),
        'stable ID nonempty':select('T5-stable-id-length-'), 'digest 71 chars':select('T5-ref-digest-length-'), 'audit trace nonempty':select('T5-trace-length-'),
        'business name 1..80':select('T5-business-name-length-')+select('B-root-name-'), 'business description 500':select('B-root-description-'),
        'business machine code 3..64':select('B-schema-code-'), 'field machine code 3..64':select('T5-field-code-')+select('B-field-code-'), 'field label 1..80':select('B-field-label-')+select('T5-field-label-'), 'field description 300':select('B-field-description-'),
        'field count 1..100':select('B-fields-'), 'index count 20':select('B-indexes-'), 'rule count 50':select('B-record_rules-'),
        'short text length 1..255':select('B-short_text-length-'), 'short min length 0..255':select('T5-short-min-length-'), 'long text length 1..20000':select('B-long_text-length-'),
        'pattern length 200':select('T5-pattern-length-'), 'decimal precision 1..38':select('T5-decimal-precision-'), 'decimal scale 0..12':select('T5-decimal-scale-'),
        'single options 1..200':select('B-options-'), 'multi options 1..200':select('T5-multi-options-'), 'multi maximum 1..50 and default 20':select('B-multi-limit-')+['B-multi-default-21','T5-multi-max-zero'],
        'section count 20':select('B-sections-'), 'section columns 1..4':select('B-layout-columns-')+['T5-columns-zero'], 'field col_span 1..4':select('T5-col-span-'),
        'index fields 1..4':select('B-index-fields-')+['B-index-empty-fields','T5-index-one-field'], 'record number label string without inherited length bounds':select('T5-record-number-label-')+select('FX2-number-label-'),
        'business all/any nonempty':['B-rule-shape-213','T5-expr-any-empty','T5-expr-branch-2-positive','T5-expr-branch-3-positive'],
        'business predicates 20 and depth 3':select('B-rule-20')+select('B-rule-21')+select('B-rule-depth-'),
        'View roots exactly 1':select('V-roots-')+['V-shape-page-FORM'], 'View nodes 500':select('V-nodes-')+['T5-complete-500-nodes'], 'View depth 20':select('V-depth-'),
        'View UTF8 spec bytes 1048576':select('V-bytes-'), 'View name 1..80':select('V-extended-name-length-'),
        'View id 3..128':select('V-extended-node-id-length-'), 'FieldRef nonempty':select('T5-fieldref-length-'), 'I18nRef key 1..128':select('T5-i18n-ref-key-'),
        'i18n dictionary key 128/value 5000':select('V-i18n-key-')+select('V-i18n-value-'), 'queries 20':select('V-queries-'),
        'View all/any nonempty':select('T5-view-expr-'), 'View predicates 20/depth 3':select('V-predicates-')+select('V-expression-depth-'),
        'DataBinding itemKey nonempty':select('T5-binding-itemkey-length-'), 'DataBinding maxItems 1..200':select('V-loop-max-'), 'Fake query pageSize 1..200':select('V-extended-query-page-size-'),
        'App name 1..80':select('T5-app-name-'), 'App automation/integration empty':['I-empty-closed','I-reserved-automationRefs','I-reserved-integrationRefs'],
        'App and route codes 3..64':select('T5-app-app_code-')+select('T5-app-route_code-'),
        'View and query codes 3..64':select('T5-view-view_code-')+select('T5-view-query_code-'),
        'option stable code 1..64':select('B-option-code-'),
    }
    audit={'closed_positions':closed,'boundaries':boundaries,'field_types':{kind:['B-type-'+kind,'B-wrong-default-'+kind] for kind in TYPES},'page_types':{kind:['V-page-'+kind,'V-shape-page-'+kind] for kind in ('FORM','LIST','DETAIL')},
           'error_codes':{code:[c['id'] for c in cases if any(e['code']==code for e in c['expected']['errors'])] for code in sorted({e['code'] for c in cases for e in c['expected']['errors']})},
           'excluded_runtime_only':['B16','V15','A08','E04']}
    all_refs=[ref for group in (closed,boundaries,audit['field_types'],audit['page_types'],audit['error_codes']) for refs in group.values() for ref in refs]
    methods=list(run_unit_checks.method_ids(run_unit_checks.suite()))
    assert all(ref in by_id or ref.startswith('unit:') and ref[5:] in methods for ref in all_refs)
    assert all(boundaries.values())
    inventory={'cases':[{'id':c['id'],'sha256':hashlib.sha256(json.dumps(c,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()} for c in cases],'unit_methods':methods}
    for name,value in [('expected-inventory.json',inventory),('coverage.json',coverage),('coverage-audit.json',audit)]:
        (DEST/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'cases':len(cases),'unit_methods':len(methods),'groups':len(coverage),'closed_positions':len(closed),'boundaries':len(boundaries),'error_codes':len(audit['error_codes'])}))


if __name__=='__main__':main()
