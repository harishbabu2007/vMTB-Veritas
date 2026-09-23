import { getSupabaseClient, isSupabaseConfigured } from '../lib/supabase';

/**
 * Meeting Analytics Service - Correct Flow
 * 
 * PRINCIPLES:
 * 1. Frontend ONLY creates/updates its OWN records
 * 2. Frontend NEVER closes/modifies other meetings
 * 3. Stale meetings are IGNORED (filtered out), not closed
 * 4. Meeting is marked 'ended' ONLY when user explicitly leaves via Jitsi event
 * 
 * FLOW:
 * 1. User joins → Check for recent active session (heartbeat < 2 min old)
 *    - Found? Join that session
 *    - Not found? Create NEW session (ignore stale ones)
 * 2. While in meeting → Send heartbeat every 30s
 * 3. User leaves (Jitsi event) → Mark session as 'ended'
 * 4. User closes tab → Heartbeat stops, session stays 'active' but becomes stale
 *    → Next join will ignore it and create new session
 */

export interface MeetingSession {
  id: string;
  mtb_id: string;
  room_name: string;
  started_at: string;
  ended_at: string | null;
  total_duration_seconds: number | null;
  max_participants: number;
  status: 'active' | 'ended';
  last_heartbeat: string;
}

export interface MeetingParticipant {
  id: string;
  meeting_session_id: string;
  participant_id: string;
  display_name: string | null;
  joined_at: string;
  left_at: string | null;
  duration_seconds: number | null;
  left_reason: string | null;
}

export interface MeetingParams {
  roomName: string;
  mtbId: string;
  mtbName?: string;
}

// Heartbeat interval - send heartbeat every 30 seconds
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

// Stale threshold - session is considered stale if no heartbeat for 2 minutes
const STALE_THRESHOLD_MINUTES = 2;

export class MeetingAnalyticsService {
  private supabase = getSupabaseClient();
  private meetingSessionId: string | null = null;
  private currentParticipantId: string | null = null;
  private localParticipantDbId: string | null = null;
  private params: MeetingParams | null = null;
  private participantCount: number = 0;
  private maxParticipants: number = 0;
  private isTracking: boolean = false;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private hasEnded: boolean = false;

  constructor() {
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
    this.handlePageHide = this.handlePageHide.bind(this);
  }

  /**
   * Initialize analytics tracking for a meeting
   */
  async initialize(params: MeetingParams): Promise<boolean> {
    console.log('[ANALYTICS] ========================================');
    console.log('[ANALYTICS] Initialize called');
    console.log('[ANALYTICS] Room:', params.roomName);
    console.log('[ANALYTICS] MTB ID:', params.mtbId);
    
    if (!isSupabaseConfigured()) {
      console.error('[ANALYTICS] ❌ Supabase not configured, analytics disabled');
      return false;
    }

    if (!this.supabase) {
      console.error('[ANALYTICS] ❌ Supabase client is null');
      return false;
    }

    if (!params.mtbId || !params.roomName) {
      console.error('[ANALYTICS] ❌ Missing required params (mtbId or roomName)');
      return false;
    }

    this.params = params;
    this.hasEnded = false;

    // Set up visibility change handler (for extra heartbeat when tab becomes hidden)
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    // Tab close / refresh without a clean Jitsi leave: best-effort mark the
    // session ended so the transcript-worker's VM stop guard doesn't see a
    // ghost status='active' row for the full 3-minute heartbeat grace.
    window.addEventListener('pagehide', this.handlePageHide);

    this.isTracking = true;
    console.log('[ANALYTICS] ✓ Tracking initialized');
    return true;
  }

  /**
   * Called when the local participant joins the Jitsi room
   * This creates or joins a meeting session
   */
  async onLocalParticipantJoined(participantId: string, displayName?: string): Promise<void> {
    console.log('[ANALYTICS] ----------------------------------------');
    console.log('[ANALYTICS] onLocalParticipantJoined:', participantId);
    
    if (!this.isTracking || !this.params) {
      console.error('[ANALYTICS] ❌ Not tracking or missing params');
      return;
    }

    this.currentParticipantId = participantId;

    // Get or create meeting session
    await this.getOrCreateMeetingSession();

    if (!this.meetingSessionId) {
      console.error('[ANALYTICS] ❌ Failed to get/create meeting session');
      return;
    }

    // Create participant record
    await this.createParticipantRecord(participantId, displayName);

    // Update participant count
    this.participantCount = 1;
    await this.updateMaxParticipants();

    // Start heartbeat
    this.startHeartbeat();
    
    console.log('[ANALYTICS] ✓ Local participant tracking started');
  }

