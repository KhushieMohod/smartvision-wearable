import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { type HardwareTelemetry } from './bleConfig'
import { useSmartVisionBle } from './useSmartVisionBle'

// ── Types ──────────────────────────────────────────────────────────────────────

type IncidentType = 'SOS' | 'FALL' | 'SYSTEM'

type IncidentEntry = {
  id: string
  time: string
  type: IncidentType
  message: string
  location: string
  status: 'Active' | 'Resolved'
}

type SpeechPriority = 'distance' | 'navigation' | 'balanced'

type DeviceSettings = {
  primaryName: string
  primaryContact: string
  primaryRelationship: string
  secondaryName: string
  secondaryContact: string
  secondaryRelationship: string
  audioVolume: number
  vibrationIntensity: number
  speechPriority: SpeechPriority
  speechRate: number
  fallCountdown: number
  geofenceRadius: number
  tofWarningThreshold: number
}

type ActiveTab = 'dashboard' | 'settings' | 'documentation'
type MapTileTheme = 'dark' | 'standard' | 'contrast'

// ── Web Audio Synthesizer (Zero external dependencies) ─────────────────────────

class WebAudioService {
  private ctx: AudioContext | null = null
  private sirenTimer: number | null = null

  private getContext(): AudioContext | null {
    if (typeof window === 'undefined') return null
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (AudioCtx) {
        this.ctx = new AudioCtx()
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => { /* user gesture required */ })
    }
    return this.ctx
  }

  playBeep(freq = 880, duration = 0.15, type: OscillatorType = 'sine', volume = 0.25) {
    try {
      const ctx = this.getContext()
      if (!ctx) return
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = type
      osc.frequency.setValueAtTime(freq, ctx.currentTime)
      gain.gain.setValueAtTime(Math.min(1, Math.max(0, volume)), ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + duration)
    } catch { /* ignore */ }
  }

  playChime(volume = 0.3) {
    this.playBeep(523.25, 0.12, 'sine', volume)
    setTimeout(() => this.playBeep(659.25, 0.12, 'sine', volume), 110)
    setTimeout(() => this.playBeep(783.99, 0.22, 'sine', volume), 220)
  }

  startEmergencySiren(muted = false) {
    if (muted || this.sirenTimer !== null) return
    const pulse = () => {
      this.playBeep(750, 0.22, 'sawtooth', 0.2)
      setTimeout(() => this.playBeep(920, 0.22, 'sawtooth', 0.2), 240)
    }
    pulse()
    this.sirenTimer = window.setInterval(pulse, 600)
  }

  stopEmergencySiren() {
    if (this.sirenTimer !== null) {
      clearInterval(this.sirenTimer)
      this.sirenTimer = null
    }
  }

  speak(text: string, rate = 1.0, volume = 0.8) {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel()
        const utterance = new SpeechSynthesisUtterance(text)
        utterance.rate = rate
        utterance.volume = volume
        utterance.pitch = 1.0
        window.speechSynthesis.speak(utterance)
      } catch { /* ignore */ }
    }
  }
}

const soundManager = new WebAudioService()

// ── Default State & Constants ──────────────────────────────────────────────────

const DEFAULT_SETTINGS: DeviceSettings = {
  primaryName: 'Dr. Aris Thorne',
  primaryContact: '+1-555-0199',
  primaryRelationship: 'Primary Physician & Family',
  secondaryName: 'Maya Thorne',
  secondaryContact: '+1-555-0144',
  secondaryRelationship: 'Caregiver / Spouse',
  audioVolume: 80,
  vibrationIntensity: 65,
  speechPriority: 'balanced',
  speechRate: 1.0,
  fallCountdown: 10,
  geofenceRadius: 250,
  tofWarningThreshold: 80,
}

const BASE_COORDS: [number, number] = [19.0760, 72.8777]

// Waypoint path simulating realistic pedestrian sidewalk movement
const ROUTE_WAYPOINTS: [number, number][] = [
  [19.07600, 72.87770],
  [19.07625, 72.87795],
  [19.07655, 72.87830],
  [19.07690, 72.87870],
  [19.07720, 72.87905],
  [19.07745, 72.87940],
  [19.07715, 72.87980],
  [19.07675, 72.88015],
  [19.07635, 72.88040],
  [19.07590, 72.88010],
  [19.07560, 72.87950],
  [19.07575, 72.87860],
]

function loadSettings(): DeviceSettings {
  try {
    const saved = localStorage.getItem('smartvision-caregiver-settings')
    if (saved) return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) }
  } catch { /* ignore */ }
  return DEFAULT_SETTINGS
}

function saveSettings(settings: DeviceSettings) {
  localStorage.setItem('smartvision-caregiver-settings', JSON.stringify(settings))
}

function formatTime(date: Date = new Date()): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

// ── Icons (Crisp, High-Legibility SVGs) ─────────────────────────────────────────

function IconPulse({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  )
}

function IconWifi({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.55a11 11 0 0 1 14.08 0" /><path d="M1.42 9a16 16 0 0 1 21.16 0" /><path d="M8.53 16.11a6 6 0 0 1 6.95 0" /><circle cx="12" cy="20" r="1" fill="currentColor" />
    </svg>
  )
}

function IconWifiOff({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="1" y1="1" x2="23" y2="23" /><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" /><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" /><path d="M10.71 5.05A16 16 0 0 1 22.56 9" /><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" /><circle cx="12" cy="20" r="1" fill="currentColor" />
    </svg>
  )
}

