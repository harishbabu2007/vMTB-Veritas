import { useState, useEffect, useRef, useCallback } from 'react'
import MeetingLoader from '../components/MeetingLoader'
import ErrorPage from '../components/ErrorPage'
import ThankYouPage from '../components/ThankYouPage'
import { MeetingService, type ComponentState } from '../services/meetingService'
import { meetingAnalytics } from '../services/meetingAnalytics'
import { getMeetingParamsFromUrl, debugLog } from '../utils/sanitization'

type PageState = 'LOADING' | 'READY' | 'ERROR' | 'THANK_YOU'

declare global {
  interface Window {
    JitsiMeetExternalAPI: any
  }
}

export default function MeetingPage() {
  const [state, setState] = useState<PageState>('LOADING')
  const [error, setError] = useState<string>('')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [components, setComponents] = useState<Record<string, ComponentState>>({})

  // Refs for preventing double initialization and cleanup
  const isInitializedRef = useRef(false)
  const meetingServiceRef = useRef<MeetingService | null>(null)
  const jitsiApiRef = useRef<any>(null)
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const roomNameRef = useRef<string>('')
  const mtbIdRef = useRef<string>('')
  const jitsiContainerRef = useRef<HTMLDivElement | null>(null)
  const analyticsInitializedRef = useRef(false)

  // Cleanup timer
  const stopTimer = useCallback(() => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current)
      timerIntervalRef.current = null
      debugLog('[TIMER] Stopped')
    }
  }, [])

  // Start timer
  const startTimer = useCallback(() => {
    stopTimer() // Clear any existing timer first
    debugLog('[TIMER] Starting')
    timerIntervalRef.current = setInterval(() => {
      setElapsedSeconds(prev => prev + 1)
    }, 1000)
  }, [stopTimer])

  // Handle meeting end - show thank you page
  const handleMeetingEnd = useCallback(() => {
    debugLog('[MEETING-END] ========================================')
    debugLog('[MEETING-END] User left the conference')

    // Track local participant leaving for analytics
    meetingAnalytics.onLocalParticipantLeft('normal')

    // Dispose Jitsi API
    if (jitsiApiRef.current) {
      try {
        jitsiApiRef.current.dispose()
        jitsiApiRef.current = null
        debugLog('[MEETING-END] ✓ Jitsi disposed')
      } catch (e) {
        debugLog('[MEETING-END] Dispose error (ignored):', e)
      }
    }

    // Clear container
    if (jitsiContainerRef.current) {
      jitsiContainerRef.current.innerHTML = ''
      jitsiContainerRef.current.style.display = 'none'
      debugLog('[MEETING-END] ✓ Container cleared')
    }

    // Show thank you page
    debugLog('[MEETING-END] Showing thank you page')
    setState('THANK_YOU')
  }, [])

  // Initialize Jitsi in the container
  const initJitsiInContainer = useCallback((container: HTMLDivElement) => {
    debugLog('[JITSI] ========================================')
    debugLog('[JITSI] Initializing in container')
    debugLog('[JITSI] Room:', roomNameRef.current)
    debugLog('[JITSI] Domain:', import.meta.env.VITE_JITSI_DOMAIN)

    try {
      const api = new window.JitsiMeetExternalAPI(
        import.meta.env.VITE_JITSI_DOMAIN,
        {
          roomName: roomNameRef.current,
          parentNode: container,
          width: '100%',
          height: '100%',
          configOverwrite: {
            disableSimulcast: false,
            enableWelcomePage: false,
            prejoinPageEnabled: false,
            startAudioMuted: false,
            startVideoMuted: false,
          },
          interfaceConfigOverwrite: {
            SHOW_JITSI_WATERMARK: false,
            SHOW_BRAND_WATERMARK: false,
            SHOW_POWERED_BY: false,
            HIDE_INVITE_MORE_HEADER: true,
          },
        }
      )

      jitsiApiRef.current = api
      debugLog('[JITSI] ✓ API created')

      // ========================================
      // Analytics Event Handlers
      // ========================================

      // Track when local user joins the conference
      api.addEventListener('videoConferenceJoined', (event: { roomName: string; id: string; displayName?: string }) => {
        debugLog('[JITSI] Event: videoConferenceJoined', event)
        // Local user has joined - this triggers meeting session creation
        meetingAnalytics.onLocalParticipantJoined(event.id, event.displayName)
      })

      // Track when a remote participant joins
      api.addEventListener('participantJoined', (event: { id: string; displayName?: string }) => {
        debugLog('[JITSI] Event: participantJoined', event)
        meetingAnalytics.onParticipantJoined(event.id, event.displayName)
      })

      // Track when a remote participant leaves
      api.addEventListener('participantLeft', (event: { id: string }) => {
        debugLog('[JITSI] Event: participantLeft', event)
        meetingAnalytics.onParticipantLeft(event.id)
      })

      // Track disconnection (network issues)
      api.addEventListener('videoConferenceLeft', (event: { roomName: string }) => {
        debugLog('[JITSI] Event: videoConferenceLeft', event)
        handleMeetingEnd()
      })

      api.addEventListener('readyToClose', () => {
        debugLog('[JITSI] Event: readyToClose')
        handleMeetingEnd()
      })

      // Track when participant's display name changes (optional, for better tracking)
      api.addEventListener('displayNameChange', (event: { id: string; displayname: string }) => {
        debugLog('[JITSI] Event: displayNameChange', event)
      })

      debugLog('[JITSI] ========================================')
      return true
    } catch (err) {
      debugLog('[JITSI] ❌ Init error:', err)
      return false
    }
  }, [handleMeetingEnd])

  // Load Jitsi external API script with retries
  const loadJitsiScript = useCallback((): Promise<void> => {
    const domain = import.meta.env.VITE_JITSI_DOMAIN
    const scriptUrl = `https://${domain}/external_api.js`
    const maxRetries = 6
    const retryDelay = 5000 // 5 seconds between retries

    const attemptLoad = (attempt: number): Promise<void> => {
      return new Promise((resolve, reject) => {
        // Already loaded
        if (window.JitsiMeetExternalAPI) {
          debugLog('[SCRIPT] Already loaded')
          resolve()
          return
        }

        // Remove any failed script tags from previous attempts
        const existingFailed = document.querySelector('script[src*="external_api.js"]')
        if (existingFailed && !window.JitsiMeetExternalAPI) {
          existingFailed.remove()
        }

        debugLog(`[SCRIPT] Loading (attempt ${attempt}/${maxRetries}): ${scriptUrl}`)

        const script = document.createElement('script')
        script.src = scriptUrl
        script.async = true
        
        script.onload = () => {
          debugLog('[SCRIPT] ✓ Loaded')
          resolve()
        }
        
        script.onerror = () => {
          debugLog(`[SCRIPT] ❌ Failed (attempt ${attempt})`)
          
          // Remove the failed script tag
          script.remove()
          
          if (attempt < maxRetries) {
            debugLog(`[SCRIPT] Retrying in ${retryDelay/1000}s...`)
            setTimeout(() => {
              attemptLoad(attempt + 1).then(resolve).catch(reject)
            }, retryDelay)
          } else {
            reject(new Error('Failed to load Jitsi script after multiple attempts'))
          }
        }
        
        document.head.appendChild(script)
      })
    }

    return attemptLoad(1)
  }, [])

  // Main initialization effect
  useEffect(() => {
    // Prevent double initialization (React StrictMode)
    if (isInitializedRef.current) {
      debugLog('[INIT] Already initialized, skipping')
      return
    }
    isInitializedRef.current = true

    debugLog('[INIT] ========================================')
    debugLog('[INIT] Starting initialization')
    debugLog('[INIT] URL:', window.location.href)

    // Get meeting parameters from URL (room, mtb_id, mtb_name)
    const meetingParams = getMeetingParamsFromUrl()
    
    if (!meetingParams.roomName) {
      debugLog('[INIT] ❌ No room in URL')
      setError('No room name provided. Please start the meeting from the main app.')
      setState('ERROR')
      return
    }
    
    roomNameRef.current = meetingParams.roomName
    mtbIdRef.current = meetingParams.mtbId || ''
    debugLog('[INIT] Room:', meetingParams.roomName)
    debugLog('[INIT] MTB ID:', meetingParams.mtbId)
    debugLog('[INIT] MTB Name:', meetingParams.mtbName)

    // Initialize analytics if mtb_id is available
    if (meetingParams.mtbId && !analyticsInitializedRef.current) {
      analyticsInitializedRef.current = true
      meetingAnalytics.initialize({
        roomName: meetingParams.roomName,
        mtbId: meetingParams.mtbId,
        mtbName: meetingParams.mtbName || undefined,
      }).then((success) => {
        debugLog('[INIT] Analytics initialized:', success)
      })
    }

    // Start the elapsed time timer
    startTimer()

    // Create meeting service and start polling
    const service = new MeetingService()
    meetingServiceRef.current = service

    debugLog('[INIT] Starting polling...')

    // Surface which components are still coming up while we wait.
    const componentPoll = setInterval(() => {
      if (meetingServiceRef.current) {
        setComponents(meetingServiceRef.current.getComponents())
      }
    }, 2000)

    service.waitForMeetingReady()
      .then(async () => {
        debugLog('[INIT] ✓ Server ready!')
        clearInterval(componentPoll)
        setComponents(service.getComponents())
        // Note: Keep timer running during script loading

        // Load Jitsi script (may take time with retries)
        debugLog('[INIT] Loading Jitsi script...')
        await loadJitsiScript()

        // Stop timer only after script loads successfully
        stopTimer()

        // Now set state to READY which will render the container
        debugLog('[INIT] Setting state to READY')
        setState('READY')
      })
      .catch((err) => {
        debugLog('[INIT] ❌ Polling error:', err)
        clearInterval(componentPoll)
        stopTimer()

        // Ignore abort errors
        if (err?.message?.includes('abort')) {
          debugLog('[INIT] Abort error ignored')
          return
        }

        setError('Unable to connect to meeting server. Please try again.')
        setState('ERROR')
      })

    // Cleanup function
    return () => {
      debugLog('[INIT] Cleanup on unmount')
      clearInterval(componentPoll)
      stopTimer()
      if (meetingServiceRef.current) {
        meetingServiceRef.current.cleanup()
        meetingServiceRef.current = null
      }
      // Cleanup analytics
      meetingAnalytics.cleanup()
      analyticsInitializedRef.current = false
      // Reset initialization flag so StrictMode remount can re-initialize
      isInitializedRef.current = false
    }
  }, [startTimer, stopTimer, loadJitsiScript])

  // Effect to initialize Jitsi when container is available (READY state)
  useEffect(() => {
    if (state !== 'READY') return
    if (!jitsiContainerRef.current) return
    if (jitsiApiRef.current) return // Already initialized

    debugLog('[EFFECT] Container ready, initializing Jitsi...')
    
    const success = initJitsiInContainer(jitsiContainerRef.current)
    if (!success) {
      setError('Failed to start meeting. Please try again.')
      setState('ERROR')
    }
  }, [state, initJitsiInContainer])

  // Retry handler
  const handleRetry = useCallback(() => {
    debugLog('[RETRY] Reloading page')
    window.location.reload()
  }, [])

  // Back handler
  const handleBack = useCallback(() => {
    debugLog('[NAV] Going back')
    stopTimer()
    if (meetingServiceRef.current) {
      meetingServiceRef.current.cleanup()
    }
    window.location.href = import.meta.env.VITE_MAIN_APP_URL || 'http://localhost:5173'
  }, [stopTimer])

  // ===== RENDER =====

  if (state === 'LOADING') {
    return <MeetingLoader elapsedSeconds={elapsedSeconds} components={components} />
  }

  if (state === 'ERROR') {
    return <ErrorPage error={error} onRetry={handleRetry} onBack={handleBack} />
  }

  if (state === 'THANK_YOU') {
    return <ThankYouPage />
  }

  // READY state: Render the Jitsi container
  return (
    <div 
      ref={jitsiContainerRef}
      id="jitsi-container" 
      style={{ 
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100%',
        height: '100%',
        margin: 0,
        padding: 0,
        backgroundColor: '#000',
        zIndex: 9999,
        overflow: 'hidden'
      }} 
    />
  )
}
