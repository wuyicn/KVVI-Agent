#!/usr/bin/env node
/** Node black-box entry for the 0A core Meta-Schema suite. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { diagnostic } from "./diagnostics.mjs";
import { validateReferences } from "./references.mjs";
import { validateSemantic } from "./semantic.mjs";
import { BundleLoadError, validateStructure, bundleSession } from "./structure.mjs";
import { parseContext, ContextInvalid, RegistryConfigurationInvalid, boundContext } from './context.mjs';


const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const C14N = join(ROOT, "protocol/kvvi-json-c14n/v1/evidence-sets/prd-v1.11/node/kvvi-json-c14n.mjs");
const CONTRACTS = new Set(["business-schema/v1", "view-schema/lce-safe-v1", "app-spec/v1alpha1"]);
const ENTRIES = new Set(["compiled-draft", "spec", "registered"]);
const CHECKS = new Set(["structure", "complete"]);
const PROCESS_MAX_BUFFER = 16 * 1024 * 1024;


function argumentsFrom(argv) {
  const result = {};
  const known = new Set(["contract", "entry", "checks", "context"]);
  if (argv.length % 2 !== 0) throw new Error("invalid arguments");
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith("--") || argv[index + 1] === undefined) throw new Error("invalid arguments");
    const key = argv[index].slice(2);
    if (!known.has(key) || Object.hasOwn(result, key)) throw new Error("invalid arguments");
    result[key] = argv[index + 1];
  }
  if (!CONTRACTS.has(result.contract) || !ENTRIES.has(result.entry) || !CHECKS.has(result.checks)) throw new Error("invalid arguments");
  return result;
}


function processTimeoutMs() {
  const parsed = Number.parseInt(process.env.KVVI_META_INTERNAL_TIMEOUT_MS ?? "10000", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 10000;
}


function emitExecutionFailure(code, raw = null, entry = null, checks = null) {
  const payload = {
    suite_revision: "0a-core-r1",
    execution: { status: "failed", code },
    release_approved: false,
  };
  if (raw !== null) payload.input_sha256 = createHash("sha256").update(raw).digest("hex");
  if (entry !== null) payload.entry = entry;
  if (checks !== null) payload.checks = checks;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  return 1;
}


function emit(raw, entry, checks, errors, stage) {
  const payload = {
    suite_revision: "0a-core-r1",
    entry,
    checks,
    stage,
    input_sha256: createHash("sha256").update(raw).digest("hex"),
    validation: { valid: errors.length === 0, errors },
    release_approved: false,
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  return errors.length === 0 ? 0 : 2;
}


function main() {
  let args;
  try {
    args = argumentsFrom(process.argv.slice(2));
  } catch {
    return emitExecutionFailure("CLI_ARGUMENT_INVALID");
  }
  const raw = readFileSync(0);
  try {
    const canonical = spawnSync(process.execPath, [C14N, "--profile", "kvvi-json-c14n/v1"], {
      input: raw,
      maxBuffer: PROCESS_MAX_BUFFER,
      timeout: processTimeoutMs(),
    });
    if (canonical.error?.code === "ETIMEDOUT") return emitExecutionFailure("EXECUTION_TIMEOUT", raw, args.entry, args.checks);
    if (canonical.error) return emitExecutionFailure("CANONICALIZER_EXECUTION_FAILED", raw, args.entry, args.checks);
    if (canonical.status === 2) {
      const code = JSON.parse(canonical.stdout.toString("utf8")).error_code;
      return emit(raw, args.entry, args.checks, [diagnostic(code, "$")], 'canonicalization');
    }
    if (canonical.status !== 0 || canonical.stderr.length) return emitExecutionFailure("CANONICALIZER_EXECUTION_FAILED", raw, args.entry, args.checks);
    const value = JSON.parse(JSON.parse(canonical.stdout.toString("utf8")).canonical);
    let errors = validateStructure(args.contract, args.entry, value);
    if (errors.length) return emit(raw, args.entry, args.checks, errors, 'structure');
    if (args.checks === "complete") {
      let context = null;
      if (args.context) {
        context = parseContext(readFileSync(args.context));
      }
      errors = validateSemantic(args.contract, args.entry, value, context===null?null:boundContext(context,null,args.entry==='registered'));
      if(errors.length) return emit(raw,args.entry,args.checks,errors,'semantic');
      if (!errors.length) errors = validateReferences(args.contract, args.entry, value, context);
      return emit(raw,args.entry,args.checks,errors,errors.length?'references':'complete');
    }
    return emit(raw, args.entry, args.checks, errors, 'structure');
  } catch (error) {
    if(error instanceof ContextInvalid) return emitExecutionFailure('CONTEXT_INVALID',raw,args.entry,args.checks);
    if(error instanceof RegistryConfigurationInvalid) return emitExecutionFailure('REGISTRY_CONFIGURATION_INVALID',raw,args.entry,args.checks);
    if (error instanceof BundleLoadError || error instanceof SyntaxError || error?.code) return emitExecutionFailure("EXECUTION_FAILED", raw, args.entry, args.checks);
    return emitExecutionFailure("EXECUTION_FAILED", raw, args.entry, args.checks);
  }
}


process.exitCode = bundleSession(main);
