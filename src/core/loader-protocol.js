'use strict'

// Protocol modules own loader wire differences. Choosing an extension point
// does not imply support for other loaders or authorize fabricated Mod claims.
function createLoaderProtocol (runtime, selection = 'forge') {
  const definition = selection === 'forge' ? require('../loaders/forge') : selection
  if (!definition || typeof definition !== 'object' || definition.apiVersion !== 1 ||
      !/^[a-z][a-z0-9_.-]{0,63}$/.test(definition.id || '') || typeof definition.create !== 'function') {
    throw new Error('unsupported_loader_protocol: supply a versioned protocol module; only Forge is bundled')
  }
  const module = definition.create(runtime)
  if (!module || module.id !== definition.id || module.apiVersion !== 1 || typeof module.destroy !== 'function') {
    module?.destroy?.()
    throw new Error('invalid_loader_protocol_instance')
  }
  return module
}

module.exports = { createLoaderProtocol }
