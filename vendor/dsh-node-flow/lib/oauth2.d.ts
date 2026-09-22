import type { OAuth2ClientAuth } from './model.js';
export type OAuth2Config = {
    authorizationUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    scopes?: string;
    clientAuth?: OAuth2ClientAuth;
    usePkce?: boolean;
    extraAuthParams?: string;
    extraTokenParams?: string;
};
export type OAuthTokenSet = {
    accessToken: string;
    refreshToken?: string;
    tokenType: string;
    expiresAt?: string;
    scope?: string;
};
export type OAuthTokenRequest = {
    url: string;
    headers: Record<string, string>;
    body: string;
};
export declare function validateOAuthUrl(value: string, label: string): string;
export declare function validateOAuthConfig(config: OAuth2Config): OAuth2Config;
export declare function parseOAuthParams(source: string | undefined, reserved: Set<string>, label: string): Record<string, string>;
export declare function createPkceVerifier(): string;
export declare function pkceChallenge(verifier: string): string;
export declare function hashOAuthState(state: string): string;
export declare function buildAuthorizationUrl(config: OAuth2Config, redirectUri: string, state: string, verifier?: string): string;
export declare function buildAuthorizationCodeRequest(config: OAuth2Config, code: string, redirectUri: string, verifier?: string): OAuthTokenRequest;
export declare function buildRefreshTokenRequest(config: OAuth2Config, refreshToken: string): OAuthTokenRequest;
export declare function parseTokenResponse(source: string, contentType: string | null, previousRefreshToken?: string): OAuthTokenSet;
