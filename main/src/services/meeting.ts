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

    console.log('🚀 [MEETING] startMeeting() called');
    console.log('🚀 [MEETING] Initial state:', this.state);
    console.log('🚀 [MEETING] Backend URL:', API_BASE_URL);
    console.log('🚀 [MEETING] Starting poll interval...');

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
      
      console.log(`📡 [API CALL #${this.alreadyRunningCount + 1}] Calling ${API_BASE_URL}/start-jitsi`);
      console.log(`⏱️  [TIMING] Elapsed: ${elapsed}ms, State: ${this.state}, Counter: ${this.alreadyRunningCount}`);

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
      
      console.log(`✅ [API RESPONSE] Status: "${data.status}", Duration: ${callDuration}ms`);
      console.log(`✅ [API RESPONSE] Full response:`, data);
      
      return data as StartJitsiResponse;
    } catch (error) {
      console.error('❌ [API ERROR] Error calling start-jitsi:', error);
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
      console.log('🔄 [POLL] Starting polling loop...');
      
      this.pollingInterval = setInterval(async () => {
        // Check if we've exceeded max poll time
        const elapsed = Date.now() - this.pollStartTime;
        console.log(`🔄 [POLL] Interval tick at ${elapsed}ms`);
        
        if (elapsed > MAX_POLL_TIME) {
          console.log('⏹️  [TIMEOUT] Max poll time exceeded (90s)');
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
            console.log(`🎯 [STATE] Received "already_running" (count: ${this.alreadyRunningCount})`);

            if (this.state === 'WAITING') {
              // First "already_running" response - move to FIRST_READY
              this.state = 'FIRST_READY';
              console.log('🟡 [STATE TRANSITION] WAITING → FIRST_READY');
              console.log('🟡 [STATE] Server initially ready. Continuing to poll for 2nd confirmation...');
              // Continue polling - do NOT resolve yet
            } else if (this.state === 'FIRST_READY') {
              // Second "already_running" response - server is truly ready
              this.state = 'OPENED';
              console.log('🟢 [STATE TRANSITION] FIRST_READY → OPENED');
              console.log('🟢 [STATE] Server fully ready! Stopping polling and resolving Promise...');
              this.stopPolling();
              this.alreadyRunningCount = 0;
              console.log('✅ [RESOLVE] Promise will resolve NOW - window.open() should be called next!');
              resolve();
            }
          } else if (response.status === 'starting') {
            // Server is still starting - continue polling
            console.log('🟠 [STATE] Server still starting, continuing to poll...');
          }
        } catch (error) {
          console.error('❌ [POLL ERROR] Error during polling:', error);
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
   * This URL points to server.vmtb.in which handles the full meeting flow
   */
  getMeetingUrl(roomName: string): string {
    const sanitizedRoom = this.sanitizeMeetingName(roomName);
    const fullUrl = `${JITSI_MEET_URL}/${sanitizedRoom}`;
    console.log(`🔗 [URL] Room name input: "${roomName}"`);
    console.log(`🔗 [URL] Sanitized room name: "${sanitizedRoom}"`);
    console.log(`🔗 [URL] Full meeting URL: "${fullUrl}"`);
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

