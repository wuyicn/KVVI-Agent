import { BUILTIN_CONNECTORS } from './builtinConnectors.js'
import { ConnectorRegistry, type ConnectorDefinition } from './connectorSdk.js'

const REGISTRY_SYMBOL = Symbol.for('dsh-node-flow.connector-registry.v3')
type RegistryGlobal = typeof globalThis & { [REGISTRY_SYMBOL]?: ConnectorRegistry }
const sharedGlobal = globalThis as RegistryGlobal

export const connectorRegistry = sharedGlobal[REGISTRY_SYMBOL] ??= new ConnectorRegistry(BUILTIN_CONNECTORS)

export function registerConnector(definition: ConnectorDefinition): () => void {
  return connectorRegistry.register(definition)
}

export * from './connectorSdk.js'
export { BUILTIN_CONNECTORS } from './builtinConnectors.js'
