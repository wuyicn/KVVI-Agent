#!/usr/bin/env python3
"""Run unit/tool faults once; full CLI corpus is collected separately."""
import io
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent


def suite():
    loader = unittest.TestLoader()
    result = unittest.TestSuite()
    for path in sorted(ROOT.glob('test_*.py')):
        if path.name != 'test_conformance.py': result.addTests(loader.loadTestsFromName(path.stem))
    return result


def method_ids(tests):
    for item in tests:
        if isinstance(item,unittest.TestSuite): yield from method_ids(item)
        else: yield item.id()


def main():
    tests=suite(); methods=list(method_ids(tests))
    if '--list' in sys.argv: print(json.dumps(methods)); return 0
    output=io.StringIO()
    result=unittest.TextTestRunner(stream=output,verbosity=1).run(tests)
    payload={'methods':methods,'tests_run':result.testsRun,'failures':[t.id() for t,_ in result.failures],
             'errors':[t.id() for t,_ in result.errors],'skipped':[t.id() for t,_ in result.skipped], 'log':output.getvalue()}
    print(json.dumps(payload));return 0 if result.wasSuccessful() else 1


if __name__ == '__main__': raise SystemExit(main())
