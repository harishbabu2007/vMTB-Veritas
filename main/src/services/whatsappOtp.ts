import { supabase } from '../Supabase/client';

/**
 * Formats phone number by removing any non-numeric characters
 * and ensuring it doesn't have a + prefix
 * Used for profiles.whatsapp_number storage
 */
export function formatPhoneNumber(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * Formats phone number to E.164 format (with + prefix)
 * Used for auth.users.phone storage
 */
export function formatPhoneE164(phone: string): string {
  const cleaned = phone.replace(/\D/g, '');
  return `+${cleaned}`;
}

/**
 * Parses Edge Function HTTP error responses into clean, user-friendly error strings.
 * Prevents technical errors (e.g. FunctionsHttpError, 400 status) from reaching the UI.
 */
export async function extractEdgeFunctionError(
  error: any,
  fallbackMessage: string = 'The OTP entered is incorrect. Please try again.'
): Promise<string> {
  if (!error) return fallbackMessage;

  try {
    // If error object has a response context, attempt to parse its JSON payload
    if (error.context && typeof error.context.json === 'function') {
      const body = await error.context.json();
      if (body?.error && typeof body.error === 'string') {
        return body.error;
      }
    }
  } catch (e) {
    console.error('Failed to parse Edge Function error context JSON:', e);
  }

  // If error.message is user-facing (not technical), surface it
  if (error.message && typeof error.message === 'string') {
    const msg = error.message;
    if (
      !msg.includes('non-2xx') &&
      !msg.includes('FunctionsHttpError') &&
      !msg.includes('Failed to fetch') &&
      !msg.includes('Failed to load') &&
      !msg.includes('HTTP 400') &&
      !msg.includes('Edge Function')
    ) {
      return msg;
    }
  }

  return fallbackMessage;
}

/**
 * Sends WhatsApp OTP to the provided phone number
 */
export async function sendWhatsAppOTP(phone: string): Promise<{ success: boolean; error?: string }> {
  try {
    const formattedPhone = formatPhoneNumber(phone);
    
    const { data, error } = await supabase.functions.invoke('send_whatsapp_otp', {
      body: { phone: formattedPhone },
    });

    if (error) {
      console.error('Error sending WhatsApp OTP:', error);
      const cleanErr = await extractEdgeFunctionError(error, 'Failed to send OTP. Please try again.');
      return { success: false, error: cleanErr };
    }

    if (data?.error) {
      return { success: false, error: data.error };
    }

    return { success: true };
  } catch (error) {
    console.error('Error sending WhatsApp OTP:', error);
    const cleanErr = await extractEdgeFunctionError(error, 'Failed to send OTP. Please try again.');
    return { success: false, error: cleanErr };
  }
}

/**
 * Verifies WhatsApp OTP and creates user account (legacy email+password flow)
 */
export async function verifyWhatsAppOTPAndCreateUser(params: {
  phone: string;
  phoneE164: string;
  otp: string;
  email: string;
  password: string;
  full_name: string;
  profession?: string;
  hospital?: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const formattedPhone = formatPhoneNumber(params.phone);

    const payload = {
      phone: formattedPhone,
      phone_e164: params.phoneE164,
      otp: params.otp,
      email: params.email,
      password: params.password,
      full_name: params.full_name,
      profession: params.profession,
      hospital: params.hospital,
    };

    const { data, error } = await supabase.functions.invoke('verify_whatsapp_otp', {
      body: payload,
    });

    if (error) {
      console.error('Error verifying WhatsApp OTP:', error);
      const cleanErr = await extractEdgeFunctionError(error, 'The OTP entered is incorrect. Please try again.');
      return { success: false, error: cleanErr };
    }

    if (data?.error) {
      return { success: false, error: data.error };
    }

    return { success: true };
  } catch (error) {
    console.error('Error verifying WhatsApp OTP:', error);
    const cleanErr = await extractEdgeFunctionError(error, 'The OTP entered is incorrect. Please try again.');
    return { success: false, error: cleanErr };
  }
}

/**
 * Verifies WhatsApp OTP for an existing user (e.g. Google OAuth signup completion).
 * Updates user password, confirmed phone in auth.users, and completes profile.
 */
export async function verifyWhatsAppOTPForExistingUser(params: {
  phone: string;
  otp: string;
  userId: string;
  password?: string;
  phoneE164?: string;
  fullName?: string;
  profession?: string;
  hospital?: string;
  role?: string;
  linkedClinicianId?: string | null;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const formattedPhone = formatPhoneNumber(params.phone);

    const payload = {
      phone: formattedPhone,
      otp: params.otp,
      user_id: params.userId,
      password: params.password,
      phone_e164: params.phoneE164,
      full_name: params.fullName,
      profession: params.profession,
      hospital: params.hospital,
      role: params.role,
      linked_clinician_id: params.linkedClinicianId,
    };

    console.log("verify_whatsapp_otp (existing user) payload:", payload);

    const { data, error } = await supabase.functions.invoke('verify_whatsapp_otp', {
      body: payload,
    });

    if (error) {
      console.error('Error verifying WhatsApp OTP for existing user:', error);
      const cleanErr = await extractEdgeFunctionError(error, 'The OTP entered is incorrect. Please try again.');
      return { success: false, error: cleanErr };
    }

    if (data?.error) {
      return { success: false, error: data.error };
    }

    return { success: true };
  } catch (error) {
    console.error('Error verifying WhatsApp OTP for existing user:', error);
    const cleanErr = await extractEdgeFunctionError(error, 'The OTP entered is incorrect. Please try again.');
    return { success: false, error: cleanErr };
  }
}

/**
 * Verifies WhatsApp OTP for Login flow.
 * Returns an email and email_otp token to authenticate directly on client.
 */
export async function verifyWhatsAppOTPForLogin(params: {
  phone: string;
  otp: string;
}): Promise<{ success: boolean; email?: string; email_otp?: string; error?: string }> {
  try {
    const formattedPhone = formatPhoneNumber(params.phone);

    const payload = {
      phone: formattedPhone,
      otp: params.otp,
      action: 'login',
    };

    console.log("verify_whatsapp_otp (login) payload:", payload);

    const { data, error } = await supabase.functions.invoke('verify_whatsapp_otp', {
      body: payload,
    });

    if (error) {
      console.error('Error verifying WhatsApp OTP for login:', error);
      const cleanErr = await extractEdgeFunctionError(error, 'The OTP entered is incorrect. Please try again.');
      return { success: false, error: cleanErr };
    }

    if (data?.error) {
      return { success: false, error: data.error };
    }

    return {
      success: true,
      email: data.email,
      email_otp: data.email_otp,
    };
  } catch (error) {
    console.error('Error verifying WhatsApp OTP for login:', error);
    const cleanErr = await extractEdgeFunctionError(error, 'The OTP entered is incorrect. Please try again.');
    return { success: false, error: cleanErr };
  }
}

/**
 * Verifies WhatsApp OTP for Forgot Password flow.
 * Returns user_id if matching account is found.
 */
export async function verifyWhatsAppOTPForReset(params: {
  phone: string;
  otp: string;
}): Promise<{ success: boolean; userId?: string; resetToken?: string; error?: string }> {
  try {
    const formattedPhone = formatPhoneNumber(params.phone);

    const payload = {
      phone: formattedPhone,
      otp: params.otp,
      action: 'reset_verify',
    };

    const { data, error } = await supabase.functions.invoke('verify_whatsapp_otp', {
      body: payload,
    });

    if (error) {
      console.error('Error verifying WhatsApp OTP for password reset:', error);
      const cleanErr = await extractEdgeFunctionError(error, 'The OTP entered is incorrect. Please try again.');
      return { success: false, error: cleanErr };
    }

    if (data?.error) {
      return { success: false, error: data.error };
    }

    return {
      success: true,
      userId: data.user_id,
      resetToken: data.reset_token,
    };
  } catch (error) {
    console.error('Error verifying WhatsApp OTP for password reset:', error);
    const cleanErr = await extractEdgeFunctionError(error, 'The OTP entered is incorrect. Please try again.');
    return { success: false, error: cleanErr };
  }
}

/**
 * Completes password reset for verified user. `resetToken` is the short-lived
 * ticket returned by verifyWhatsAppOTPForReset — the Edge Function requires
 * it as proof that an OTP was actually verified for this account; without it,
 * this call would just be an unauthenticated password reset by user_id.
 */
export async function completePasswordReset(params: {
  userId: string;
  newPassword: string;
  resetToken: string;
  phone?: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const payload = {
      user_id: params.userId,
      password: params.newPassword,
      reset_token: params.resetToken,
      phone: params.phone ? formatPhoneNumber(params.phone) : undefined,
      action: 'reset_password',
    };

    const { data, error } = await supabase.functions.invoke('verify_whatsapp_otp', {
      body: payload,
    });

    if (error) {
      console.error('Error completing password reset:', error);
      const cleanErr = await extractEdgeFunctionError(error, 'Failed to reset password. Please try again.');
      return { success: false, error: cleanErr };
    }

    if (data?.error) {
      return { success: false, error: data.error };
    }

    return { success: true };
  } catch (error) {
    console.error('Error completing password reset:', error);
    const cleanErr = await extractEdgeFunctionError(error, 'Failed to reset password. Please try again.');
    return { success: false, error: cleanErr };
  }
}

/**
 * Checks whether a normalized phone number is already registered in the profiles table.
 */
export async function isPhoneNumberRegistered(
  phone: string,
  currentUserId?: string
): Promise<{ registered: boolean; error?: string }> {
  try {
    const cleanPhone = formatPhoneNumber(phone);
    if (!cleanPhone) return { registered: false };

    let query = supabase
      .from('profiles')
      .select('id')
      .or(`whatsapp_number.eq.${cleanPhone},whatsapp_number.eq.${phone}`);

    if (currentUserId) {
      query = query.not('id', 'eq', currentUserId);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error checking duplicate phone number:', error);
      return { registered: false, error: error.message };
    }

    return { registered: !!(data && data.length > 0) };
  } catch (err) {
    console.error('Error checking duplicate phone number:', err);
    return { registered: false };
  }
}

/**
 * Resolves a phone number to an existing, fully-registered clinician's
 * profile id -- used at Site Data Coordinator signup to link the new
 * account to the clinician it acts on behalf of. Deliberately returns the
 * resolved id (not the phone string itself) so a later phone-number change
 * on the clinician's account can't retroactively affect an already-
 * established link (see profiles.linked_clinician_id).
 */
export type ClinicianLookupResult =
  | { ok: true; id: string; fullName: string | null }
  | { ok: false; reason: 'not_found' | 'ambiguous' | 'not_clinician' | 'unverified' | 'error' };

export async function findClinicianByPhone(phone: string): Promise<ClinicianLookupResult> {
  try {
    const cleanPhone = formatPhoneNumber(phone);
    if (!cleanPhone) return { ok: false, reason: 'not_found' };

    // Not maybeSingle(): the same number can legitimately exist in two stored
    // formats (`+91…` and `91…` — the case isPhoneNumberRegistered above
    // already anticipates), and maybeSingle() collapses that into a PostgREST
    // error indistinguishable from "no such number".
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, role, whatsapp_verified')
      .or(`whatsapp_number.eq.${cleanPhone},whatsapp_number.eq.${phone}`)
      .limit(2);

    if (error) {
      console.error('Error resolving clinician by phone:', error);
      return { ok: false, reason: 'error' };
    }
    if (!data || data.length === 0) return { ok: false, reason: 'not_found' };
    if (data.length > 1) return { ok: false, reason: 'ambiguous' };

    const match = data[0];
    if (match.role !== 'clinician') return { ok: false, reason: 'not_clinician' };
    if (!match.whatsapp_verified) return { ok: false, reason: 'unverified' };

    return { ok: true, id: match.id, fullName: match.full_name ?? null };
  } catch (err) {
    console.error('Error resolving clinician by phone:', err);
    return { ok: false, reason: 'error' };
  }
}
