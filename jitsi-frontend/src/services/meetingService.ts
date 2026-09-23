import { debugLog } from '../utils/sanitization'

export type ComponentState = {
  state?: string
  detail?: string
  https?: string
}

export type StartJitsiResponse = {
  status: string
  components?: Record<string, ComponentState>
}

export class MeetingService {
  private pollingInterval: ReturnType<typeof setTimeout> | null = null
  private abortController: AbortController | null = null
  private isCleanedUp = false
  private lastComponents: Record<string, ComponentState> = {}

  async waitForMeetingReady(): Promise<void> {
    debugLog('[POLLING] ========================================')
    debugLog('[POLLING] Starting polling sequence')
    debugLog('[POLLING] Backend:', import.meta.env.VITE_JITSI_BACKEND_URL)
    debugLog('[POLLING] Max timeout: 5 minutes (60 × 5s)')
    this.isCleanedUp = false
    return this.pollUntilReady()
  }

  getComponents(): Record<string, ComponentState> {
    return this.lastComponents
  }

  private async callStartJitsi(): Promise<StartJitsiResponse> {
    const backendUrl = import.meta.env.VITE_JITSI_BACKEND_URL
    const endpoint = `${backendUrl}/start-jitsi`

    debugLog(`[API] POST ${endpoint}`)

    const controller = new AbortController()
    this.abortController = controller
    const timeoutId = setTimeout(() => controller.abort(), 30000)

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const data = (await response.json()) as StartJitsiResponse
      debugLog(`[API] Response: ${data.status}`)
      if (data.components) {
        this.lastComponents = data.components
        debugLog('[API] Components:', data.components)
      }
      return data
    } catch (error) {
      clearTimeout(timeoutId)

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          debugLog('[API] Request timed out')
        } else if (error.message.includes('Failed to fetch')) {
          debugLog('[API] Network error (CORS or server down)')
        } else {
          debugLog(`[API] Error: ${error.message}`)
        }
      }
      throw error
    }
  }

  private async pollUntilReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      let callCount = 0
      const maxCalls = 60 // 5 minutes
      const startTime = Date.now()
      let consecutiveErrors = 0

      const poll = async () => {
        // Check if cleaned up
        if (this.isCleanedUp) {
          debugLog('[POLL] Stopped (cleaned up)')
          return
        }

        callCount++
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
        debugLog(`[POLL] Attempt ${callCount}/${maxCalls} (${elapsed}s elapsed)`)

        // Timeout check
        if (callCount > maxCalls) {
          debugLog('[POLL] ❌ Timeout reached')
          this.cleanup()
          reject(new Error('Server startup timeout'))
          return
        }

        try {
          const response = await this.callStartJitsi()
          consecutiveErrors = 0 // Reset on success

          if (response.status === 'already_running') {
            debugLog('[POLL] ✓✓✓ Server is READY!')
            this.cleanup()
            resolve()
            return
          }

          if (response.status === 'starting') {
            const notReady = Object.entries(this.lastComponents)
              .filter(([, c]) => c.state !== 'ready')
              .map(([name, c]) => `${name}${c.detail ? ` (${c.detail})` : ''}`)
              .join(', ')
            debugLog(
              notReady
                ? `[POLL] Server starting... waiting on: ${notReady}`
                : '[POLL] Server starting...'
            )
          } else {
            debugLog(`[POLL] Unknown status: ${response.status}`)
          }
        } catch (error) {
          consecutiveErrors++
          debugLog(`[POLL] Error (attempt ${consecutiveErrors})`)
          
          // Don't fail immediately on network errors - keep polling
          // Only fail after many consecutive errors
          if (consecutiveErrors >= 10) {
            debugLog('[POLL] ❌ Too many consecutive errors')
            this.cleanup()
            reject(new Error('Unable to connect to server'))
            return
          }
        }

        // Schedule next poll if not cleaned up
        if (!this.isCleanedUp) {
          this.pollingInterval = setTimeout(poll, 5000)
        }
      }

      // Start first poll immediately
      debugLog('[POLL] Starting first poll')
      poll()
    })
  }

  cleanup(): void {
    if (this.isCleanedUp) return
    this.isCleanedUp = true
    
    debugLog('[CLEANUP] Cleaning up MeetingService')
    
    if (this.pollingInterval) {
      clearTimeout(this.pollingInterval)
      this.pollingInterval = null
    }
    
    if (this.abortController) {
      try {
        this.abortController.abort()
      } catch (e) {
        // Ignore
      }
      this.abortController = null
    }
    
    debugLog('[CLEANUP] Done')
  }
}
