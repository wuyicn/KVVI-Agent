import type { CredentialKind, CredentialSummary, OAuth2ClientAuth } from './model.js';
import { type OAuth2Config } from './oauth2.js';
export type OAuth2CredentialSecret = {
    clientSecret?: string;
    accessToken?: string;
    refreshToken?: string;
    tokenType?: string;
    tokenScope?: string;
};
export type CredentialSecret = {
    value: string;
} | {
    username: string;
    password: string;
} | OAuth2CredentialSecret;
export type CredentialInput = {
    id?: string;
    name: string;
    kind: CredentialKind;
    headerName?: string;
    testUrl?: string;
    authorizationUrl?: string;
    tokenUrl?: string;
    clientId?: string;
    scopes?: string;
    clientAuth?: OAuth2ClientAuth;
    usePkce?: boolean;
    extraAuthParams?: string;
    extraTokenParams?: string;
    secret?: CredentialSecret;
};
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export declare function listCredentialSummaries(dataDirectory: string): CredentialSummary[];
export declare function saveCredential(dataDirectory: string, input: CredentialInput): CredentialSummary;
export declare function deleteCredential(dataDirectory: string, id: string): boolean;
export declare function getOAuthAuthorizationConfig(dataDirectory: string, id: string): {
    summary: CredentialSummary;
    config: OAuth2Config;
    updatedAt: string;
};
export declare function markCredentialAuthorizing(dataDirectory: string, id: string): CredentialSummary;
export declare function markCredentialAuthorizationFailed(dataDirectory: string, id: string, message: string): CredentialSummary;
export declare function cancelCredentialAuthorization(dataDirectory: string, id: string): CredentialSummary;
export declare function exchangeOAuthAuthorizationCode(dataDirectory: string, id: string, code: string, redirectUri: string, verifier: string | undefined, expectedUpdatedAt: string, fetcher?: Fetcher): Promise<CredentialSummary>;
export declare function resolveCredentialHeaders(dataDirectory: string, id: string, fetcher?: Fetcher, forceRefresh?: boolean): Promise<Record<string, string> | undefined>;
export declare function resolveWebhookSecret(dataDirectory: string, id: string): string;
export declare function testCredentialConnection(dataDirectory: string, id: string, fetcher?: Fetcher): Promise<CredentialSummary>;
export {};
