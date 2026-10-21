export const DEVICE_NAME = 'SmartVision-ESP32'
export const SMARTVISION_BLE_SERVICE_NAME = 'SmartVision'

export const SMARTVISION_SERVICE_UUID = '19b10000-e8f2-537e-4f6c-d104768a1214'
export const SMARTVISION_TELEMETRY_UUID = '19b10001-e8f2-537e-4f6c-d104768a1214'
export const SMARTVISION_COMMAND_UUID = '19b10002-e8f2-537e-4f6c-d104768a1214'
export const SMARTVISION_STATUS_UUID = '19b10003-e8f2-537e-4f6c-d104768a1214'

export type BleCommandSide = 'left' | 'right' | 'front'

export type HardwareTelemetry = {
  left: number | null
  front: number
  right: number | null
  battery: number | null
  fall: boolean
  sos: boolean
  imu: {
    ax: number
    ay: number
    az: number
  } | null
  timestamp: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (value === 0 || value === 1) return value === 1
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  return null
}

function parseOptionalDistance(value: unknown): number | null | 'invalid' {
  if (value == null) return null
  const n = Number(value)
  if (!Number.isFinite(n)) return 'invalid'
  if (n <= 0 || n > 1000) return 'invalid'
  return n
}

function buildTelemetry(
  leftValue: unknown,
  frontValue: unknown,
  rightValue: unknown,
  batteryValue: unknown,
  imuValue: unknown,
  fallValue: unknown,
  sosValue: unknown,
  timestampValue: unknown,
): HardwareTelemetry | null {
  const front = Number(frontValue)
  const left = parseOptionalDistance(leftValue)
  const right = parseOptionalDistance(rightValue)
  const battery = batteryValue == null ? null : Number(batteryValue)
  const hasImu = isRecord(imuValue) && ['ax', 'ay', 'az'].every((axis) => imuValue[axis] != null && Number.isFinite(Number(imuValue[axis])))
  const imu = hasImu && isRecord(imuValue)
    ? { ax: Number(imuValue.ax), ay: Number(imuValue.ay), az: Number(imuValue.az) }
    : null
  const fall = parseBoolean(fallValue)
  const sos = parseBoolean(sosValue)

  if (
    !Number.isFinite(front) || front <= 0 || front > 1000 ||
    left === 'invalid' ||
    right === 'invalid' ||
    (battery !== null && (!Number.isFinite(battery) || battery < 0 || battery > 100)) ||
    fall === null ||
    sos === null
  ) {
    return null
  }

  return {
    left: left as number | null,
    front,
    right: right as number | null,
    battery,
    fall,
    sos,
    imu,
    timestamp: typeof timestampValue === 'string' && timestampValue ? timestampValue : new Date().toISOString(),
  }
}

export function parseTelemetryPayload(raw: string): HardwareTelemetry | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (isRecord(parsed)) {
      const imu = parsed.imu ?? { ax: parsed.ax, ay: parsed.ay, az: parsed.az }
      return buildTelemetry(
        parsed.left ?? parsed.leftDistance,
        parsed.front ?? parsed.frontDistance,
        parsed.right ?? parsed.rightDistance,
        parsed.battery,
        imu,
        parsed.fall ?? parsed.fallDetected,
        parsed.sos ?? parsed.sosPressed,
        parsed.timestamp,
      )
    }
  } catch {
    // fall through to compact text parsing
  }

  const pairs = trimmed.match(/[a-zA-Z]+\s*[:=]\s*[-+]?\d*\.?\d+/g) ?? []
  const values: Record<string, number | string> = {}

  for (const pair of pairs) {
    const [key, value] = pair.split(/[:=]/)
    if (!key || value == null) continue
    values[key.trim().toLowerCase()] = Number(value.trim())
  }

  if (!('front' in values || 'frontdistance' in values)) {
    return null
  }

  return buildTelemetry(
    values.left ?? values.leftdistance ?? null,
    values.front ?? values.frontdistance,
    values.right ?? values.rightdistance ?? null,
    values.battery ?? values.power ?? null,
    { ax: values.ax, ay: values.ay, az: values.az },
    values.fall ?? values.falldetected,
    values.sos ?? values.sospressed,
    null,
  )
}

export function buildBleCommandPayload(command: 'start' | 'stop' | 'reset_emergency' | 'vibrate', side?: BleCommandSide) {
  if (command === 'vibrate' && side) {
    return JSON.stringify({ command, side })
  }

  return JSON.stringify({ command })
}
