import { ConnectorRegistry, type ConnectorDefinition } from './connectorSdk.js';
export declare const connectorRegistry: ConnectorRegistry;
export declare function registerConnector(definition: ConnectorDefinition): () => void;
export * from './connectorSdk.js';
export { BUILTIN_CONNECTORS } from './builtinConnectors.js';
