'use strict'

const PAYLOAD_PACKET_PATTERN = /(custom_payload|plugin_message)/i

class ChannelInspector {
  constructor (runtime) {
    this.runtime = runtime
    this._channels = new Map()
  }

  channels () {
    return Array.from(this._channels.values(), channel => ({
      ...channel,
      directions: [...channel.directions]
    }))
  }

  get (id) {
    const channel = this._channels.get(id)
    if (!channel) return undefined
    return { ...channel, directions: [...channel.directions] }
  }

  onRaw (listener) {
    this.runtime.on('payload', listener)
    return () => this.runtime.removeListener('payload', listener)
  }

  onChannel (id, listener) {
    const handler = payload => {
      if (payload.channel === id) listener(payload)
    }
    this.runtime.on('payload', handler)
    return () => this.runtime.removeListener('payload', handler)
  }

  inspectPacket (packet) {
    const packetName = packet.name || ''
    if (!PAYLOAD_PACKET_PATTERN.test(packetName)) return

    const data = packet.data || {}
    const channel = data.channel || data.identifier || data.tag || data.channelName
    if (typeof channel !== 'string' || channel.length === 0) return

    const payloadData = Buffer.isBuffer(data.data)
      ? data.data
      : Buffer.isBuffer(data.payload)
          ? data.payload
          : Buffer.isBuffer(data.contents)
              ? data.contents
              : null

    const now = Date.now()
    let entry = this._channels.get(channel)
    if (!entry) {
      entry = {
        id: channel,
        firstSeen: now,
        lastSeen: now,
        packetCount: 0,
        directions: new Set()
      }
      this._channels.set(channel, entry)
    }

    entry.lastSeen = now
    entry.packetCount += 1
    entry.directions.add(packet.direction)
    if (entry.packetCount === 1) {
      this.runtime.emit('channelDiscovered', { ...entry, directions: [...entry.directions] })
    }

    const event = {
      channel,
      data: payloadData,
      phase: packet.phase,
      direction: packet.direction,
      packetName,
      packet,
      size: payloadData ? payloadData.length : undefined,
      observedAt: now
    }

    const maxPayloadBytes = this.runtime.options.maxPayloadBytes
    if (payloadData && payloadData.length > maxPayloadBytes) {
      this.runtime.emitWarning(new Error(`Observed payload ${channel} is ${payloadData.length} bytes; configured warning threshold is ${maxPayloadBytes} bytes`))
    }

    this.runtime.emit('payload', event)
  }
}

module.exports = { ChannelInspector }
