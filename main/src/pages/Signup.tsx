import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link, useLocation } from 'react-router-dom';
import { supabase } from '../Supabase/client';
import { showToast } from '../utils/toast';
import { sendWhatsAppOTP, verifyWhatsAppOTPForExistingUser, isPhoneNumberRegistered } from '../services/whatsappOtp';
import { useAuth } from '../context/AuthContext';
import { PasswordInput } from '../components/PasswordInput';
import { validatePasswordRules } from '../components/PasswordStrength';

type SignupStep = 'google-gate' | 'form' | 'otp';

interface GoogleState {
  googleEmail: string;
  googleUserId: string;
  googleName: string;
  googleAuthenticated: boolean;
}

export function Signup() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signInWithGoogle, markRegistrationComplete } = useAuth();

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

  // Google auth data (from OAuth callback)
  const [googleEmail, setGoogleEmail] = useState('');
  const [googleUserId, setGoogleUserId] = useState('');

  // OTP verification state
  const [step, setStep] = useState<SignupStep>('google-gate');
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [resendCooldown, setResendCooldown] = useState(0);
  const otpInputsRef = useRef<(HTMLInputElement | null)[]>([]);

  // Initialize from Google state if available
  useEffect(() => {
    if (googleState?.googleAuthenticated && googleState?.googleEmail) {
      setGoogleEmail(googleState.googleEmail);
      setGoogleUserId(googleState.googleUserId);
      setName(googleState.googleName || '');
      setStep('form');
    }
  }, [googleState]);

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

      // Check if phone number is already registered to another account
      const checkRes = await isPhoneNumberRegistered(fullPhone, googleUserId || undefined);
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

    setError(null);
    setLoading(true);
    
    try {
      const fullPhone = getFullPhone();
      const phoneE164 = `+${fullPhone}`;
      
      // Step 1: Verify OTP and update auth user (password + confirmed phone) & profile via Edge Function
      const result = await verifyWhatsAppOTPForExistingUser({
        phone: fullPhone,
        otp: otpString,
        userId: googleUserId,
        password: password,
        phoneE164: phoneE164,
        fullName: name,
        profession: profession,
        hospital: hospital,
      });
      
      if (!result.success) {
        setError(result.error || 'Failed to verify OTP');
        return;
      }

      // Step 2: Also update local profile state directly for fast availability
      await supabase.from('profiles').upsert({
        id: googleUserId,
        full_name: name,
        profession: profession || null,
        hospital: hospital || null,
        whatsapp_number: fullPhone,
        whatsapp_verified: true,
        whatsapp_opt_in: true,
      }, { onConflict: 'id' });

      showToast.success('Account created successfully!');

      // Step 3: User is already authenticated via Google OAuth — navigate directly to /my-cases.
      // AuthContext's own registration-status check runs off auth *events*, not table writes,
      // so it doesn't know this just-finished signup is complete yet; without this, ProtectedRoute
      // would see the stale "incomplete" status and bounce back to /signup in a loop.
      markRegistrationComplete();
      navigate('/my-cases', { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create account';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleBackToForm = () => {
    setStep('form');
    setOtp(['', '', '', '', '', '']);
    setError(null);
  };

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4 py-8">
      <div className={`w-full ${step === 'form' ? 'max-w-3xl' : 'max-w-md'}`}>
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
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                  {/* Left Column */}
                  <div className="space-y-5">
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
                      <label htmlFor="profession" className="block text-sm font-medium text-text mb-2">
                        Profession
                      </label>
                      <select
                        id="profession"
                        value={profession}
                        onChange={(e) => setProfession(e.target.value)}
                        className="w-full px-4 py-2.5 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0 transition text-sm"
                        required
                      >
                        <option value="">Select profession</option>
                        <option value="Medical oncologist">Medical oncologist</option>
                        <option value="Surgical oncologist">Surgical oncologist</option>
                        <option value="Radiation oncologist">Radiation oncologist</option>
                        <option value="Hematologist-oncologist">Hematologist-oncologist</option>
                        <option value="Radiologist">Radiologist</option>
                        <option value="Pathologist">Pathologist</option>
                        <option value="Molecular pathologist">Molecular pathologist</option>
                        <option value="Medical physicist">Medical physicist</option>
                        <option value="Dosimetrist">Dosimetrist</option>
                        <option value="Radiation therapist">Radiation therapist</option>
                        <option value="Oncology nurse / staff nurse">Oncology nurse / staff nurse</option>
                        <option value="Infusion nurse">Infusion nurse</option>
                        <option value="Oncology pharmacist">Oncology pharmacist</option>
                        <option value="Palliative care specialist">Palliative care specialist</option>
                        <option value="Dietitian / oncology nutritionist">Dietitian / oncology nutritionist</option>
                        <option value="Genetic counselor">Genetic counselor</option>
                        <option value="Cardio-oncologist">Cardio-oncologist</option>
                        <option value="Pulmonologist">Pulmonologist</option>
                        <option value="Nephrologist">Nephrologist</option>
                        <option value="Hepatologist">Hepatologist</option>
                        <option value="Endocrinologist">Endocrinologist</option>
                        <option value="Oral surgeon">Oral surgeon</option>
                        <option value="Administrative staff">Administrative staff</option>
                        <option value="Geneticist">Geneticist</option>
                        <option value="Genomicist">Genomicist</option>
                      </select>
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
                  </div>

                  {/* Right Column */}
                  <div className="space-y-5">
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