function IconShield({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}

function IconAlertTriangle({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

function IconMapPin({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" />
    </svg>
  )
}

function IconSettings({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function IconBook({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  )
}

function IconClock({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

function IconSearch({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

function IconX({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function IconCheck({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function IconPhone({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  )
}

function IconMessageSquare({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function IconDownload({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

function IconVolume2({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  )
}

function IconVolumeX({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  )
}

function IconCompass({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </svg>
  )
}

// ── Interactive Leaflet Map with Zero Watermark ────────────────────────────────

function LiveMap({
  coords,
  sosActive,
  breadcrumbTrail,
  geofenceRadius,
  tileTheme,
  onRecenter,
}: {
  coords: [number, number]
  sosActive: boolean
  breadcrumbTrail: [number, number][]
  geofenceRadius: number
  tileTheme: MapTileTheme
  onRecenter?: () => void
}) {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<L.Map | null>(null)
  const markerRef = useRef<L.Marker | null>(null)
  const polylineRef = useRef<L.Polyline | null>(null)
  const circleRef = useRef<L.Circle | null>(null)

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return

    // Initialize Leaflet map with standard OpenStreetMap tile server
    const map = L.map(mapRef.current, {
      center: coords,
      zoom: 16,
      zoomControl: false,
      attributionControl: true,
    })

    // 100% Free, reliable OpenStreetMap tiles (no Carto watermark or API key requirement)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    }).addTo(map)

    L.control.zoom({ position: 'bottomright' }).addTo(map)

    // Geofence perimeter circle around home/base
    const geofence = L.circle(BASE_COORDS, {
      radius: geofenceRadius,
      color: '#14b8a6',
      fillColor: '#14b8a6',
      fillOpacity: 0.08,
      weight: 1.5,
      dashArray: '4, 8',
    }).addTo(map)
    circleRef.current = geofence

    // Breadcrumb polyline trail
    const polyline = L.polyline(breadcrumbTrail, {
      color: '#14b8a6',
      weight: 3.5,
      opacity: 0.8,
      dashArray: '6, 6',
    }).addTo(map)
    polylineRef.current = polyline

    // Wearable device marker with custom pulse
    const marker = L.marker(coords, {
      icon: L.divIcon({
        className: 'custom-map-pin',
        html: `
          <div style="position:relative;width:24px;height:24px;">
            <div class="${sosActive ? 'sonar-pulse-emergency' : 'sonar-pulse-normal'}"></div>
            <div style="position:relative;width:24px;height:24px;border-radius:50%;background:${sosActive ? '#e11d48' : '#14b8a6'};border:3px solid #ffffff;box-shadow:0 0 14px ${sosActive ? 'rgba(225,29,72,0.8)' : 'rgba(20,184,166,0.6)'};display:flex;align-items:center;justify-content:center;">
              <div style="width:6px;height:6px;border-radius:50%;background:#ffffff;"></div>
            </div>
          </div>
        `,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      }),
    }).addTo(map)

    marker.bindPopup(`
      <div style="font-family:'Plus Jakarta Sans',sans-serif;font-size:12px;color:#0f172a;padding:4px;">
        <strong style="color:#0f766e;">SmartVision Wearable</strong><br/>
        Lat: ${coords[0].toFixed(5)}<br/>
        Lng: ${coords[1].toFixed(5)}<br/>
        <span style="display:inline-block;margin-top:4px;padding:2px 6px;border-radius:4px;background:#e2e8f0;font-size:10px;font-weight:600;">Live Telemetry</span>
      </div>
    `)

    markerRef.current = marker
    mapInstanceRef.current = map

    return () => {
      map.remove()
      mapInstanceRef.current = null
      markerRef.current = null
      polylineRef.current = null
      circleRef.current = null
    }
  }, [])

  // Update marker position & map pan on coords change
  useEffect(() => {
    if (markerRef.current && mapInstanceRef.current) {
      markerRef.current.setLatLng(coords)
      mapInstanceRef.current.panTo(coords, { animate: true, duration: 0.8 })
    }
  }, [coords])

  // Update breadcrumb trail
  useEffect(() => {
    if (polylineRef.current) {
      polylineRef.current.setLatLngs(breadcrumbTrail)
    }
  }, [breadcrumbTrail])

  // Update geofence radius
  useEffect(() => {
    if (circleRef.current) {
      circleRef.current.setRadius(geofenceRadius)
    }
  }, [geofenceRadius])

  // Update marker icon for normal vs emergency SOS state
  useEffect(() => {
    if (!markerRef.current) return
    markerRef.current.setIcon(
      L.divIcon({
        className: 'custom-map-pin',
        html: `
          <div style="position:relative;width:24px;height:24px;">
            <div class="${sosActive ? 'sonar-pulse-emergency' : 'sonar-pulse-normal'}"></div>
            <div style="position:relative;width:24px;height:24px;border-radius:50%;background:${sosActive ? '#e11d48' : '#14b8a6'};border:3px solid #ffffff;box-shadow:0 0 14px ${sosActive ? 'rgba(225,29,72,0.8)' : 'rgba(20,184,166,0.6)'};display:flex;align-items:center;justify-content:center;">
              <div style="width:6px;height:6px;border-radius:50%;background:#ffffff;"></div>
            </div>
          </div>
        `,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      })
    )
  }, [sosActive])

  // Recenter handler
  const handleRecenter = () => {
    if (mapInstanceRef.current) {
      mapInstanceRef.current.setView(coords, 16, { animate: true })
      if (onRecenter) onRecenter()
    }
  }

  // Class for tile theme styling
  const tileThemeClass = tileTheme === 'dark'
    ? 'map-dark-tiles'
    : tileTheme === 'contrast'
      ? 'map-contrast-tiles'
      : 'map-standard-tiles'

  return (
    <div className="relative h-full w-full">
      <div
        ref={mapRef}
        className={`h-full w-full rounded-xl ${tileThemeClass}`}
        style={{ minHeight: '380px' }}
      />
      {/* Map floating control overlay */}
      <div className="absolute right-3 top-3 z-[400] flex flex-col gap-2">
        <button
          type="button"
          onClick={handleRecenter}
          title="Recenter on Wearable"
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/15 bg-surface-900/90 text-surface-200 shadow-lg backdrop-blur-md hover:bg-surface-800 hover:text-primary-400"
        >
          <IconCompass className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

// ── Main SmartVision Application ───────────────────────────────────────────────

function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('dashboard')
  const [settings, setSettings] = useState<DeviceSettings>(loadSettings)
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [testActionNotice, setTestActionNotice] = useState<string | null>(null)

  // Emergency & Siren audio state
  const [sosActive, setSosActive] = useState(false)
  const [isSirenMuted, setIsSirenMuted] = useState(false)
  const [lastUpdate, setLastUpdate] = useState<string>(formatTime())
  const [hardwareTelemetry, setHardwareTelemetry] = useState<HardwareTelemetry | null>(null)
  const hardwareFlagsRef = useRef({ fall: false, sos: false })

  // Fall Detection Modal State
  const [fallModal, setFallModal] = useState(false)
  const [fallCountdown, setFallCountdown] = useState(settings.fallCountdown)

  // Map state
  const [userCoords, setUserCoords] = useState<[number, number]>(BASE_COORDS)
  const [breadcrumbTrail, setBreadcrumbTrail] = useState<[number, number][]>([BASE_COORDS])
  const [isSimulatingWalk, setIsSimulatingWalk] = useState(false)
  const [, setWaypointIndex] = useState(0)
  const [mapTileTheme, setMapTileTheme] = useState<MapTileTheme>('dark')

  // Incident log & filters
  const [incidentLog, setIncidentLog] = useState<IncidentEntry[]>([
    {
      id: 'init-001',
      time: '15:10:04',
      type: 'SYSTEM',
      message: 'Caregiver IoT monitoring service synchronized with smartphone bridge',
      location: '19.0760, 72.8777',
      status: 'Resolved',
    },
    {
      id: 'init-002',
      time: '15:12:30',
      type: 'SYSTEM',
      message: 'ESP32 VL53L0X Time-of-Flight ranging calibration confirmed',
      location: '19.0760, 72.8777',
      status: 'Resolved',
    },
  ])
  const [incidentSearch, setIncidentSearch] = useState('')
  const [incidentTypeFilter, setIncidentTypeFilter] = useState<'ALL' | IncidentType>('ALL')

  // Simulated live telemetry sensors (when hardware BLE is disconnected)
  const [simulatedSensors, setSimulatedSensors] = useState({
    leftCm: 140,
    frontCm: 95,
    rightCm: 180,
    batteryPct: 82,
    voltage: 3.84,
    speedMps: 1.1,
    headingDeg: 42,
    aiObject: 'Sidewalk clear — Crosswalk in 4.5m',
  })

  // ── Logging Helper ─────────────────────────────────────────────────────────
  const addIncident = (type: IncidentType, message: string) => {
    const entry: IncidentEntry = {
      id: generateId(),
      time: formatTime(),
      type,
      message,
      location: `${userCoords[0].toFixed(5)}, ${userCoords[1].toFixed(5)}`,
      status: 'Active',
    }
    setIncidentLog(prev => [entry, ...prev].slice(0, 50))
  }

  // ── BLE Hardware Connection Hook ───────────────────────────────────────────
  const { state: bleState, connect: connectWearable, disconnect: disconnectWearable } = useSmartVisionBle({
    onTelemetry: (telemetry) => {
      setHardwareTelemetry(telemetry)
      setLastUpdate(formatTime())

      if (telemetry.sos && !hardwareFlagsRef.current.sos) {
        setSosActive(true)
        soundManager.startEmergencySiren(isSirenMuted)
        soundManager.speak('Emergency SOS triggered from chest harness button.')
        addIncident('SOS', 'Tactile chest button SOS activated — notification dispatched')
      }

      if (telemetry.fall && !hardwareFlagsRef.current.fall) {
        setFallModal(true)
        setFallCountdown(settings.fallCountdown)
        soundManager.playBeep(880, 0.4, 'sawtooth', 0.4)
        soundManager.speak('Fall detected. Please acknowledge if you are okay.')
        addIncident('FALL', 'MPU6050 high impact/angular momentum threshold exceeded')
      }

      hardwareFlagsRef.current = { fall: telemetry.fall, sos: telemetry.sos }
    },
    onConnected: () => {
      setLastUpdate(formatTime())
      soundManager.playChime(0.2)
      addIncident('SYSTEM', 'ESP32 SmartVision hardware linked via Web Bluetooth')
    },
    onDisconnected: () => {
      setHardwareTelemetry(null)
      hardwareFlagsRef.current = { fall: false, sos: false }
      addIncident('SYSTEM', 'ESP32 Bluetooth disconnected — reverted to cloud bridge telemetry')
    },
    onEvent: () => {
      setLastUpdate(formatTime())
    },
  })

  const isOnline = bleState.connected

  // ── Live Movement Simulation (Walk Traversal) ──────────────────────────────
  useEffect(() => {
    if (!isSimulatingWalk) return

    const interval = setInterval(() => {
      setWaypointIndex(prev => {
        const nextIdx = (prev + 1) % ROUTE_WAYPOINTS.length
        const nextCoord = ROUTE_WAYPOINTS[nextIdx]
        setUserCoords(nextCoord)
        setBreadcrumbTrail(curr => [...curr, nextCoord].slice(-30))
        setLastUpdate(formatTime())

        // Subtle realistic sensor jitter
        setSimulatedSensors(s => ({
          ...s,
          leftCm: Math.max(30, Math.min(220, Math.round(s.leftCm + (Math.random() * 20 - 10)))),
          frontCm: Math.max(25, Math.min(200, Math.round(s.frontCm + (Math.random() * 24 - 12)))),
          rightCm: Math.max(35, Math.min(240, Math.round(s.rightCm + (Math.random() * 20 - 10)))),
          headingDeg: (s.headingDeg + 8) % 360,
        }))

        return nextIdx
      })
    }, 2800)

    return () => clearInterval(interval)
  }, [isSimulatingWalk])

  // Periodic heartbeat sync when idle
  useEffect(() => {
    const interval = setInterval(() => {
      setLastUpdate(formatTime())
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  // ── Fall Detection Countdown Logic with Auditory Ticks ─────────────────────
  useEffect(() => {
    if (!fallModal) return

    if (fallCountdown <= 0) {
      setSosActive(true)
      setFallModal(false)
      setFallCountdown(settings.fallCountdown)
      soundManager.startEmergencySiren(isSirenMuted)
      soundManager.speak('Emergency timeout reached. Escalating to caregiver contacts.')
      addIncident('FALL', 'Fall countdown expired without verbal dismissal — escalated to emergency services')
      return
    }

    // Audible tick each second during emergency countdown
    soundManager.playBeep(900, 0.08, 'sine', 0.25)

    const timer = setTimeout(() => {
      setFallCountdown(prev => prev - 1)
    }, 1000)

    return () => clearTimeout(timer)
  }, [fallModal, fallCountdown, isSirenMuted, settings.fallCountdown])

  // ── Emergency Action Triggers ──────────────────────────────────────────────
  const triggerSos = () => {
    setSosActive(true)
    soundManager.startEmergencySiren(isSirenMuted)
    soundManager.speak('SmartVision Emergency SOS activated. Caregivers notified.')
    addIncident('SOS', 'Manual SOS button triggered from caregiver monitoring station')
  }

  const triggerFall = () => {
    setFallModal(true)
    setFallCountdown(settings.fallCountdown)
    soundManager.playBeep(700, 0.3, 'sawtooth', 0.35)
    soundManager.speak('Warning: Fall impact detected. Verbal confirmation countdown started.')
    addIncident('FALL', 'Simulated MPU6050 fall detection — 10s confirmation window active')
  }

  const dismissFall = () => {
    setFallModal(false)
    setFallCountdown(settings.fallCountdown)
    soundManager.playChime(0.2)
    soundManager.speak('Fall alert cancelled by user.')
    setIncidentLog(prev => {
      const copy = [...prev]
      const idx = copy.findIndex(e => e.type === 'FALL' && e.status === 'Active')
      if (idx >= 0) copy[idx] = { ...copy[idx], status: 'Resolved' }
      return copy
    })
  }

  const clearEmergency = () => {
    setSosActive(false)
    setFallModal(false)
    soundManager.stopEmergencySiren()
    setFallCountdown(settings.fallCountdown)
    setIncidentLog(prev => prev.map(e => e.status === 'Active' ? { ...e, status: 'Resolved' } : e))
  }

  const toggleSirenMute = () => {
    setIsSirenMuted(m => {
      const next = !m
      if (next) {
        soundManager.stopEmergencySiren()
      } else if (sosActive) {
        soundManager.startEmergencySiren(false)
      }
      return next
    })
  }

  // ── Export Incident Log to CSV ─────────────────────────────────────────────
  const exportIncidentLogCsv = () => {
    const headers = ['ID', 'Timestamp', 'Type', 'Status', 'Location', 'Message']
    const rows = incidentLog.map(item => [
      item.id,
      `"${item.time}"`,
      item.type,
      item.status,
      `"${item.location}"`,
      `"${item.message.replace(/"/g, '""')}"`,
    ])
    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `SmartVision-Incident-Report-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  // ── Settings Handlers ──────────────────────────────────────────────────────
  const updateSetting = <K extends keyof DeviceSettings>(key: K, value: DeviceSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }))
    setSettingsSaved(false)
  }

  const handleSaveSettings = () => {
    saveSettings(settings)
    setSettingsSaved(true)
    soundManager.playChime(0.25)
    setTimeout(() => setSettingsSaved(false), 3500)
  }

  const showNotice = (msg: string) => {
    setTestActionNotice(msg)
    setTimeout(() => setTestActionNotice(null), 3500)
  }

  const testAudioChime = () => {
    soundManager.playChime(settings.audioVolume / 100)
    showNotice(`Audio feedback test played at ${settings.audioVolume}% volume`)
  }

  const testVibrationFeedback = () => {
    if (typeof window !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate([150, 80, 150, 80, 300])
    }
    soundManager.playBeep(240, 0.35, 'triangle', 0.2)
    showNotice(`Tactile haptic pulse triggered at ${settings.vibrationIntensity}% duty cycle`)
  }

  const testVoiceFeedback = () => {
    soundManager.speak(
      `SmartVision voice synthesis configured at ${settings.speechRate}x speed with ${settings.speechPriority} priority mode.`,
      settings.speechRate,
      settings.audioVolume / 100
    )
    showNotice(`Voice announcement played using browser SpeechSynthesis`)
  }

  // Filtered incidents
  const filteredIncidents = useMemo(() => {
    return incidentLog.filter(item => {
      const matchesType = incidentTypeFilter === 'ALL' || item.type === incidentTypeFilter
      const matchesSearch = incidentSearch.trim() === '' ||
        item.message.toLowerCase().includes(incidentSearch.toLowerCase()) ||
        item.location.includes(incidentSearch) ||
        item.time.includes(incidentSearch)
      return matchesType && matchesSearch
    })
  }, [incidentLog, incidentTypeFilter, incidentSearch])

  // Current battery & sensor values
  const batteryLevel = isOnline && hardwareTelemetry ? hardwareTelemetry.battery : simulatedSensors.batteryPct
  const leftDistance = isOnline && hardwareTelemetry ? hardwareTelemetry.left : simulatedSensors.leftCm
  const frontDistance = isOnline && hardwareTelemetry ? hardwareTelemetry.front : simulatedSensors.frontCm
  const rightDistance = isOnline && hardwareTelemetry ? hardwareTelemetry.right : simulatedSensors.rightCm

  // Emergency contact direct SMS link
  const emergencySmsUrl = `sms:${settings.primaryContact}?body=${encodeURIComponent(
    `URGENT: SmartVision SOS triggered for user at GPS coordinates ${userCoords[0].toFixed(5)}, ${userCoords[1].toFixed(5)} at ${formatTime()}. Battery: ${batteryLevel ?? 'N/A'}%.`
  )}`

  // Navigation tab definitions
  const tabs: { id: ActiveTab; label: string; icon: React.ReactNode }[] = [
    { id: 'dashboard', label: 'Monitoring Dashboard', icon: <IconPulse className="h-4 w-4" /> },
    { id: 'settings', label: 'Device Configuration', icon: <IconSettings className="h-4 w-4" /> },
    { id: 'documentation', label: 'Architecture & Guides', icon: <IconBook className="h-4 w-4" /> },
  ]

  return (
    <div className="min-h-screen bg-surface-950 text-surface-100 antialiased">

      {/* ── High-Priority Emergency SOS Banner ── */}
      {sosActive && (
        <div className="sos-alert-banner sticky top-0 z-[100] flex flex-wrap items-center justify-between gap-3 border-b border-danger-500/40 bg-gradient-to-r from-danger-600 via-rose-600 to-danger-700 px-4 py-3 text-white shadow-2xl sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/20">
              <IconAlertTriangle className="h-5 w-5 text-white animate-bounce" />
            </div>
            <div>
              <div className="text-sm font-black uppercase tracking-wider">
                Emergency Alert Active — Caregiver Dispatch Triggered
              </div>
              <div className="text-xs text-white/90">
                Live location: {userCoords[0].toFixed(5)}°N, {userCoords[1].toFixed(5)}°E • Battery: {batteryLevel}%
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleSirenMute}
              className="flex items-center gap-1.5 rounded-lg border border-white/30 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/20"
            >
              {isSirenMuted ? <IconVolumeX className="h-3.5 w-3.5" /> : <IconVolume2 className="h-3.5 w-3.5" />}
              {isSirenMuted ? 'Unmute Siren' : 'Mute Siren'}
            </button>

            <a
              href={`tel:${settings.primaryContact}`}
              className="flex items-center gap-1.5 rounded-lg border border-white/30 bg-white/10 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white hover:bg-white/20"
            >
              <IconPhone className="h-3.5 w-3.5" />
              Call Caregiver
            </a>

            <button
              type="button"
              onClick={clearEmergency}
              className="rounded-lg bg-white px-3 py-1.5 text-xs font-black uppercase tracking-wider text-danger-700 shadow-md hover:bg-surface-100"
            >
              Clear Emergency
            </button>
          </div>
        </div>
      )}

      {/* ── Top Header Navigation ── */}
      <header className="sticky top-0 z-40 border-b border-white/[0.08] bg-surface-950/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 text-white shadow-lg shadow-primary-600/25">
              <IconPulse className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-black tracking-tight text-white">SmartVision</span>
                <span className="rounded-full border border-primary-500/30 bg-primary-500/10 px-2 py-0.5 text-[10px] font-bold tracking-wider text-primary-400">
                  CARE STATION
                </span>
              </div>
              <p className="text-xs text-surface-400">Wearable Perception & Emergency Monitoring</p>
            </div>
          </div>

          {/* Desktop Navigation Tabs */}
          <nav className="hidden items-center gap-1 rounded-xl border border-white/[0.08] bg-surface-900/80 p-1 md:flex">
            {tabs.map(tab => {
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-bold transition-all ${isActive
                    ? 'bg-primary-600 text-white shadow-md shadow-primary-600/30'
                    : 'text-surface-400 hover:text-surface-100 hover:bg-white/[0.04]'
                    }`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              )
            })}
          </nav>

          {/* Hardware Connection Action */}
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={isOnline ? disconnectWearable : connectWearable}
              className={`flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-xs font-bold transition-all ${isOnline
                ? 'border border-success-500/30 bg-success-500/10 text-success-400 hover:bg-success-500/20'
                : 'border border-primary-500/40 bg-primary-600 text-white hover:bg-primary-500 shadow-md shadow-primary-600/25'
                }`}
            >
              <div className={`h-2 w-2 rounded-full ${isOnline ? 'bg-success-400 heartbeat-live' : 'bg-surface-400'}`} />
              <span>{isOnline ? 'ESP32 Paired' : 'Pair ESP32 (BLE)'}</span>
            </button>
          </div>
        </div>

        {/* Mobile Navigation Tabs */}
        <div className="flex border-t border-white/[0.06] bg-surface-900/50 md:hidden">
          {tabs.map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-[11px] font-bold transition-all ${activeTab === tab.id
                ? 'border-b-2 border-primary-500 text-primary-400 bg-primary-500/[0.05]'
                : 'text-surface-400'
                }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      </header>

      {/* Action Notification Toast */}
      {testActionNotice && (
        <div className="fixed bottom-5 right-5 z-[80] flex items-center gap-2.5 rounded-xl border border-primary-500/40 bg-surface-900/95 px-4 py-3 text-xs font-semibold text-primary-300 shadow-2xl backdrop-blur-md">
          <IconCheck className="h-4 w-4 text-primary-400" />
          <span>{testActionNotice}</span>
        </div>
      )}

      {/* ── Main Content Container ── */}
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">

        {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            TAB 1: REAL-TIME CAREGIVER IoT DASHBOARD
        ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        {activeTab === 'dashboard' && (
          <div className="space-y-6">

            {/* ── Top Status Cards Grid ── */}
            <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {/* Card 1: System Heartbeat */}
              <div className="premium-card p-5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-surface-400">
                    System Heartbeat
                  </span>
                  <div className={`h-2.5 w-2.5 rounded-full ${isOnline ? 'bg-success-400 heartbeat-live' : 'bg-surface-500'}`} />
                </div>
                <div className="mt-3 flex items-center gap-2.5">
                  {isOnline ? (
                    <IconWifi className="h-5 w-5 text-success-400" />
                  ) : (
                    <IconWifiOff className="h-5 w-5 text-surface-400" />
                  )}
                  <span className="text-xl font-bold tracking-tight text-white">
                    {isOnline ? 'Online (ESP32)' : 'Simulated Bridge'}
                  </span>
                </div>
                <p className="mt-2 text-xs text-surface-400">
                  {isOnline
                    ? 'Receiving 10Hz telemetry stream over BLE GATT'
                    : 'Transmitting over smartphone cellular gateway'}
                </p>
              </div>

              {/* Card 2: Battery Gauge */}
              <div className="premium-card p-5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-surface-400">
                    Wearable Battery
                  </span>
                  <span className="font-mono-numbers text-xs font-bold text-surface-400">
                    {simulatedSensors.voltage}V LiPo
                  </span>
                </div>
                <div className="mt-3 flex items-baseline gap-2">
                  <span className="font-mono-numbers text-3xl font-black text-white">
                    {batteryLevel}%
                  </span>
                  <span className="text-xs font-semibold text-primary-400">~14.5 hrs remaining</span>
                </div>
                  <div className="mt-3 h-2 w-full rounded-full bg-surface-800">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${(batteryLevel ?? 0) > 50
                        ? 'bg-success-500'
                        : (batteryLevel ?? 0) > 20
                          ? 'bg-warning-500'
                          : 'bg-danger-500'
                        }`}
                      style={{ width: `${batteryLevel ?? 0}%` }}
                    />
                  </div>
              </div>

              {/* Card 3: Cloud Sync Timestamp */}
              <div className="premium-card p-5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-surface-400">
                    Last Cloud Sync
                  </span>
                  <IconClock className="h-4 w-4 text-primary-400" />
                </div>
                <div className="mt-3">
                  <span className="font-mono-numbers text-2xl font-bold text-white">
                    {lastUpdate}
                  </span>
                </div>
                <p className="mt-2 text-xs text-surface-400">
                  Sync rate: 1.0s packet cadence • Latency: 18ms
                </p>
              </div>

              {/* Card 4: Operating Mode */}
              <div className="premium-card p-5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-surface-400">
                    Perception Mode
                  </span>
                  <span className="rounded-md border border-primary-500/30 bg-primary-500/10 px-2 py-0.5 text-[10px] font-bold text-primary-400">
                    ACTIVE
                  </span>
                </div>
                <div className="mt-3">
                  <span className="text-lg font-bold text-white">
                    Assisted Guidance
                  </span>
                </div>
                <p className="mt-2 text-xs text-surface-400 truncate" title={simulatedSensors.aiObject}>
                  {simulatedSensors.aiObject}
                </p>
              </div>
            </section>

            {/* ── Interactive Live Map & Movement Simulation ── */}
            <section className="grid gap-4 lg:grid-cols-[1.5fr_0.8fr]">
              {/* Map Canvas */}
              <div className="premium-card flex flex-col overflow-hidden p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="flex items-center gap-2 text-base font-bold text-white">
                      <IconMapPin className="h-4 w-4 text-primary-400" />
                      Live GPS Tracking & Route Trail
                    </h2>
                    <p className="text-xs text-surface-400">Real-time open street coordinates with geofence protection</p>
                  </div>

                  {/* Map Controls */}
                  <div className="flex items-center gap-2">
                    {/* Tile Theme Switcher */}
                    <div className="flex rounded-lg border border-white/10 bg-surface-900 p-0.5 text-xs">
                      {(['dark', 'standard', 'contrast'] as const).map(theme => (
                        <button
                          key={theme}
                          type="button"
                          onClick={() => setMapTileTheme(theme)}
                          className={`rounded-md px-2.5 py-1 text-[11px] font-semibold capitalize transition-all ${mapTileTheme === theme
                            ? 'bg-primary-600 text-white shadow-sm'
                            : 'text-surface-400 hover:text-white'
                            }`}
                        >
                          {theme}
                        </button>
                      ))}
                    </div>

                    {/* Simulate Walk Movement Toggle */}
                    <button
                      type="button"
                      onClick={() => setIsSimulatingWalk(prev => !prev)}
                      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${isSimulatingWalk
                        ? 'border border-warning-500/40 bg-warning-500/20 text-warning-400'
                        : 'border border-white/10 bg-surface-800 text-surface-300 hover:text-white'
                        }`}
                    >
                      <span className={`h-2 w-2 rounded-full ${isSimulatingWalk ? 'bg-warning-400 animate-ping' : 'bg-surface-500'}`} />
                      {isSimulatingWalk ? 'Pause Walk' : 'Simulate Walk'}
                    </button>
                  </div>
                </div>

                {/* Leaflet Map Rendering Container */}
                <div className="relative min-h-[420px] flex-1 overflow-hidden rounded-xl border border-white/10">
                  <LiveMap
                    coords={userCoords}
                    sosActive={sosActive}
                    breadcrumbTrail={breadcrumbTrail}
                    geofenceRadius={settings.geofenceRadius}
                    tileTheme={mapTileTheme}
                  />
                </div>
              </div>

              {/* Side Panels: Telemetry & Radar */}
              <div className="space-y-4">
                {/* ToF Ultrasonic/Laser Distance Radar */}
                <div className="premium-card p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-white">Tri-Directional ToF Ranging</h3>
                      <p className="text-xs text-surface-400">VL53L0X Millimeter Precision Sensors</p>
                    </div>
                    <span className="font-mono-numbers rounded-md border border-white/10 bg-surface-900 px-2 py-0.5 text-xs text-primary-400">
                      I²C Bus
                    </span>
                  </div>

                  <div className="mt-4 space-y-3">
                    {/* Left ToF */}
                    <div>
                      <div className="flex justify-between text-xs">
                        <span className="font-semibold text-surface-300">Left Sector</span>
                        <span className="font-mono-numbers font-bold text-white">{leftDistance} cm</span>
                      </div>
                      <div className="mt-1 h-2 w-full rounded-full bg-surface-800">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${leftDistance < 50 ? 'bg-danger-500' : leftDistance < 100 ? 'bg-warning-500' : 'bg-primary-500'
                            }`}
                          style={{ width: `${Math.min(100, (leftDistance / 200) * 100)}%` }}
                        />
                      </div>
                    </div>

                    {/* Front ToF */}
                    <div>
                      <div className="flex justify-between text-xs">
                        <span className="font-semibold text-surface-300">Front Directional</span>
                        <span className="font-mono-numbers font-bold text-white">{frontDistance} cm</span>
                      </div>
                      <div className="mt-1 h-2 w-full rounded-full bg-surface-800">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${frontDistance < 50 ? 'bg-danger-500' : frontDistance < 100 ? 'bg-warning-500' : 'bg-primary-500'
                            }`}
                          style={{ width: `${Math.min(100, (frontDistance / 200) * 100)}%` }}
                        />
                      </div>
                    </div>

                    {/* Right ToF */}
                    <div>
                      <div className="flex justify-between text-xs">
                        <span className="font-semibold text-surface-300">Right Sector</span>
                        <span className="font-mono-numbers font-bold text-white">{rightDistance} cm</span>
                      </div>
                      <div className="mt-1 h-2 w-full rounded-full bg-surface-800">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${rightDistance < 50 ? 'bg-danger-500' : rightDistance < 100 ? 'bg-warning-500' : 'bg-primary-500'
                            }`}
                          style={{ width: `${Math.min(100, (rightDistance / 200) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 rounded-lg border border-white/[0.06] bg-surface-900/60 p-2.5 text-[11px] text-surface-400">
                    Proximity trigger threshold set to <strong className="text-white">{settings.tofWarningThreshold} cm</strong>. Haptic motors pulse when obstacle enters critical perimeter.
                  </div>
                </div>

                {/* GPS Coordinates & Geofence Details */}
                <div className="premium-card p-5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-surface-400">
                      Telemetry Readout
                    </span>
                    <span className="rounded-full border border-success-500/30 bg-success-500/10 px-2 py-0.5 text-[10px] font-bold text-success-400">
                      GEOFENCE SAFE
                    </span>
                  </div>

                  <div className="mt-3 space-y-2 text-xs">
                    <div className="flex justify-between border-b border-white/[0.05] pb-1.5">
                      <span className="text-surface-400">Latitude</span>
                      <span className="font-mono-numbers font-semibold text-white">{userCoords[0].toFixed(5)}° N</span>
                    </div>
                    <div className="flex justify-between border-b border-white/[0.05] pb-1.5">
                      <span className="text-surface-400">Longitude</span>
                      <span className="font-mono-numbers font-semibold text-white">{userCoords[1].toFixed(5)}° E</span>
                    </div>
                    <div className="flex justify-between border-b border-white/[0.05] pb-1.5">
                      <span className="text-surface-400">Speed</span>
                      <span className="font-mono-numbers font-semibold text-primary-400">{simulatedSensors.speedMps} m/s (Walking)</span>
                    </div>
                    <div className="flex justify-between border-b border-white/[0.05] pb-1.5">
                      <span className="text-surface-400">Heading Compass</span>
                      <span className="font-mono-numbers font-semibold text-white">{simulatedSensors.headingDeg}° NE</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-surface-400">Safe Boundary</span>
                      <span className="font-mono-numbers font-semibold text-surface-200">{settings.geofenceRadius}m radius</span>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* ── Emergency Action Hub & Incident Management ── */}
            <section className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
              {/* Emergency Triggers & Quick Dispatch */}
              <div className="space-y-4">
                {/* Manual SOS Card */}
                <div className="premium-card-danger p-5">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-danger-600 text-white">
                      <IconAlertTriangle className="h-4 w-4" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-white">Tactile SOS Trigger</h3>
                      <p className="text-xs text-surface-400">Simulates chest-mounted tactile button press</p>
                    </div>
                  </div>

                  <p className="mt-3 text-xs leading-relaxed text-surface-300">
                    Instantly triggers a visual siren, audible alarm, and broadcasts emergency GPS coordinates to designated caregivers.
                  </p>

                  <div className="mt-4 flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={triggerSos}
                      disabled={sosActive}
                      className="w-full rounded-xl bg-gradient-to-r from-danger-600 to-rose-600 px-4 py-3 text-sm font-black uppercase tracking-wider text-white shadow-lg shadow-danger-600/30 transition-all hover:from-danger-500 hover:to-rose-500 disabled:opacity-50"
                    >
                      {sosActive ? '⚠ SOS Alarm Broadcasting' : 'Simulate SOS Alert'}
                    </button>

                    <div className="grid grid-cols-2 gap-2">
                      <a
                        href={`tel:${settings.primaryContact}`}
                        className="flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-xs font-bold text-surface-200 hover:bg-surface-800 hover:text-white"
                      >
                        <IconPhone className="h-3.5 w-3.5 text-success-400" />
                        Call ({settings.primaryName.split(' ')[0]})
                      </a>

                      <a
                        href={emergencySmsUrl}
                        className="flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-surface-900 px-3 py-2 text-xs font-bold text-surface-200 hover:bg-surface-800 hover:text-white"
                      >
                        <IconMessageSquare className="h-3.5 w-3.5 text-primary-400" />
                        Dispatch SMS
                      </a>
                    </div>
                  </div>
                </div>

                {/* Fall Alert Simulation */}
                <div className="premium-card p-5">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-warning-600 text-white">
                      <IconShield className="h-4 w-4" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-white">MPU6050 Fall Alert Center</h3>
                      <p className="text-xs text-surface-400">Sudden drop & impact detection</p>
                    </div>
                  </div>

                  <p className="mt-3 text-xs leading-relaxed text-surface-300">
                    Triggers a {settings.fallCountdown}-second verbal check. If unacknowledged, escalates automatically to emergency protocol.
                  </p>

                  <button
                    type="button"
                    onClick={triggerFall}
                    className="mt-4 w-full rounded-xl border border-warning-500/40 bg-warning-500/10 px-4 py-2.5 text-xs font-bold text-warning-400 transition-all hover:bg-warning-500/20"
                  >
                    Simulate Fall Drop Impact
                  </button>
                </div>
              </div>

              {/* Incident Audit Log */}
              <div className="premium-card flex flex-col p-5">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.08] pb-3">
                  <div>
                    <h3 className="text-sm font-bold text-white">Caregiver Incident Audit Log</h3>
                    <p className="text-xs text-surface-400">Timestamped record of events & safety notifications</p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={exportIncidentLogCsv}
                      className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-surface-900 px-2.5 py-1.5 text-xs font-bold text-surface-300 hover:bg-surface-800 hover:text-white"
                    >
                      <IconDownload className="h-3.5 w-3.5" />
                      Export CSV
                    </button>
                    <button
                      type="button"
                      onClick={() => setIncidentLog([])}
                      className="rounded-lg border border-white/10 bg-surface-900 px-2.5 py-1.5 text-xs font-semibold text-surface-400 hover:text-danger-400"
                    >
                      Clear
                    </button>
                  </div>
                </div>

                {/* Filter & Search Bar */}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex gap-1">
                    {(['ALL', 'SOS', 'FALL', 'SYSTEM'] as const).map(f => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setIncidentTypeFilter(f)}
                        className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition-all ${incidentTypeFilter === f
                          ? 'bg-primary-600 text-white'
                          : 'bg-surface-900 text-surface-400 hover:text-white'
                          }`}
                      >
                        {f}
                      </button>
                    ))}
                  </div>

                  <div className="relative min-w-[200px] flex-1 sm:flex-initial">
                    <IconSearch className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-surface-500" />
                    <input
                      type="text"
                      value={incidentSearch}
                      onChange={e => setIncidentSearch(e.target.value)}
                      placeholder="Search audit trail..."
                      className="form-input py-1 pl-8 pr-7 text-xs"
                    />
                    {incidentSearch && (
                      <button
                        type="button"
                        onClick={() => setIncidentSearch('')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-400 hover:text-white"
                      >
                        <IconX className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Incident List */}
                <div className="mt-3 max-h-[290px] flex-1 space-y-2 overflow-y-auto pr-1">
                  {filteredIncidents.length === 0 ? (
                    <div className="py-8 text-center text-xs text-surface-500">
                      No incidents match current filter criteria.
                    </div>
                  ) : (
                    filteredIncidents.map(entry => (
                      <div
                        key={entry.id}
                        className="flex items-start gap-3 rounded-lg border border-white/[0.05] bg-surface-900/60 p-3 text-xs"
                      >
                        <span
                          className={`mt-0.5 rounded px-1.5 py-0.5 font-mono-numbers text-[10px] font-black uppercase tracking-wider ${entry.type === 'SOS'
                            ? 'bg-danger-500/20 text-danger-400 border border-danger-500/30'
                            : entry.type === 'FALL'
                              ? 'bg-warning-500/20 text-warning-400 border border-warning-500/30'
                              : 'bg-surface-800 text-surface-400'
                            }`}
                        >
                          {entry.type}
                        </span>

                        <div className="flex-1">
                          <p className="font-medium text-surface-200">{entry.message}</p>
                          <div className="mt-1 flex items-center gap-3 text-[11px] text-surface-500">
                            <span className="font-mono-numbers">{entry.time}</span>
                            <span>•</span>
                            <span className="font-mono-numbers">{entry.location}</span>
                          </div>
                        </div>

                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${entry.status === 'Active'
                            ? 'bg-danger-500/10 text-danger-400 animate-pulse'
                            : 'text-surface-500'
                            }`}
                        >
                          {entry.status}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </section>
          </div>
        )}

        {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            TAB 2: DEVICE CONFIGURATION & USER SETTINGS
        ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        {activeTab === 'settings' && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-bold tracking-tight text-white">Device Configuration & Preferences</h2>
                <p className="text-xs text-surface-400">Emergency contacts, adaptive feedback thresholds, and safety countdowns</p>
              </div>

              {settingsSaved && (
                <div className="flex items-center gap-2 rounded-lg border border-success-500/30 bg-success-500/10 px-3.5 py-1.5 text-xs font-bold text-success-400">
                  <IconCheck className="h-4 w-4" />
                  Configuration saved & synced to device storage
                </div>
              )}
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              {/* ── Section A: Caregiver Profile Management ── */}
              <div className="premium-card p-5">
                <div className="border-b border-white/[0.08] pb-3">
                  <h3 className="text-sm font-bold text-white">Caregiver Contacts & Dispatch</h3>
                  <p className="text-xs text-surface-400">Registered phone numbers for automated emergency SMS & dialer triggers</p>
                </div>

                <div className="mt-4 space-y-4">
                  {/* Primary Caregiver */}
                  <div className="rounded-xl border border-white/[0.06] bg-surface-900/50 p-4">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-primary-400">
                      Primary Contact (Priority 1)
                    </span>
                    <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
                      <div>
                        <label className="text-[11px] text-surface-400">Full Name</label>
                        <input
                          type="text"
                          value={settings.primaryName}
                          onChange={e => updateSetting('primaryName', e.target.value)}
                          className="form-input mt-1"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-surface-400">Phone Number (E.164)</label>
                        <input
                          type="tel"
                          value={settings.primaryContact}
                          onChange={e => updateSetting('primaryContact', e.target.value)}
                          className="form-input mt-1 font-mono-numbers"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Secondary Caregiver */}
                  <div className="rounded-xl border border-white/[0.06] bg-surface-900/50 p-4">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-surface-400">
                      Secondary Contact (Priority 2)
                    </span>
                    <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
                      <div>
                        <label className="text-[11px] text-surface-400">Full Name</label>
                        <input
                          type="text"
                          value={settings.secondaryName}
                          onChange={e => updateSetting('secondaryName', e.target.value)}
                          className="form-input mt-1"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-surface-400">Phone Number (E.164)</label>
                        <input
                          type="tel"
                          value={settings.secondaryContact}
                          onChange={e => updateSetting('secondaryContact', e.target.value)}
                          className="form-input mt-1 font-mono-numbers"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* ── Section B: Adaptive Feedback Tuning ── */}
              <div className="premium-card p-5">
                <div className="border-b border-white/[0.08] pb-3">
                  <h3 className="text-sm font-bold text-white">Adaptive Sensory Feedback Tuning</h3>
                  <p className="text-xs text-surface-400">Custom volume, haptic vibration intensity, and speech synthesis speed</p>
                </div>

                <div className="mt-4 space-y-5">
                  {/* Audio Volume Slider */}
                  <div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-surface-200">Audio Feedback Volume</span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono-numbers font-bold text-primary-400">{settings.audioVolume}%</span>
                        <button
                          type="button"
                          onClick={testAudioChime}
                          className="rounded border border-primary-500/40 bg-primary-500/10 px-2 py-0.5 text-[10px] font-bold text-primary-300 hover:bg-primary-500/20"
                        >
                          Test Chime
                        </button>
                      </div>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={settings.audioVolume}
                      onChange={e => updateSetting('audioVolume', Number(e.target.value))}
                      className="mt-2"
                    />
                  </div>

                  {/* Vibration Intensity Slider */}
                  <div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-surface-200">Haptic Vibration Intensity</span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono-numbers font-bold text-teal-400">{settings.vibrationIntensity}%</span>
                        <button
                          type="button"
                          onClick={testVibrationFeedback}
                          className="rounded border border-teal-500/40 bg-teal-500/10 px-2 py-0.5 text-[10px] font-bold text-teal-300 hover:bg-teal-500/20"
                        >
                          Test Pulse
                        </button>
                      </div>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={settings.vibrationIntensity}
                      onChange={e => updateSetting('vibrationIntensity', Number(e.target.value))}
                      className="mt-2"
                    />
                  </div>

                  {/* Speech Priority Modes */}
                  <div>
                    <div className="flex items-center justify-between text-xs mb-1.5">
                      <span className="font-semibold text-surface-200">Speech Output Priority Mode</span>
                      <button
                        type="button"
                        onClick={testVoiceFeedback}
                        className="rounded border border-white/20 bg-surface-800 px-2 py-0.5 text-[10px] font-bold text-surface-300 hover:text-white"
                      >
                        Test Voice
                      </button>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {([
                        ['distance', 'Distance First'],
                        ['navigation', 'Navigation First'],
                        ['balanced', 'Balanced'],
                      ] as const).map(([val, label]) => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => updateSetting('speechPriority', val)}
                          className={`rounded-lg py-2 text-xs font-bold transition-all ${settings.speechPriority === val
                            ? 'bg-primary-600 text-white shadow-md shadow-primary-600/30'
                            : 'bg-surface-900 border border-white/[0.08] text-surface-400 hover:text-white'
                            }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* ── Section C: Safety Limits & Emergency Timeouts ── */}
              <div className="premium-card p-5 lg:col-span-2">
                <div className="border-b border-white/[0.08] pb-3">
                  <h3 className="text-sm font-bold text-white">Emergency Escalate Windows & Thresholds</h3>
                  <p className="text-xs text-surface-400">Customize fall countdown duration and perimeter radius</p>
                </div>

                <div className="mt-4 grid gap-5 sm:grid-cols-2">
                  {/* Fall Countdown Window */}
                  <div>
                    <div className="flex justify-between text-xs">
                      <span className="font-semibold text-surface-200">Fall Confirmation Countdown</span>
                      <span className="font-mono-numbers font-bold text-warning-400">{settings.fallCountdown} Seconds</span>
                    </div>
                    <input
                      type="range"
                      min="5"
                      max="30"
                      step="1"
                      value={settings.fallCountdown}
                      onChange={e => updateSetting('fallCountdown', Number(e.target.value))}
                      className="mt-2"
                    />
                    <p className="mt-1 text-[11px] text-surface-400">
                      Elapsed seconds before automatic cloud dispatch if the user does not verbally dismiss.
                    </p>
                  </div>

                  {/* Geofence Perimeter Radius */}
                  <div>
                    <div className="flex justify-between text-xs">
                      <span className="font-semibold text-surface-200">Geofence Safe Radius</span>
                      <span className="font-mono-numbers font-bold text-primary-400">{settings.geofenceRadius} Meters</span>
                    </div>
                    <input
                      type="range"
                      min="50"
                      max="1000"
                      step="25"
                      value={settings.geofenceRadius}
                      onChange={e => updateSetting('geofenceRadius', Number(e.target.value))}
                      className="mt-2"
                    />
                    <p className="mt-1 text-[11px] text-surface-400">
                      Circular safety zone visualized on the caregiver map.
                    </p>
                  </div>
                </div>

                <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.08] pt-4">
                  <button
                    type="button"
                    onClick={() => setSettings(DEFAULT_SETTINGS)}
                    className="text-xs font-semibold text-surface-400 hover:text-white"
                  >
                    Reset Factory Defaults
                  </button>

                  <button
                    type="button"
                    onClick={handleSaveSettings}
                    className="rounded-xl bg-gradient-to-r from-primary-600 to-primary-500 px-6 py-2.5 text-xs font-black uppercase tracking-wider text-white shadow-lg shadow-primary-600/30 hover:from-primary-500 hover:to-primary-400"
                  >
                    Save & Deploy Configuration
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            TAB 3: PRODUCT OVERVIEW & USER DOCUMENTATION
        ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        {activeTab === 'documentation' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-bold tracking-tight text-white">Multimodal Architecture & User Documentation</h2>
              <p className="text-xs text-surface-400">Technical specifications, sensor fusion theory, and wearable setup procedures</p>
            </div>

            {/* ── Sensor Fusion Architecture Cards ── */}
            <section className="grid gap-4 lg:grid-cols-3">
              {/* Card 1: Camera AI */}
              <div className="premium-card p-5">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-600/20 text-primary-400">
                  <IconPulse className="h-5 w-5" />
                </div>
                <h3 className="mt-3 text-sm font-bold text-white">Stage 1: Semantic Vision (AI)</h3>
                <p className="mt-2 text-xs leading-relaxed text-surface-300">
                  Smartphone camera captures 30 FPS video frames evaluated on-device using a quantized YOLO / MobileNet architecture. Identifies <em>what</em> an object is (chair, doorway, vehicle, stairs).
                </p>
                <div className="mt-3 rounded-lg border border-white/[0.06] bg-surface-900/60 p-2.5 font-mono-numbers text-[11px] text-surface-400">
                  Inference latency: ~28ms on Mobile GPU
                </div>
              </div>

              {/* Card 2: 3x ToF Laser Distance */}
              <div className="premium-card p-5">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-600/20 text-teal-400">
                  <IconCompass className="h-5 w-5" />
                </div>
                <h3 className="mt-3 text-sm font-bold text-white">Stage 2: ToF Laser Ranging</h3>
                <p className="mt-2 text-xs leading-relaxed text-surface-300">
                  Three VL53L0X Time-of-Flight sensors on the chest harness emit 940nm eye-safe VCSEL laser photons. Measures exact distance in centimeters, eliminating AI depth hallucinations.
                </p>
                <div className="mt-3 rounded-lg border border-white/[0.06] bg-surface-900/60 p-2.5 font-mono-numbers text-[11px] text-surface-400">
                  Physics: d = (c × Δt) / 2 • Range: 200cm
                </div>
              </div>

              {/* Card 3: Kinematic IMU */}
              <div className="premium-card p-5">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-warning-600/20 text-warning-400">
                  <IconShield className="h-5 w-5" />
                </div>
                <h3 className="mt-3 text-sm font-bold text-white">Stage 3: Spatial Kinematics (IMU)</h3>
                <p className="mt-2 text-xs leading-relaxed text-surface-300">
                  MPU6050 6-axis gyroscope and accelerometer measures wearer orientation, sudden vertical velocity drops, and high-impact decelerations for reliable fall protection.
                </p>
                <div className="mt-3 rounded-lg border border-white/[0.06] bg-surface-900/60 p-2.5 font-mono-numbers text-[11px] text-surface-400">
                  Sampling rate: 50Hz • Impact threshold: 2.5G
                </div>
              </div>
            </section>

            {/* ── Step-by-Step Hardware Pairing Guide ── */}
            <section className="premium-card p-5">
              <h3 className="text-sm font-bold text-white">Setup & Pairing Walkthrough</h3>
              <p className="text-xs text-surface-400">Follow these instructions to connect the ESP32 wearable device</p>

              <div className="mt-4 grid gap-4 md:grid-cols-3">
                <div className="rounded-xl border border-white/[0.06] bg-surface-900/60 p-4">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary-600 text-xs font-black text-white">
                    1
                  </div>
                  <h4 className="mt-2.5 text-xs font-bold text-white">Power On ESP32 Wearable</h4>
                  <p className="mt-1.5 text-[11px] text-surface-400 leading-relaxed">
                    Slide the power switch on the chest module. The onboard blue LED will pulse, indicating Bluetooth Low Energy (BLE) advertisement mode under <strong className="text-white">SmartVision-ESP32</strong>.
                  </p>
                </div>

                <div className="rounded-xl border border-white/[0.06] bg-surface-900/60 p-4">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary-600 text-xs font-black text-white">
                    2
                  </div>
                  <h4 className="mt-2.5 text-xs font-bold text-white">Web Bluetooth Pairing</h4>
                  <p className="mt-1.5 text-[11px] text-surface-400 leading-relaxed">
                    In a Chromium browser, click <strong className="text-primary-400">Pair ESP32 (BLE)</strong> in the top header. Select <code className="text-xs font-mono">SmartVision-ESP32</code> from the device list to open telemetry streaming.
                  </p>
                </div>

                <div className="rounded-xl border border-white/[0.06] bg-surface-900/60 p-4">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary-600 text-xs font-black text-white">
                    3
                  </div>
                  <h4 className="mt-2.5 text-xs font-bold text-white">Wear Harness & Verify Sensors</h4>
                  <p className="mt-1.5 text-[11px] text-surface-400 leading-relaxed">
                    Fasten the chest strap so the center VL53L0X faces straight ahead at sternum level. Verify real-time distance readouts in the dashboard radar panel.
                  </p>
                </div>
              </div>
            </section>

            {/* ── ESP32 BLE GATT Specifications ── */}
            <section className="premium-card p-5">
              <h3 className="text-sm font-bold text-white">GATT Service Characteristics & Protocol</h3>
              <p className="text-xs text-surface-400">Bluetooth Low Energy service and characteristic UUID definitions</p>

              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-white/[0.08] text-surface-400">
                      <th className="pb-2 font-semibold">Channel</th>
                      <th className="pb-2 font-semibold">UUID</th>
                      <th className="pb-2 font-semibold">Type</th>
                      <th className="pb-2 font-semibold">Payload Specification</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.05] text-surface-200">
                    <tr>
                      <td className="py-2.5 font-bold text-white">Telemetry Channel</td>
                      <td className="py-2.5 font-mono-numbers text-[11px] text-primary-400">19b10001-e8f2-537e-4f6c-d104768a1214</td>
                      <td className="py-2.5"><span className="rounded bg-surface-800 px-1.5 py-0.5 text-[10px]">NOTIFY</span></td>
                      <td className="py-2.5 text-surface-400">JSON: <code className="text-white">{"{left, front, right, battery, fall, sos}"}</code></td>
                    </tr>
                    <tr>
                      <td className="py-2.5 font-bold text-white">Command Channel</td>
                      <td className="py-2.5 font-mono-numbers text-[11px] text-primary-400">19b10002-e8f2-537e-4f6c-d104768a1214</td>
                      <td className="py-2.5"><span className="rounded bg-surface-800 px-1.5 py-0.5 text-[10px]">WRITE</span></td>
                      <td className="py-2.5 text-surface-400">JSON: <code className="text-white">{"{\"command\":\"vibrate\",\"side\":\"left\"}"}</code></td>
                    </tr>
                    <tr>
                      <td className="py-2.5 font-bold text-white">Status Channel</td>
                      <td className="py-2.5 font-mono-numbers text-[11px] text-primary-400">19b10003-e8f2-537e-4f6c-d104768a1214</td>
                      <td className="py-2.5"><span className="rounded bg-surface-800 px-1.5 py-0.5 text-[10px]">READ</span></td>
                      <td className="py-2.5 text-surface-400">UTF-8 status string (e.g. "ready", "low_batt")</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            {/* ── Academic & Safety Disclaimer ── */}
            <section className="rounded-xl border border-white/[0.08] bg-surface-900/40 p-5 text-xs text-surface-400">
              <h4 className="font-bold text-surface-200 uppercase tracking-wider text-[11px]">Academic Prototype Safety Notice</h4>
              <p className="mt-2 leading-relaxed">
                SmartVision is an academic assistive technology research prototype engineered to explore multimodal sensor fusion for visual impairment navigation. The hardware and dashboard interface are designed to complement, not replace, primary mobility aids such as white canes or guide dogs. It is not a certified Class II/III medical diagnostic device.
              </p>
            </section>
          </div>
        )}
      </main>

      {/* ── Interactive Fall Detection Modal Dialog ── */}
      {fallModal && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/85 p-4 backdrop-blur-md"
          role="alertdialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md overflow-hidden rounded-2xl border border-danger-500/50 bg-surface-900 shadow-2xl">
            <div className="border-b border-danger-500/30 bg-danger-600/20 px-6 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-danger-600 text-white animate-pulse">
                  <IconAlertTriangle className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-base font-black text-white">Fall Detected — Verbal Confirmation</h3>
                  <p className="text-xs text-danger-300">MPU6050 high acceleration threshold exceeded</p>
                </div>
              </div>
            </div>

            <div className="p-6">
              <p className="text-xs text-surface-300 leading-relaxed">
                The wearable sensor detected an abnormal drop and impact. Emergency escalation to caregiver contacts will execute automatically when the countdown expires.
              </p>

              <div className="my-6 flex items-center justify-center">
                <div className="flex h-24 w-24 items-center justify-center rounded-full border-4 border-danger-500/40 bg-danger-500/10 shadow-lg shadow-danger-500/20">
                  <span className="font-mono-numbers text-4xl font-black text-danger-400">
                    {fallCountdown}
                  </span>
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={dismissFall}
                  className="flex-1 rounded-xl bg-success-600 px-4 py-3 text-xs font-black uppercase tracking-wider text-white shadow-lg shadow-success-600/25 hover:bg-success-500"
                >
                  I'm OK — Dismiss
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setFallModal(false)
                    setSosActive(true)
                    soundManager.startEmergencySiren(isSirenMuted)
                    addIncident('FALL', 'Fall alert manually escalated by user')
                  }}
                  className="flex-1 rounded-xl bg-danger-600 px-4 py-3 text-xs font-black uppercase tracking-wider text-white shadow-lg shadow-danger-600/25 hover:bg-danger-500"
                >
                  Send Alert Now
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Footer ── */}
      <footer className="border-t border-white/[0.06] bg-surface-950 py-6 text-xs text-surface-500">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-4 sm:flex-row sm:px-6">
          <p>© 2026 SmartVision Assistive Technologies • Cloud-synced IoT Wearable Platform</p>
          <div className="flex items-center gap-3">
            <span className="font-mono-numbers">OpenStreetMap Data</span>
            <span>•</span>
            <span className="font-mono-numbers">Web Bluetooth API</span>
          </div>
        </div>
      </footer>
    </div>
  )
}

export default App
