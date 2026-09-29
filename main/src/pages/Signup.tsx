import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link, useLocation } from 'react-router-dom';
import { supabase } from '../Supabase/client';
import { showToast } from '../utils/toast';
import { sendWhatsAppOTP, verifyWhatsAppOTPForExistingUser, isPhoneNumberRegistered, findClinicianByPhone } from '../services/whatsappOtp';
import { useAuth } from '../context/AuthContext';
import { roleHomePath } from '../components/RoleRoute';
import { PasswordInput } from '../components/PasswordInput';
import { validatePasswordRules } from '../components/PasswordStrength';
import { Select } from '../components/Select';

type SignupStep = 'google-gate' | 'form' | 'otp';

// The Profession field is purely descriptive (a clinical specialty picklist)
// and never drives any permission decision -- only profiles.role does, which
// already has its own CHECK constraint + the profiles_role_immutable
// trigger. So when Role is "Site Data Coordinator," Profession is forced to
// this exact label client-side (both live and at submit time) for data
// consistency, but deliberately isn't also enforced by a DB constraint --
// there is no integrity/security payoff to duplicating a role-name string
// into an unrelated informational field at the database layer, and it
// would couple that field's schema to one specific role's label.
const SDC_PROFESSION_LABEL = 'Site Data Coordinator';

// One message per distinct failure, so "we couldn't find that number" is never
// shown for a number that was found but isn't usable as a link target.
const CLINICIAN_LOOKUP_ERRORS: Record<
  Exclude<Awaited<ReturnType<typeof findClinicianByPhone>>, { ok: true }>['reason'],
  string
> = {
  not_found: 'No registered clinician was found with this phone number.',
  ambiguous:
    'This number matches more than one account, so we can\'t tell which clinician to link. Please contact support.',
  not_clinician:
    'That account isn\'t a clinician. A Site Data Coordinator can only be linked to a clinician\'s account.',
  unverified:
    'That clinician hasn\'t finished verifying their WhatsApp number yet. Ask them to complete signup first.',
  error: 'We couldn\'t check that number just now. Please try again.',
};

const PROFESSION_OPTIONS = [
  'Medical oncologist',
  'Surgical oncologist',
  'Radiation oncologist',
  'Hematologist-oncologist',
  'Radiologist',
  'Pathologist',
  'Molecular pathologist',
  'Medical physicist',
  'Dosimetrist',
  'Radiation therapist',
  'Oncology nurse / staff nurse',
  'Infusion nurse',
  'Oncology pharmacist',
  'Palliative care specialist',
  'Dietitian / oncology nutritionist',
  'Genetic counselor',
  'Cardio-oncologist',
  'Pulmonologist',
  'Nephrologist',
  'Hepatologist',
  'Endocrinologist',
  'Oral surgeon',
  'Administrative staff',
  SDC_PROFESSION_LABEL,
  'Geneticist',
  'Genomicist',
].map((label) => ({ value: label, label }));

interface GoogleState {
  googleEmail: string;
  googleUserId: string;
  googleName: string;
  googleAuthenticated: boolean;
}

