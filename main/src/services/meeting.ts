// Render-hosted FastAPI backend URL (configured via environment variable)
const API_BASE_URL = import.meta.env.VITE_JITSI_BACKEND_URL;
const JITSI_MEET_URL = 'https://server-vmtb-v2.3billionpairs.com';
const POLL_INTERVAL = 5000; // 5 seconds
const MAX_POLL_TIME = 90000; // 90 seconds

interface StartJitsiResponse {
  status: 'already_running' | 'starting';
}

type MeetingState = 'WAITING' | 'FIRST_READY' | 'OPENED';

export class MeetingService {
  private pollingInterval: NodeJS.Timeout | null = null;
  private pollStartTime: number = 0;
  private state: MeetingState = 'WAITING';
  private alreadyRunningCount: number = 0;

  /**
   * Start the Jitsi server and wait until it's ready
   * State machine:
   * - WAITING: Initial state, poll backend
   * - FIRST_READY: Received first "already_running", wait for second
   * - OPENED: Received second "already_running", ready to open meeting
   */
  async startMeeting(): Promise<void> {
    this.state = 'WAITING';
    this.alreadyRunningCount = 0;
    this.pollStartTime = Date.now();

    // Debug logging removed for security (F9)
    // Debug logging removed for security (F9)
    // Debug logging removed for security (F9)
    // Debug logging removed for security (F9)

    // Begin polling
    return this.pollUntilReady();
  }

  /**
   * Call the start-jitsi endpoint
   */
  private async callStartJitsi(): Promise<StartJitsiResponse> {
    try {
      if (!API_BASE_URL) {
        throw new Error('Jitsi backend URL is not configured. Please check your environment variables.');
      }

      const requestTime = Date.now();
      const elapsed = requestTime - this.pollStartTime;
      
      // Debug logging removed for security (F9)
      // Debug logging removed for security (F9)

      const response = await fetch(`${API_BASE_URL}/start-jitsi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      const data = await response.json();
      const responseTime = Date.now();
      const callDuration = responseTime - requestTime;
      
      // Debug logging removed for security (F9)
      // Debug logging removed for security (F9)
      
      return data as StartJitsiResponse;
    } catch (error) {
      // Debug logging removed for security (F9)
      throw new Error('Unable to start meeting server. Please try again.');
    }
  }

  /**
   * Poll the server every 5 seconds until it's ready or timeout
   * State transitions:
   * - "starting" in WAITING state → continue polling
   * - first "already_running" in WAITING state → move to FIRST_READY, continue polling
   * - "already_running" in FIRST_READY state → move to OPENED, resolve Promise
   */
  private pollUntilReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Debug logging removed for security (F9)
      
      this.pollingInterval = setInterval(async () => {
        // Check if we've exceeded max poll time
        const elapsed = Date.now() - this.pollStartTime;
        // Debug logging removed for security (F9)
        
        if (elapsed > MAX_POLL_TIME) {
          // Debug logging removed for security (F9)
          this.stopPolling();
          this.state = 'WAITING';
          this.alreadyRunningCount = 0;
          reject(new Error('Meeting server is taking longer than expected. Please try again.'));
          return;
        }

        try {
          const response = await this.callStartJitsi();

          if (response.status === 'already_running') {
            this.alreadyRunningCount++;
            // Debug logging removed for security (F9)

            if (this.state === 'WAITING') {
              // First "already_running" response - move to FIRST_READY
              this.state = 'FIRST_READY';
              // Debug logging removed for security (F9)
              // Debug logging removed for security (F9)
              // Continue polling - do NOT resolve yet
            } else if (this.state === 'FIRST_READY') {
              // Second "already_running" response - server is truly ready
              this.state = 'OPENED';
              // Debug logging removed for security (F9)
              // Debug logging removed for security (F9)
              this.stopPolling();
              this.alreadyRunningCount = 0;
              // Debug logging removed for security (F9)
              resolve();
            }
          } else if (response.status === 'starting') {
            // Server is still starting - continue polling
            // Debug logging removed for security (F9)
          }
        } catch (error) {
          // Debug logging removed for security (F9)
          this.stopPolling();
          this.state = 'WAITING';
          this.alreadyRunningCount = 0;
          reject(error);
        }
      }, POLL_INTERVAL);
    });
  }

  /**
   * Stop the polling interval
   */
  private stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  /**
   * Sanitize meeting room name to avoid 404 errors
   * - Convert to lowercase
   * - Trim spaces
   * - Remove commas
   * - Replace multiple spaces with single hyphen
   * - Remove all special characters except a-z, 0-9, and hyphen
   */
  private sanitizeMeetingName(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/,/g, '')
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');
  }

  /**
   * Construct the meeting loader URL with sanitized room name
   * This URL points to the Vercel frontend which handles the full meeting flow
   */
  getMeetingUrl(roomName: string): string {
    const sanitizedRoom = this.sanitizeMeetingName(roomName);
    const fullUrl = `${JITSI_MEET_URL}/${sanitizedRoom}`;
    // Debug logging removed for security (F9)
    // Debug logging removed for security (F9)
    // Debug logging removed for security (F9)
    return fullUrl;
  }

  /**
   * Get sanitized meeting room name
   */
  getMeetingRoomName(roomName: string): string {
    return this.sanitizeMeetingName(roomName);
  }

  /**
   * Clean up resources (no-op for this simplified service)
   */
  cleanup(): void {
    // No polling or resources to clean up
  }
}

