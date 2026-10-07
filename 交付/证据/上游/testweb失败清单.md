# test:web 失败清单

2026-10-07 从 fork `0e52dcc` 重新整跑：13 失败文件 / 107 通过 / 1 跳过；20 失败 / 410 通过 / 15 跳过。已逐用例归因并修复，修复后完整回归 **431 通过 / 0 失败 / 15 跳过**（120 文件通过 / 1 跳过）。最新结果、反例验证和上游队列时序问题见[本轮归因证据](testweb归因-2026-10-07.md)。

## 历史输出（2026-10-06）

下列 28 条属于旧运行，不能描述当前修订。保留历史内容；原附件含一处截断的 UTF-8 字节 `0xe8`，此处以字面 `\xe8` 显示。

# test:web 失败清单（DSH_SNAPSHOT=replay，2026-10-06）

汇总：Test Files 16 failed | 104 passed | 1 skipped (121)
      Tests 28 failed | 402 passed | 15 skipped (445)

## 失败文件
```
apps/web/tests/agent-preset-authoring.e2e.ts
apps/web/tests/agent-preset-selection.e2e.ts
apps/web/tests/built-boot.expected.e2e.ts
apps/web/tests/command-image-envelope.expected.e2e.ts
apps/web/tests/document-preview.e2e.ts
apps/web/tests/home-path-tilde.expected.e2e.ts
apps/web/tests/image-display.expected.e2e.ts
apps/web/tests/max-tokens-notice.expected.e2e.ts
apps/web/tests/preview-boot.e2e.ts
apps/web/tests/pwa-manifest.e2e.ts
apps/web/tests/queue-actions.e2e.ts
apps/web/tests/search-card.expected.e2e.ts
apps/web/tests/startup-auto-selection.e2e.ts
apps/web/tests/submission-echo.e2e.ts
apps/web/tests/todo-row.expected.e2e.ts
apps/web/tests/trajectory-image-display.expected.e2e.ts
```

## 报错种类统计
```
  15 [cordis-client-runner] syncing inspect providers failed: Error: client api: dynamicCordisR
   7 - Expected
   5 1579|   expect(payload).toBe(await readFile(goldenPath, 'utf8'))
   3 [client-store] subscriber failed: Error: conversation.input: sessions service unavailable
   3 TimeoutError: locator.click: Timeout 30000ms exceeded.
   3 AssertionError: expected '- dialog "设置":\n  - navigation:\n    …' to be '- dialog "\xe8
   1 TimeoutError: locator.waitFor: Timeout 15000ms exceeded.
   1 TimeoutError: locator.evaluate: Timeout 30000ms exceeded.
   1 Serialized Error: { log: [] }
   1 If this is a long-running test, pass a timeout value as the last argument or configure it 
```
