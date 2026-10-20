import { useEffect, useRef, useState } from 'react'
import {
  DEVICE_NAME,
  SMARTVISION_COMMAND_UUID,
  SMARTVISION_SERVICE_UUID,
  SMARTVISION_STATUS_UUID,
  SMARTVISION_TELEMETRY_UUID,
  buildBleCommandPayload,
  parseTelemetryPayload,
  type BleCommandSide,
  type HardwareTelemetry,
} from './bleConfig'

export type BleRuntimeState = {
  connected: boolean
  available: boolean
  status: string
  deviceName: string
  lastPacket: string
  lastPacketTime: string
  error: string | null
}

type BleCharacteristic = {
  properties: { notify?: boolean; indicate?: boolean; write?: boolean; writeWithoutResponse?: boolean }
  value?: DataView | ArrayBuffer
  addEventListener: (type: string, listener: (event: { target: BleCharacteristic }) => void) => void
  removeEventListener: (type: string, listener: (event: { target: BleCharacteristic }) => void) => void
  startNotifications: () => Promise<void>
  writeValue: (value: Uint8Array) => Promise<void>
}

type BleGattService = {
  getCharacteristic: (uuid: string) => Promise<BleCharacteristic>
}

type BleGattServer = {
  connected: boolean
  connect: () => Promise<BleGattServer>
  getPrimaryService: (uuid: string) => Promise<BleGattService>
  disconnect: () => void
}

type BleDevice = {
  name?: string
  gatt?: BleGattServer
  addEventListener: (type: 'gattserverdisconnected', listener: () => void) => void
  removeEventListener: (type: 'gattserverdisconnected', listener: () => void) => void
}

type BleClient = {
  device: BleDevice
  telemetryCharacteristic: BleCharacteristic
  commandCharacteristic: BleCharacteristic
  statusCharacteristic: BleCharacteristic
}

type BleCallbacks = {
  onTelemetry: (telemetry: HardwareTelemetry) => void
  onConnected: (deviceName: string) => void
  onDisconnected: () => void
  onEvent: (message: string) => void
}

