'use strict'

function installForgeArgumentCodecs (codecs) {
  codecs.register('argument', 'forge:modid', 'void')
  codecs.register('argument', 'forge:enum', ['container', [{ name: 'enumClass', type: 'string' }]])
}

module.exports = { installForgeArgumentCodecs }