export function Signup() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signInWithGoogle, markRegistrationComplete, setKnownRole, isAuthenticated, registrationComplete, role } = useAuth();

  // Check if we arrived here with Google auth data from AuthCallback
  const googleState = location.state as GoogleState | null;

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [profession, setProfession] = useState('');
  const [hospital, setHospital] = useState('');
  const [countryCode, setCountryCode] = useState('91');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Access role: permanent once registration completes (see the
  // profiles_role_immutable trigger), so this dropdown deliberately has no
  // pre-selected default -- an unnoticed default here would silently lock
  // someone into full clinician access.
  const [accessRole, setAccessRole] = useState<'' | 'clinician' | 'site_data_coordinator' | 'mtb_expert'>('');
  const [linkedClinicianCountryCode, setLinkedClinicianCountryCode] = useState('91');
  const [linkedClinicianPhone, setLinkedClinicianPhone] = useState('');
  const [linkedClinicianId, setLinkedClinicianId] = useState<string | null>(null);
  const [clinicianLookupError, setClinicianLookupError] = useState<string | null>(null);
  // Whatever Profession the user had chosen before switching Role to Site
  // Data Coordinator -- restored if they switch away again, so picking SDC
  // and then changing their mind doesn't discard something they'd already
  // filled in.
  const previousProfessionRef = useRef<string>('');

  // Google auth data (from OAuth callback)
  const [googleEmail, setGoogleEmail] = useState('');
  const [googleUserId, setGoogleUserId] = useState('');

  // OTP verification state
  const [step, setStep] = useState<SignupStep>('google-gate');
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [resendCooldown, setResendCooldown] = useState(0);
  const otpInputsRef = useRef<(HTMLInputElement | null)[]>([]);
  // Synchronous in-flight latch for the OTP submit. `loading` can't do this
  // job on its own: it's a React state update, so two clicks dispatched
  // before the re-render both pass a `loading` check and both consume the
  // OTP. The server's atomic claim then rejects the loser, which surfaces as
  // "This OTP has already been used" over a signup that actually succeeded.
  const verifyInFlightRef = useRef(false);

  // Initialize from Google state if available
  useEffect(() => {
    if (googleState?.googleAuthenticated && googleState?.googleEmail) {
      setGoogleEmail(googleState.googleEmail);
      setGoogleUserId(googleState.googleUserId);
      setName(googleState.googleName || '');
      setStep('form');
    }
  }, [googleState]);

  // Keep Profession in sync with Role: locked to "Site Data Coordinator"
  // while that role is selected, restored to whatever was there before if
  // the user switches to a different role.
  useEffect(() => {
    if (accessRole === 'site_data_coordinator') {
      setProfession(prev => {
        if (prev === SDC_PROFESSION_LABEL) return prev;
        previousProfessionRef.current = prev;
        return SDC_PROFESSION_LABEL;
      });
    } else {
      setProfession(prev => (prev === SDC_PROFESSION_LABEL ? previousProfessionRef.current : prev));
      // Clear the linked-clinician sub-field along with the role that owns it,
      // rather than leaving a typed number and a resolved id hidden behind the
      // collapsed field.
      setLinkedClinicianPhone('');
      setLinkedClinicianId(null);
      setClinicianLookupError(null);
    }
  }, [accessRole]);

  // A fully registered, already-authenticated user should never be able to
  // reach the signup form (typed URL, bookmark, back button) — AuthCallback
  // already avoids sending such a user here, but this guards the case where
  // /signup is reached some other way with an existing complete session.
  useEffect(() => {
    if (isAuthenticated && registrationComplete === true) {
      navigate(roleHomePath(role), { replace: true });
    }
  }, [isAuthenticated, registrationComplete, role, navigate]);

  // Handle resend cooldown timer
  useEffect(() => {
    if (resendCooldown > 0) {
      const timer = setTimeout(() => setResendCooldown(resendCooldown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [resendCooldown]);

  // Focus first OTP input when step changes to OTP
  useEffect(() => {
    if (step === 'otp') {
      otpInputsRef.current[0]?.focus();
    }
  }, [step]);

  const handleGoogleAuth = async () => {
    setError(null);
    setGoogleLoading(true);
    try {
      await signInWithGoogle('signup');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Google authentication failed';
      setError(message);
      setGoogleLoading(false);
    }
  };

  const getFullPhone = () => {
    const cleanCode = countryCode.replace(/\D/g, '');
    const cleanNum = phoneNumber.replace(/\D/g, '');
    return `${cleanCode}${cleanNum}`;
  };

  const handleSendOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!name.trim()) {
      showToast.error('Full name is required');
      return;
    }
    
    if (!profession) {
      showToast.error('Profession is required');
      return;
    }
    
    if (!hospital.trim()) {
      showToast.error('Hospital/Institution is required');
      return;
    }

    if (!accessRole) {
      showToast.error('Please select a role');
      return;
    }

    setClinicianLookupError(null);
    let resolvedClinicianId: string | null = null;
    if (accessRole === 'site_data_coordinator') {
      const cleanClinicianNum = linkedClinicianPhone.replace(/\D/g, '');
      if (!cleanClinicianNum || cleanClinicianNum.length < 7 || cleanClinicianNum.length > 15) {
        setClinicianLookupError('Enter the linked clinician\'s phone number');
        return;
      }
      const clinician = await findClinicianByPhone(`${linkedClinicianCountryCode.replace(/\D/g, '')}${cleanClinicianNum}`);
      if (!clinician.ok) {
        setClinicianLookupError(CLINICIAN_LOOKUP_ERRORS[clinician.reason]);
        return;
      }
      resolvedClinicianId = clinician.id;
    }
    setLinkedClinicianId(resolvedClinicianId);

    const cleanNum = phoneNumber.replace(/\D/g, '');
    if (!cleanNum || cleanNum.length < 7 || cleanNum.length > 15) {
      showToast.error('Please enter a valid phone number');
      return;
    }
    
    const passRules = validatePasswordRules(password);
    if (!passRules.isValid) {
      const msg = 'Password must be at least 8 characters long, contain a number, and contain an uppercase letter.';
      showToast.error(msg);
      setError(msg);
      return;
    }

    if (password !== confirmPassword) {
      showToast.error('Passwords do not match');
      setError('Passwords do not match');
      return;
    }

    setError(null);
    setLoading(true);
    
    try {
      const fullPhone = getFullPhone();

      // Check if phone number is already registered to another account.
      // Only exclude "myself" from this check while this account hasn't
      // completed WhatsApp verification yet — an already-verified account
      // must not be able to silently reassign its registered phone number
      // by re-running signup.
      let exclusionId: string | undefined;
      if (googleUserId) {
        const { data: existingProfile } = await supabase
          .from('profiles')
          .select('whatsapp_verified')
          .eq('id', googleUserId)
          .maybeSingle();
        if (!existingProfile?.whatsapp_verified) {
          exclusionId = googleUserId;
        }
      }

      const checkRes = await isPhoneNumberRegistered(fullPhone, exclusionId);
      if (checkRes.registered) {
        const errorMsg = 'An account with this phone number already exists. Please log in instead or use a different phone number.';
        setError(errorMsg);
        showToast.error(errorMsg);
        setLoading(false);
        return;
      }

      const result = await sendWhatsAppOTP(fullPhone);
      
      if (!result.success) {
        setError(result.error || 'Failed to send OTP');
        return;
      }
      
      showToast.success('OTP sent to your WhatsApp');
      setStep('otp');
      setResendCooldown(60);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send OTP';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleResendOTP = async () => {
    if (resendCooldown > 0) return;
    
    setLoading(true);
    try {
      const fullPhone = getFullPhone();
      const result = await sendWhatsAppOTP(fullPhone);
      
      if (!result.success) {
        showToast.error(result.error || 'Failed to resend OTP');
        return;
      }
      
      showToast.success('OTP resent to your WhatsApp');
      setResendCooldown(60);
      setOtp(['', '', '', '', '', '']);
      otpInputsRef.current[0]?.focus();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to resend OTP';
      showToast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleOtpChange = (index: number, value: string) => {
    if (!/^\d*$/.test(value)) return;
    
    const newOtp = [...otp];
    newOtp[index] = value.slice(-1);
    setOtp(newOtp);
    
    if (value && index < 5) {
      otpInputsRef.current[index + 1]?.focus();
    }
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      otpInputsRef.current[index - 1]?.focus();
    }
  };

  const handleOtpPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pastedData) {
      const newOtp = [...otp];
      for (let i = 0; i < pastedData.length && i < 6; i++) {
        newOtp[i] = pastedData[i];
      }
      setOtp(newOtp);
      const focusIndex = Math.min(pastedData.length, 5);
      otpInputsRef.current[focusIndex]?.focus();
    }
  };

  const handleVerifyOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const otpString = otp.join('');
    if (otpString.length !== 6) {
      setError('Please enter the complete 6-digit OTP');
      return;
    }

    if (verifyInFlightRef.current) return;
    verifyInFlightRef.current = true;

    setError(null);
    setLoading(true);

    try {
      const fullPhone = getFullPhone();
      const phoneE164 = `+${fullPhone}`;
      // Forced here too, not just kept in sync live by the Role-change
      // effect above -- belt-and-braces so the value actually written can
      // never drift from the locked label regardless of how `profession`
      // state got here.
      const finalProfession = accessRole === 'site_data_coordinator' ? SDC_PROFESSION_LABEL : profession;
      // Same reasoning as finalProfession: only ever send a linked clinician
      // for the one role allowed to have one. Sending a stale id alongside a
      // non-SDC role would trip profiles_linked_clinician_id_role_check
      // server-side *after* the OTP had already been consumed, leaving the
      // user with "Failed to verify OTP" and a dead code.
      const finalLinkedClinicianId = accessRole === 'site_data_coordinator' ? linkedClinicianId : null;

      // Step 1: Verify OTP and update auth user (password + confirmed phone) & profile via Edge Function
      const result = await verifyWhatsAppOTPForExistingUser({
        phone: fullPhone,
        otp: otpString,
        userId: googleUserId,
        password: password,
        phoneE164: phoneE164,
        fullName: name,
        profession: finalProfession,
        hospital: hospital,
        role: accessRole || undefined,
        linkedClinicianId: finalLinkedClinicianId,
      });

      if (!result.success) {
        setError(result.error || 'Failed to verify OTP');
        return;
      }

      // The Edge Function's own upsert (service-role key, identity-checked)
      // is the sole authoritative write for profiles.role/linked_clinician_id
      // -- it now correctly fails `result.success` above if that write
      // itself failed, so no redundant client-side upsert is needed here.
      showToast.success('Account created successfully!');

      // Step 2: User is already authenticated via Google OAuth — navigate directly to the
      // role's home. AuthContext's own registration-status/role state runs off auth *events*,
      // not table writes, so it doesn't know this just-finished signup is complete (or which
      // role was chosen) yet; without these two calls, RoleRoute would see the stale
      // "incomplete"/"clinician-default" status and bounce back to /signup or the wrong home.
      const finalRole = accessRole || 'clinician';
      setKnownRole(finalRole, finalLinkedClinicianId);
      markRegistrationComplete();
      navigate(roleHomePath(finalRole), { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create account';
      setError(message);
    } finally {
      setLoading(false);
      verifyInFlightRef.current = false;
    }
  };

  const handleBackToForm = () => {
    setStep('form');
    setOtp(['', '', '', '', '', '']);
    setError(null);
  };

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4 py-8">
      {/* A single-column form (see the note above the form JSX) needs no
          more width than the other two steps -- one consistent card width
          across the whole signup flow, not a step that's oddly wider. */}
      <div className="w-full max-w-md">
        <div className="bg-surface rounded-2xl shadow-sm p-8">
          {/* Header */}
          <div className="flex items-center justify-center space-x-3 mb-8">
            <img src="https://i.ibb.co/vxP6Cs3c/logo.png" alt="VMTB" className="h-12 w-auto" />
            <h1 className="text-3xl font-bold text-text">vMTB</h1>
          </div>

          {/* Step 1: Google Gate */}
          {step === 'google-gate' && (
            <>
              <h2 className="text-2xl font-semibold text-text mb-2 text-center">
                Create your account
              </h2>
              <p className="text-center text-text-muted mb-8">
                Join our community of healthcare professionals
              </p>

              <div className="space-y-6">
                <p className="text-center text-sm text-text-muted">
                  To get started, verify your email through Google
                </p>

                {error && (
                  <div className="text-sm text-danger bg-danger-bg p-3 rounded-lg">
                    {error}
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleGoogleAuth}
                  disabled={googleLoading}
                  className="w-full flex items-center justify-center gap-3 px-4 py-2.5 border border-border rounded-lg font-medium text-text transition hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {googleLoading ? (
                    <div
                      className="w-5 h-5 border-2 border-border rounded-full animate-spin"
                      style={{ borderTopColor: 'var(--color-primary)' }}
                    />
                  ) : (
                    <svg className="w-5 h-5" viewBox="0 0 24 24">
{/* theme-allow-start: Google brand logo colours must not change with the theme */}
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                    {/* theme-allow-end */}
</svg>
                  )}
                  {googleLoading ? 'Connecting...' : 'Continue with Google'}
                </button>
              </div>

              <div className="mt-8 text-center text-text-muted">
                <span className="text-sm">
                  Already have an account?{' '}
                  <Link to="/login" className="font-semibold transition text-link">
                    Login here
                  </Link>
                </span>
              </div>
            </>
          )}

          {/* Step 2: Signup Form */}
          {step === 'form' && (
            <>
              <h2 className="text-2xl font-semibold text-text mb-2 text-center">
                Create your account
              </h2>
              <p className="text-center text-text-muted mb-2">
                Join our community of healthcare professionals
              </p>
              {googleEmail && (
                <p className="text-center text-sm mb-8 text-text-muted">
                  Signing up as <span className="font-semibold text-text">{googleEmail}</span>
                </p>
              )}

              <form onSubmit={handleSendOTP}>
                {/* Single column, deliberately: this form has two fields
                    whose content grows unpredictably (the password
                    requirements checklist, the linked-clinician sub-field) --
                    in a two-column grid, either one throws the columns out
                    of vertical sync with no relationship to fix. A single
                    column can't misalign against a partner column that no
                    longer exists, so every field just reflows below the
                    last regardless of how tall any one of them gets. */}
                <div className="space-y-5 mb-6">
                  <div>
                    <label htmlFor="name" className="block text-sm font-medium text-text mb-2">
                      Full Name
                    </label>
                    <input
                      id="name"
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full px-4 py-2.5 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0 transition text-sm"
                      placeholder="Ex: Dr. John Doe"
                      required
                    />
                  </div>

                  <div>
                    <label htmlFor="accessRole" className="block text-sm font-medium text-text mb-2">
                      Role
                    </label>
                    <Select
                      id="accessRole"
                      value={accessRole}
                      onChange={(v) => {
                        setAccessRole(v as typeof accessRole);
                        setClinicianLookupError(null);
                      }}
                      options={[
                        { value: 'clinician', label: 'Clinician' },
                        { value: 'site_data_coordinator', label: 'Site Data Coordinator' },
                        { value: 'mtb_expert', label: 'MTB Expert' },
                      ]}
                      placeholder="Select role"
                      required
                    />
                    {accessRole === 'site_data_coordinator' && (
                      <div className="mt-3 pl-3 border-l-2 border-border space-y-3">
                        <div>
                          <label htmlFor="linkedClinicianPhone" className="block text-sm font-medium text-text mb-2">
                            Linked clinician's phone number
                          </label>
                          <div className="flex gap-2">
                            <div className="relative">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle text-sm">+</span>
                              <input
                                id="linkedClinicianCountryCode"
                                type="text"
                                inputMode="numeric"
                                value={linkedClinicianCountryCode}
                                onChange={(e) => setLinkedClinicianCountryCode(e.target.value.replace(/\D/g, ''))}
                                aria-label="Linked clinician's country code"
                                className="w-20 pl-7 pr-2 py-2.5 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0 transition text-sm"
                                placeholder="91"
                              />
                            </div>
                            <input
                              id="linkedClinicianPhone"
                              type="tel"
                              inputMode="numeric"
                              value={linkedClinicianPhone}
                              onChange={(e) => {
                                setLinkedClinicianPhone(e.target.value.replace(/\D/g, ''));
                                setClinicianLookupError(null);
                              }}
                              aria-describedby={clinicianLookupError ? 'linkedClinicianPhone-error' : undefined}
                              className="flex-1 px-4 py-2.5 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0 transition text-sm"
                              placeholder="Ex: 9876543210"
                              required
                            />
                          </div>
                          {clinicianLookupError && (
                            <p id="linkedClinicianPhone-error" className="mt-1.5 text-sm text-danger">
                              {clinicianLookupError}
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <div>
                    <label htmlFor="profession" className="block text-sm font-medium text-text mb-2">
                      Profession
                    </label>
                    <Select
                      id="profession"
                      value={profession}
                      onChange={setProfession}
                      options={
                        accessRole === 'site_data_coordinator'
                          ? [{ value: SDC_PROFESSION_LABEL, label: SDC_PROFESSION_LABEL }]
                          : PROFESSION_OPTIONS
                      }
                      placeholder="Select profession"
                      disabled={accessRole === 'site_data_coordinator'}
                      required
                    />
                    {accessRole === 'site_data_coordinator' && (
                      <p className="mt-1.5 text-sm text-text-muted">
                        Set automatically because Role is Site Data Coordinator.
                      </p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="hospital" className="block text-sm font-medium text-text mb-2">
                      Hospital / Institution
                    </label>
                    <input
                      id="hospital"
                      type="text"
                      value={hospital}
                      onChange={(e) => setHospital(e.target.value)}
                      className="w-full px-4 py-2.5 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0 transition text-sm"
                      placeholder="Ex: City Cancer Hospital"
                      required
                    />
                  </div>

                  <div>
                    <label htmlFor="whatsapp" className="block text-sm font-medium text-text mb-2">
                      Phone Number
                    </label>
                    <div className="flex gap-2">
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle text-sm">+</span>
                        <input
                          id="signup-country-code"
                          type="text"
                          inputMode="numeric"
                          value={countryCode}
                          onChange={(e) => setCountryCode(e.target.value.replace(/\D/g, ''))}
                          className="w-20 pl-7 pr-2 py-2.5 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0 transition text-sm"
                          placeholder="91"
                        />
                      </div>
                      <input
                        id="whatsapp"
                        type="tel"
                        inputMode="numeric"
                        value={phoneNumber}
                        onChange={(e) => setPhoneNumber(e.target.value.replace(/\D/g, ''))}
                        className="flex-1 px-4 py-2.5 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0 transition text-sm"
                        placeholder="Ex: 9876543210"
                        required
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="password" className="block text-sm font-medium text-text mb-2">
                      Password
                    </label>
                    <PasswordInput
                      id="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Min. 8 chars, 1 number, 1 uppercase"
                      required
                      showStrength={true}
                    />
                  </div>

                  <div>
                    <label htmlFor="confirmPassword" className="block text-sm font-medium text-text mb-2">
                      Confirm Password
                    </label>
                    <PasswordInput
                      id="confirmPassword"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter password"
                      required
                    />
                  </div>
                </div>

                {error && (
                  <div className="text-sm text-danger bg-danger-bg p-3 rounded-lg mb-6">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full text-on-solid py-2.5 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed bg-primary-solid hover:bg-primary-solid-hover"
                >
                  {loading ? 'Sending OTP...' : 'Continue'}
                </button>
              </form>

              <div className="mt-8 text-center text-text-muted">
                <span className="text-sm">
                  Already have an account?{' '}
                  <Link to="/login" className="font-semibold transition text-link">
                    Login here
                  </Link>
                </span>
              </div>
            </>
          )}

          {/* Step 3: OTP Verification */}
          {step === 'otp' && (
            <>
              <div className="text-center mb-8">
                <h2 className="text-2xl font-semibold text-text mb-2">
                  Verify Your WhatsApp
                </h2>
                <p className="text-sm text-text-muted">
                  We've sent a 6-digit OTP to your WhatsApp<br />
                  <span className="font-semibold text-text">+{getFullPhone()}</span>
                </p>
              </div>

              <form onSubmit={handleVerifyOTP} className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-text mb-4 text-center">
                    Enter 6-Digit OTP
                  </label>
                  <div className="flex justify-center gap-2" onPaste={handleOtpPaste}>
                    {otp.map((digit, index) => (
                      <input
                        key={index}
                        ref={(el) => (otpInputsRef.current[index] = el)}
                        type="text"
                        inputMode="numeric"
                        maxLength={1}
                        value={digit}
                        onChange={(e) => handleOtpChange(index, e.target.value)}
                        onKeyDown={(e) => handleOtpKeyDown(index, e)}
                        className="w-12 h-12 text-center text-lg font-semibold border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0"
                      />
                    ))}
                  </div>
                </div>

                {error && (
                  <div className="text-sm text-danger bg-danger-bg p-3 rounded-lg text-center">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading || otp.join('').length !== 6}
                  className="w-full text-on-solid py-2.5 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed bg-primary-solid hover:bg-primary-solid-hover"
                >
                  {loading ? 'Verifying...' : 'Verify & Create Account'}
                </button>

                <div className="text-center space-y-3">
                  <button
                    type="button"
                    onClick={handleResendOTP}
                    disabled={resendCooldown > 0 || loading}
                    className={`block text-sm font-medium transition ${resendCooldown > 0 ? 'text-text-subtle' : 'text-link'}`}
                  >
                    {resendCooldown > 0 
                      ? `Resend OTP in ${resendCooldown}s` 
                      : 'Resend OTP'}
                  </button>
                  
                  <div>
                    <button
                      type="button"
                      onClick={handleBackToForm}
                      className="text-sm font-medium transition text-text-muted"
                    >
                      ← Change details
                    </button>
                  </div>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
