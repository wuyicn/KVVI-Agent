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
   3 AssertionError: expected '- dialog "设置":\n  - navigation:\n    …' to be '- dialog "�
   1 TimeoutError: locator.waitFor: Timeout 15000ms exceeded.
   1 TimeoutError: locator.evaluate: Timeout 30000ms exceeded.
   1 Serialized Error: { log: [] }
   1 If this is a long-running test, pass a timeout value as the last argument or configure it 
```
