'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  extractStatusEvidence, extractBrand, extractRegisterChannels,
  extractLoginRequest, detectFmlHandshakeMarker
} = require('../src/diagnostics/forge-evidence')

test('Forge status evidence only captures bounded metadata', () => {
  assert.deepEqual(extractStatusEvidence({
    version: { name: '1.20.1', protocol: 763 }, description: { text: 'sensitive' },
    forgeData: { fmlNetworkVersion: 3, mods: [{ modId: 'x' }], channels: [{ name: 'x:y' }] }
  }), {
    queried: true, reportsForgeData: true, reportsModInfo: false,
    fmlNetworkVersion: 3, modsCount: 1, channelsCount: 1,
    minecraftProtocol: 763, versionName: '1.20.1'
  })
})
test('brand parsing handles VarInt string and rejects bad lengths', () => {
  assert.equal(extractBrand(Buffer.from([5, 102, 111, 114, 103, 101])), 'forge')
  assert.equal(extractBrand(Buffer.from([100, 102, 111, 114, 103, 101])), null)
})
test('register channel list is filtered to valid identifiers', () => {
  assert.deepEqual(extractRegisterChannels(Buffer.from('forge:main\0minecraft:brand\0BAD VALUE\0')), ['forge:main', 'minecraft:brand'])
})
test('login packet metadata retained without raw bytes', () => {
  const packet = {
    direction: 'inbound', phase: 'login', name: 'login_plugin_request',
    data: { messageId: 2, channel: 'fml:loginwrapper', data: Buffer.from('should not be reported') }
  }
  assert.deepEqual(extractLoginRequest(packet), {
    direction: 'inbound', packetName: 'login_plugin_request', channel: 'fml:loginwrapper',
    messageId: 2, payloadBytes: 22
  })
  assert.equal(extractLoginRequest({ ...packet, phase: 'play' }), null)
})
test('handshake FML marker check does not expose host', () => {
  assert.equal(detectFmlHandshakeMarker({ serverHost: 'private.example.test\0FML2\0' }), true)
  assert.equal(detectFmlHandshakeMarker({ serverHost: 'private.example.test' }), false)
})