export function useSmartVisionBle(callbacks: BleCallbacks) {
  const [state, setState] = useState<BleRuntimeState>({
    connected: false,
    available: typeof navigator !== 'undefined' && 'bluetooth' in navigator,
    status: 'Disconnected',
    deviceName: DEVICE_NAME,
    lastPacket: 'No packet received',
    lastPacketTime: 'Waiting for telemetry',
    error: null,
  })
  const callbacksRef = useRef(callbacks)
  const clientRef = useRef<BleClient | null>(null)
  const disconnectListenerRef = useRef<(() => void) | null>(null)
  const telemetryListenerRef = useRef<((event: { target: BleCharacteristic }) => void) | null>(null)
  const invalidPacketReportedRef = useRef(false)

  useEffect(() => {
    callbacksRef.current = callbacks
  }, [callbacks])

  const updateState = (nextState: Partial<BleRuntimeState>) => {
    setState((previous) => ({ ...previous, ...nextState }))
  }

  const handleDisconnect = () => {
    const client = clientRef.current
    if (!client) return

    if (disconnectListenerRef.current) {
      client.device.removeEventListener('gattserverdisconnected', disconnectListenerRef.current)
    }
    if (telemetryListenerRef.current) {
      client.telemetryCharacteristic.removeEventListener('characteristicvaluechanged', telemetryListenerRef.current)
    }

    clientRef.current = null
    disconnectListenerRef.current = null
    telemetryListenerRef.current = null
    invalidPacketReportedRef.current = false
    setState((previous) => ({
      ...previous,
      connected: false,
      status: 'Disconnected',
      deviceName: DEVICE_NAME,
      lastPacket: 'No packet received',
      lastPacketTime: 'Waiting for telemetry',
      error: 'SmartVision wearable disconnected. Simulation mode is active.',
    }))
    callbacksRef.current.onDisconnected()
    callbacksRef.current.onEvent('SmartVision wearable disconnected')
  }

  const connect = async () => {
    if (!('bluetooth' in navigator)) {
      updateState({
        available: false,
        connected: false,
        status: 'Unsupported',
        error: 'Bluetooth is not supported in this browser. Please use a supported Chromium-based browser for hardware connectivity.',
      })
      return
    }

    let device: BleDevice | null = null

    try {
      updateState({ error: null, status: 'Connecting…' })
      const bluetoothApi = (navigator as Navigator & {
        bluetooth?: {
          requestDevice: (options: {
            filters?: Array<{ services?: string[]; name?: string }>
            optionalServices?: string[]
          }) => Promise<BleDevice>
        }
      }).bluetooth

      if (!bluetoothApi) throw new Error('Web Bluetooth is not available in this browser.')

      device = await bluetoothApi.requestDevice({
        filters: [{ services: [SMARTVISION_SERVICE_UUID], name: DEVICE_NAME }, { name: DEVICE_NAME }],
        optionalServices: [SMARTVISION_SERVICE_UUID],
      })

      if (!device.gatt) throw new Error('Unable to access the wearable GATT server.')

      const server = await device.gatt.connect()
      const service = await server.getPrimaryService(SMARTVISION_SERVICE_UUID)
      const telemetryCharacteristic = await service.getCharacteristic(SMARTVISION_TELEMETRY_UUID)
      const commandCharacteristic = await service.getCharacteristic(SMARTVISION_COMMAND_UUID)
      const statusCharacteristic = await service.getCharacteristic(SMARTVISION_STATUS_UUID)

      if (!telemetryCharacteristic.properties.notify && !telemetryCharacteristic.properties.indicate) {
        throw new Error('Telemetry notifications are not available for this device.')
      }
      if (!commandCharacteristic.properties.write && !commandCharacteristic.properties.writeWithoutResponse) {
        throw new Error('The wearable command characteristic is not writable.')
      }

      const client = { device, telemetryCharacteristic, commandCharacteristic, statusCharacteristic }
      clientRef.current = client

      const onTelemetry = (event: { target: BleCharacteristic }) => {
        const value = event.target.value
        const raw = value ? new TextDecoder().decode(value) : ''
        const telemetry = parseTelemetryPayload(raw)

        if (!telemetry) {
          updateState({
            status: 'Data warning',
            error: 'Invalid telemetry received. The last valid sensor reading is retained.',
          })
          if (!invalidPacketReportedRef.current) {
            callbacksRef.current.onEvent('Invalid telemetry ignored; last valid reading retained')
            invalidPacketReportedRef.current = true
          }
          return
        }

        invalidPacketReportedRef.current = false
        updateState({
          connected: true,
          available: true,
          status: 'Connected',
          deviceName: device?.name || DEVICE_NAME,
          lastPacket: raw.slice(0, 180) || 'Telemetry packet received',
          lastPacketTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
          error: null,
        })
        callbacksRef.current.onTelemetry(telemetry)
      }

      telemetryListenerRef.current = onTelemetry
      telemetryCharacteristic.addEventListener('characteristicvaluechanged', onTelemetry)

      const onDisconnect = () => handleDisconnect()
      disconnectListenerRef.current = onDisconnect
      device.addEventListener('gattserverdisconnected', onDisconnect)

      await telemetryCharacteristic.startNotifications()
      updateState({
        connected: true,
        available: true,
        status: 'Connected',
        deviceName: device.name || DEVICE_NAME,
        lastPacket: 'Waiting for first valid telemetry packet',
        lastPacketTime: 'Waiting for telemetry',
      })
      callbacksRef.current.onConnected(device.name || DEVICE_NAME)
    } catch (error) {
      const domError = error instanceof DOMException ? error : null
      const detail = error instanceof Error ? error.message.toLowerCase() : ''
      const message = domError?.name === 'NotFoundError'
        ? detail.includes('cancel') ? 'Connection cancelled.' : 'The wearable is missing a required SmartVision BLE service or characteristic.'
        : domError?.name === 'NotAllowedError' || domError?.name === 'SecurityError'
          ? 'Bluetooth permission was denied. Allow access and try again.'
          : domError?.name === 'NetworkError'
            ? 'The wearable is unavailable or the BLE connection was interrupted.'
            : error instanceof Error && error.message.startsWith('Telemetry') || error instanceof Error && error.message.startsWith('The wearable')
              ? error.message
              : 'Unable to connect to the SmartVision wearable. Check that it is powered on and nearby.'

      const client = clientRef.current
      if (client) {
        if (disconnectListenerRef.current) client.device.removeEventListener('gattserverdisconnected', disconnectListenerRef.current)
        if (telemetryListenerRef.current) client.telemetryCharacteristic.removeEventListener('characteristicvaluechanged', telemetryListenerRef.current)
      }
      device?.gatt?.disconnect()
      clientRef.current = null
      disconnectListenerRef.current = null
      telemetryListenerRef.current = null
      updateState({ connected: false, status: 'Disconnected', deviceName: DEVICE_NAME, error: message })
    }
  }

  const disconnect = async () => {
    const client = clientRef.current
    if (!client) {
      updateState({ connected: false, status: 'Disconnected', error: null })
      return
    }

    if (disconnectListenerRef.current) {
      client.device.removeEventListener('gattserverdisconnected', disconnectListenerRef.current)
    }
    if (telemetryListenerRef.current) {
      client.telemetryCharacteristic.removeEventListener('characteristicvaluechanged', telemetryListenerRef.current)
    }
    if (client.device.gatt?.connected) client.device.gatt.disconnect()
    clientRef.current = null
    disconnectListenerRef.current = null
    telemetryListenerRef.current = null
    invalidPacketReportedRef.current = false
    updateState({
      connected: false,
      status: 'Disconnected',
      deviceName: DEVICE_NAME,
      lastPacket: 'No packet received',
      lastPacketTime: 'Waiting for telemetry',
      error: null,
    })
    callbacksRef.current.onDisconnected()
    callbacksRef.current.onEvent('SmartVision wearable disconnected')
  }

  const sendCommand = async (command: 'start' | 'stop' | 'reset_emergency' | 'vibrate', side?: BleCommandSide) => {
    const client = clientRef.current
    if (!client) {
      updateState({ error: 'Bluetooth device is not connected.' })
      return
    }

    try {
      if (!client.commandCharacteristic.properties.write && !client.commandCharacteristic.properties.writeWithoutResponse) {
        updateState({ error: 'The wearable command characteristic is not writable.' })
        return
      }
      const payload = buildBleCommandPayload(command, side)
      await client.commandCharacteristic.writeValue(new TextEncoder().encode(payload))
      updateState({ error: null })
      callbacksRef.current.onEvent(`Command sent: ${payload}`)
    } catch {
      updateState({ error: 'Unable to write the SmartVision command characteristic.' })
      callbacksRef.current.onEvent('Command write failed')
    }
  }

  return { state, connect, disconnect, sendCommand }
}
