import { debugLog } from '../utils/sanitization'
import type { ComponentState } from '../services/meetingService'

interface MeetingLoaderProps {
  elapsedSeconds: number
  components?: Record<string, ComponentState>
}

const COMPONENT_LABELS: Record<string, string> = {
  jvb: 'Jitsi server',
  stt: 'Speech recognition',
  proxy: 'Transcription proxy',
}

function componentLine(components?: Record<string, ComponentState>): string {
  if (!components || Object.keys(components).length === 0) {
    return 'Connecting to server...'
  }
  const notReady = Object.entries(components).filter(([, c]) => c.state !== 'ready')
  if (notReady.length === 0) {
    return 'Finalizing connection...'
  }
  return notReady
    .map(([name, c]) => {
      const label = COMPONENT_LABELS[name] ?? name
      if (c.detail) return `${label}: ${c.detail}`
      return `${label}: ${c.state ?? 'starting'}`
    })
    .join(' · ')
}

export default function MeetingLoader({
  elapsedSeconds,
  components,
}: MeetingLoaderProps) {
  debugLog(`[LOADER] Rendering (${elapsedSeconds}s)`)

  return (
    <div className="loader-container" style={{ minHeight: '100vh', width: '100%' }}>
      <div className="loader-content">
        <div className="spinner"></div>
        <h2 className="loader-title">Initializing Meeting</h2>
        <p className="loader-status">
          <span className="status-badge">{componentLine(components)}</span>
        </p>
        <p className="loader-time">
          {elapsedSeconds} second{elapsedSeconds !== 1 ? 's' : ''} elapsed
        </p>
        <p className="loader-info">Please wait while we set up your meeting room</p>
      </div>
    </div>
  )
}
