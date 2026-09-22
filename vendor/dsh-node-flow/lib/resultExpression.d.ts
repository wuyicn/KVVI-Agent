export declare function parseResultValue(value: unknown): unknown;
export declare function evaluateResultExpression(expression: string, value: unknown, variables?: Record<string, unknown>): unknown;
export declare function renderResultTemplate(template: string, value: unknown, variables?: Record<string, unknown>): string;
export declare function renderResultJsonTemplate(template: string, value: unknown, variables?: Record<string, unknown>): string;
export declare function resultPathExpression(path: Array<string | number>): string;
export declare function resultTemplateToken(path: Array<string | number>): string;