  /**
   * Get existing recent session OR create a new one
   * Key: Only consider sessions with recent heartbeat (not stale)
   */
  private async getOrCreateMeetingSession(): Promise<void> {
    if (!this.supabase || !this.params) return;

    try {
      // Calculate threshold: only sessions with heartbeat newer than this are "active"
      const recentThreshold = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000).toISOString();
      
      console.log('[ANALYTICS] Checking for recent active session...');
      console.log('[ANALYTICS] Threshold:', recentThreshold);
      
      // Query for RECENT active session only
      const { data: existingSession, error: fetchError } = await this.supabase
        .from('meeting_sessions')
        .select('*')
        .eq('room_name', this.params.roomName)
        .eq('status', 'active')
        .gte('last_heartbeat', recentThreshold)  // ONLY recent heartbeats
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();  // Returns null if not found, no error

      if (fetchError) {
        console.error('[ANALYTICS] Error checking for session:', fetchError);
      }

      if (existingSession) {
        // Found a recent active session - join it
        this.meetingSessionId = existingSession.id;
        this.maxParticipants = existingSession.max_participants || 0;
        console.log('[ANALYTICS] ✓ Joined existing session:', this.meetingSessionId);
        return;
      }

      // No recent session found - create a new one
      // Note: We do NOT close/modify stale sessions, we just ignore them
      console.log('[ANALYTICS] No recent session found, creating new one...');
      
      const now = new Date().toISOString();
      const { data: newSession, error: insertError } = await this.supabase
        .from('meeting_sessions')
        .insert({
          mtb_id: this.params.mtbId,
          room_name: this.params.roomName,
          started_at: now,
          last_heartbeat: now,
          status: 'active',
          max_participants: 1,
        })
        .select()
        .single();

      if (insertError) {
        console.error('[ANALYTICS] ❌ Error creating session:', insertError);
        return;
      }

      this.meetingSessionId = newSession.id;
      console.log('[ANALYTICS] ✓ Created new session:', this.meetingSessionId);

    } catch (error) {
      console.error('[ANALYTICS] ❌ Exception in getOrCreateMeetingSession:', error);
    }
  }

  /**
   * Start sending heartbeats
   */
  private startHeartbeat(): void {
    this.stopHeartbeat(); // Clear any existing

    console.log('[ANALYTICS] Starting heartbeat (every 30s)');
    
    // First heartbeat immediately
    this.sendHeartbeat();
    
    // Then every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stop sending heartbeats
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Send a heartbeat update
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.supabase || !this.meetingSessionId || this.hasEnded) return;

    try {
      const { error } = await this.supabase
        .from('meeting_sessions')
        .update({ last_heartbeat: new Date().toISOString() })
        .eq('id', this.meetingSessionId);

      if (error) {
        console.error('[ANALYTICS] Heartbeat error:', error.message);
      } else {
        console.log('[ANALYTICS] 💓 Heartbeat');
      }
    } catch (error) {
      console.error('[ANALYTICS] Heartbeat exception:', error);
    }
  }

  /**
   * Called when a remote participant joins
   */
  async onParticipantJoined(participantId: string, displayName?: string): Promise<void> {
    if (!this.isTracking || !this.meetingSessionId) return;
    if (participantId === this.currentParticipantId) return; // Skip self

    console.log('[ANALYTICS] Remote participant joined:', participantId);

    await this.createParticipantRecord(participantId, displayName);

    this.participantCount++;
    await this.updateMaxParticipants();
  }

  /**
   * Called when a remote participant leaves
   */
  async onParticipantLeft(participantId: string): Promise<void> {
    if (!this.isTracking || !this.meetingSessionId) return;
    if (participantId === this.currentParticipantId) return; // Skip self

    console.log('[ANALYTICS] Remote participant left:', participantId);

    await this.markParticipantLeft(participantId, 'normal');
    this.participantCount = Math.max(0, this.participantCount - 1);
  }

  /**
   * Called when the local participant leaves via Jitsi event
   * This is the ONLY time we mark the meeting as ended
   */
  async onLocalParticipantLeft(reason: string = 'normal'): Promise<void> {
    if (!this.isTracking || this.hasEnded) {
      console.log('[ANALYTICS] Already ended or not tracking');
      return;
    }
    
    this.hasEnded = true;
    console.log('[ANALYTICS] ========================================');
    console.log('[ANALYTICS] Local participant leaving:', reason);

    // Stop heartbeat
    this.stopHeartbeat();

    // Mark local participant as left
    if (this.localParticipantDbId) {
      await this.markParticipantLeftById(this.localParticipantDbId, reason);
    }

    // Mark meeting session as ended
    await this.endMeetingSession();

    // Cleanup
    this.cleanup();
  }

  /**
   * Create a participant record
   */
  private async createParticipantRecord(participantId: string, displayName?: string): Promise<void> {
    if (!this.supabase || !this.meetingSessionId) return;

    try {
      const { data, error } = await this.supabase
        .from('meeting_participants')
        .insert({
          meeting_session_id: this.meetingSessionId,
          participant_id: participantId,
          display_name: displayName || null,
          joined_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) {
        console.error('[ANALYTICS] Error creating participant:', error);
        return;
      }

      // Store DB ID if this is local participant
      if (participantId === this.currentParticipantId) {
        this.localParticipantDbId = data.id;
      }

      console.log('[ANALYTICS] ✓ Created participant record');
    } catch (error) {
      console.error('[ANALYTICS] Exception creating participant:', error);
    }
  }

  /**
   * Mark a participant as left by Jitsi participant ID
   */
  private async markParticipantLeft(participantId: string, reason: string): Promise<void> {
    if (!this.supabase || !this.meetingSessionId) return;

    try {
      const now = new Date();
      
      // Find the participant record
      const { data: participant } = await this.supabase
        .from('meeting_participants')
        .select('*')
        .eq('meeting_session_id', this.meetingSessionId)
        .eq('participant_id', participantId)
        .is('left_at', null)
        .order('joined_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!participant) return;

      const joinedAt = new Date(participant.joined_at);
      const durationSeconds = Math.floor((now.getTime() - joinedAt.getTime()) / 1000);

      await this.supabase
        .from('meeting_participants')
        .update({
          left_at: now.toISOString(),
          duration_seconds: durationSeconds,
          left_reason: reason,
        })
        .eq('id', participant.id);

    } catch (error) {
      console.error('[ANALYTICS] Error marking participant left:', error);
    }
  }

  /**
   * Mark a participant as left by database ID
   */
  private async markParticipantLeftById(dbId: string, reason: string): Promise<void> {
    if (!this.supabase) return;

    try {
      const now = new Date();

      const { data: participant } = await this.supabase
        .from('meeting_participants')
        .select('*')
        .eq('id', dbId)
        .maybeSingle();

      if (!participant || participant.left_at) return;

      const joinedAt = new Date(participant.joined_at);
      const durationSeconds = Math.floor((now.getTime() - joinedAt.getTime()) / 1000);

      await this.supabase
        .from('meeting_participants')
        .update({
          left_at: now.toISOString(),
          duration_seconds: durationSeconds,
          left_reason: reason,
        })
        .eq('id', dbId);

      console.log('[ANALYTICS] ✓ Marked local participant left');
    } catch (error) {
      console.error('[ANALYTICS] Error marking participant left:', error);
    }
  }

  /**
   * Update max participants if current count is higher
   */
  private async updateMaxParticipants(): Promise<void> {
    if (!this.supabase || !this.meetingSessionId) return;

    if (this.participantCount > this.maxParticipants) {
      this.maxParticipants = this.participantCount;
      
      await this.supabase
        .from('meeting_sessions')
        .update({ max_participants: this.maxParticipants })
        .eq('id', this.meetingSessionId);
    }
  }

  /**
   * End the meeting session
   * Called ONLY when local user explicitly leaves via Jitsi event
   */
  private async endMeetingSession(): Promise<void> {
    if (!this.supabase || !this.meetingSessionId) return;

    try {
      const { data: session } = await this.supabase
        .from('meeting_sessions')
        .select('*')
        .eq('id', this.meetingSessionId)
        .maybeSingle();

      if (!session || session.status === 'ended') return;

      const now = new Date();
      const startedAt = new Date(session.started_at);
      const totalDurationSeconds = Math.floor((now.getTime() - startedAt.getTime()) / 1000);

      await this.supabase
        .from('meeting_sessions')
        .update({
          ended_at: now.toISOString(),
          total_duration_seconds: totalDurationSeconds,
          status: 'ended',
        })
        .eq('id', this.meetingSessionId);

      console.log('[ANALYTICS] ✓ Meeting ended');
      console.log('[ANALYTICS] Duration:', totalDurationSeconds, 'seconds');
      console.log('[ANALYTICS] Max participants:', this.maxParticipants);
      console.log('[ANALYTICS] ========================================');

    } catch (error) {
      console.error('[ANALYTICS] Error ending session:', error);
    }
  }

  /**
   * Handle visibility change - send heartbeat when tab becomes hidden
   */
  private handleVisibilityChange(): void {
    if (document.visibilityState === 'hidden' && this.isTracking && !this.hasEnded) {
      console.log('[ANALYTICS] Tab hidden - sending heartbeat');
      this.sendHeartbeat();
    }
  }

  /**
   * Page is going away (tab close, refresh, bfcache). Fire-and-forget end so
   * we don't leave status='active' ghosts that block automatic VM stop.
   */
  private handlePageHide(): void {
    if (!this.isTracking || this.hasEnded || !this.meetingSessionId) return;
    console.log('[ANALYTICS] pagehide - ending session best-effort');
    this.hasEnded = true;
    this.stopHeartbeat();
    void this.endMeetingSession();
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    console.log('[ANALYTICS] Cleanup');

    this.stopHeartbeat();
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    window.removeEventListener('pagehide', this.handlePageHide);

    this.isTracking = false;
    this.meetingSessionId = null;
    this.currentParticipantId = null;
    this.localParticipantDbId = null;
    this.params = null;
    this.participantCount = 0;
    this.maxParticipants = 0;
  }

  getMeetingSessionId(): string | null {
    return this.meetingSessionId;
  }

  isActive(): boolean {
    return this.isTracking;
  }
}

// Export singleton instance
export const meetingAnalytics = new MeetingAnalyticsService();
