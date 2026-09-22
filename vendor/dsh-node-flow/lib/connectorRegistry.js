import { BUILTIN_CONNECTORS } from './builtinConnectors.js';
import { ConnectorRegistry } from './connectorSdk.js';
const REGISTRY_SYMBOL = Symbol.for('dsh-node-flow.connector-registry.v3');
const sharedGlobal = globalThis;
export const connectorRegistry = sharedGlobal[REGISTRY_SYMBOL] ??= new ConnectorRegistry(BUILTIN_CONNECTORS);
export function registerConnector(definition) {
    return connectorRegistry.register(definition);
}
export * from './connectorSdk.js';
export { BUILTIN_CONNECTORS } from './builtinConnectors.js';
