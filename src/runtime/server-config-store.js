'use strict'

const { createHash } = require('node:crypto')

const MAX_CONFIG_FILES = 32
const MAX_CONFIG_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 4 * 1024 * 1024

/**
 * Stores server-synchronized Forge config files as opaque bytes in memory.
 * It deliberately does not write to disk, parse TOML/JSON, or execute Mod code.
 */
class ServerConfigStore {
  constructor () {
    this._files = new Map()
    this._version = 0
    this.events = []
  }

  install (details, messageId = null) {
    if (!details || typeof details.fileName !== 'string' ||
        details.fileName.length < 1 || details.fileName.length > 512 ||
        /[\u0000-\u001f\u007f]/.test(details.fileName) ||
        details.fileName.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(details.fileName) ||
        details.fileName.split(/[\\/]/).some(part => part === '..')) {
      throw new Error('invalid_server_config_name')
    }
    if (!Buffer.isBuffer(details.data)) throw new Error('invalid_server_config_data')
    if (details.data.length > MAX_CONFIG_BYTES) throw new Error('server_config_size_limit')
    if (details.dataBytes !== undefined && details.dataBytes !== details.data.length) throw new Error('server_config_length_mismatch')

    const previous = this._files.get(details.fileName)
    const currentBytes = [...this._files.values()].reduce((sum, item) => sum + item.data.length, 0)
    const nextBytes = currentBytes - (previous?.data.length || 0) + details.data.length
    if (!previous && this._files.size >= MAX_CONFIG_FILES) throw new Error('server_config_count_limit')
    if (nextBytes > MAX_TOTAL_BYTES) throw new Error('server_config_total_size_limit')

    const data = Buffer.from(details.data)
    const sha256 = createHash('sha256').update(data).digest('hex')
    if (details.sha256 && details.sha256 !== sha256) throw new Error('server_config_digest_mismatch')

    this._files.set(details.fileName, { data, sha256, messageId })
    this._version++
    const receipt = {
      fileName: details.fileName,
      status: 'stored-opaque-in-memory',
      stored: true,
      appliedToModRuntime: false,
      dataBytes: data.length,
      sha256,
      messageId
    }
    this.events.push({ type: 'stored', ...receipt })
    if (this.events.length > 64) this.events.shift()
    return receipt
  }

  get (fileName) {
    const item = this._files.get(fileName)
    return item ? Buffer.from(item.data) : null
  }

  getReport () {
    return {
      fileCount: this._files.size,
      totalBytes: [...this._files.values()].reduce((sum, item) => sum + item.data.length, 0),
      version: this._version,
      files: [...this._files].map(([fileName, item]) => ({
        fileName,
        dataBytes: item.data.length,
        sha256: item.sha256,
        messageId: item.messageId
      })),
      appliedToModRuntime: false,
      persistedToDisk: false,
      events: this.events.slice(-32)
    }
  }
}

module.exports = { ServerConfigStore, MAX_CONFIG_FILES, MAX_CONFIG_BYTES, MAX_TOTAL_BYTES }
