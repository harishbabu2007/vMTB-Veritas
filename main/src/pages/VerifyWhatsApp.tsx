import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { supabase } from '../Supabase/client';
import { showToast } from '../utils/toast';
import { sendWhatsAppOTP, verifyWhatsAppOTPForExistingUser } from '../services/whatsappOtp';
import { useIsMobile } from '../hooks/useMobile';

interface LocationState {
  userId: string;
  phone: string | null;
  email: string;
  requiresPhoneCollection?: boolean;
}

type VerificationStep = 'collect-phone' | 'verify-otp';

export function VerifyWhatsApp() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as LocationState | null;

  // Step management
  const [step, setStep] = useState<VerificationStep>('verify-otp');
  
  // Phone collection state
  const [whatsappNumber, setWhatsappNumber] = useState('');
  
  // OTP verification state
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);
  const otpInputsRef = useRef<(HTMLInputElement | null)[]>([]);
  const [initialOtpSent, setInitialOtpSent] = useState(false);
  
  // Current phone being verified (either from state or newly entered)
  const [currentPhone, setCurrentPhone] = useState<string | null>(null);
  const isMobile = useIsMobile();

  // Determine initial step based on state
  useEffect(() => {
    if (state?.requiresPhoneCollection || !state?.phone) {
      setStep('collect-phone');
    } else {
      setStep('verify-otp');
      setCurrentPhone(state.phone);
    }
  }, [state?.requiresPhoneCollection, state?.phone]);

  const sendOTPToPhone = useCallback(async (phone: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await sendWhatsAppOTP(phone);
      
      if (!result.success) {
        setError(result.error || 'Failed to send OTP');
        showToast.error(result.error || 'Failed to send OTP');
        return false;
      }
      
      showToast.success('OTP sent to your WhatsApp');
      setResendCooldown(60);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send OTP';
      setError(message);
      showToast.error(message);
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  // Redirect if no state provided
  useEffect(() => {
    if (!state?.userId) {
      navigate('/login');
    }
  }, [state, navigate]);

  // Send OTP on mount if phone exists and not requiring collection
  useEffect(() => {
    if (step === 'verify-otp' && currentPhone && !initialOtpSent) {
      setInitialOtpSent(true);
      sendOTPToPhone(currentPhone);
    }
  }, [step, currentPhone, initialOtpSent, sendOTPToPhone]);

  // Handle resend cooldown timer
  useEffect(() => {
    if (resendCooldown > 0) {
      const timer = setTimeout(() => setResendCooldown(resendCooldown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [resendCooldown]);

  // Focus first OTP input when step changes to OTP
  useEffect(() => {
    if (step === 'verify-otp') {
      setTimeout(() => otpInputsRef.current[0]?.focus(), 100);
    }
  }, [step]);

  // Handle phone number submission
  const handlePhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!whatsappNumber.trim()) {
      setError('Please enter your WhatsApp number');
      return;
    }

    // Validate phone number format (basic validation)
    const cleanedNumber = whatsappNumber.replace(/\D/g, '');
    if (cleanedNumber.length < 10) {
      setError('Please enter a valid WhatsApp number with country code');
      return;
    }

    setError(null);
    const success = await sendOTPToPhone(whatsappNumber);
    
    if (success) {
      setCurrentPhone(whatsappNumber);
      setStep('verify-otp');
      setInitialOtpSent(true);
    }
  };

  const handleResendOTP = async () => {
    if (resendCooldown > 0 || !currentPhone) return;
    setOtp(['', '', '', '', '', '']);
    setError(null);
    otpInputsRef.current[0]?.focus();
    await sendOTPToPhone(currentPhone);
  };

  const handleOtpChange = (index: number, value: string) => {
    if (!/^\d*$/.test(value)) return; // Only allow digits
    
    const newOtp = [...otp];
    newOtp[index] = value.slice(-1); // Only take last character
    setOtp(newOtp);
    
    // Auto-focus next input
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
      // Focus the input after the last pasted digit
      const focusIndex = Math.min(pastedData.length, 5);
      otpInputsRef.current[focusIndex]?.focus();
    }
  };

  const handleVerifyOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!state?.userId || !currentPhone) {
      setError('Session expired. Please login again.');
      return;
    }
    
    const otpString = otp.join('');
    if (otpString.length !== 6) {
      setError('Please enter the complete 6-digit OTP');
      return;
    }

    setError(null);
    setLoading(true);
    
    try {
      const result = await verifyWhatsAppOTPForExistingUser({
        phone: currentPhone,
        otp: otpString,
        userId: state.userId,
      });
      
      if (!result.success) {
        setError(result.error || 'Failed to verify OTP');
        return;
      }
      
      // Update the profile with WhatsApp number and verification status
      await supabase
        .from('profiles')
        .update({ 
          whatsapp_number: currentPhone,
          whatsapp_verified: true 
        })
        .eq('id', state.userId);
      
      showToast.success('WhatsApp verified successfully!');
      navigate('/my-cases');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to verify OTP';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleBackToPhoneCollection = () => {
    setStep('collect-phone');
    setOtp(['', '', '', '', '', '']);
    setError(null);
    setInitialOtpSent(false);
    setResendCooldown(0);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/login');
  };

  if (!state?.userId) {
    return null; // Will redirect in useEffect
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md">
        <div className="bg-surface rounded-2xl shadow-sm p-8">
          <div className="flex items-center justify-center space-x-3 mb-8">
            <img src="https://i.ibb.co/vxP6Cs3c/logo.png" alt="VMTB" className="h-12 w-auto" />
            <h1 className="text-3xl font-bold text-text">vMTB</h1>
          </div>

          {step === 'collect-phone' ? (
            // Step 1: Collect WhatsApp Number
            <>
              <div className="text-center mb-8">
                <div className="inline-flex items-center justify-center bg-success-bg-strong rounded-full mb-4 w-16 h-16">
                  <svg className="text-success w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                  </svg>
                </div>
                <h2 className="text-2xl font-semibold text-text mb-2">
                  WhatsApp Verification
                </h2>
                <p className="text-sm text-text-muted">
                  Please provide your WhatsApp number to verify your account
                </p>
              </div>

              <form onSubmit={handlePhoneSubmit} className="space-y-5">
                <div>
                  <label htmlFor="whatsapp" className="block text-sm font-medium text-text mb-2">
                    WhatsApp Number
                  </label>
                  <input
                    id="whatsapp"
                    type="tel"
                    value={whatsappNumber}
                    onChange={(e) => setWhatsappNumber(e.target.value)}
                    placeholder="e.g., +91 98765 43210"
                    className="w-full px-4 py-2.5 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0 transition text-sm"
                    style={{ fontSize: '16px' }}
                    required
                  />
                  <p className="text-xs mt-1.5 text-text-muted">
                    Include country code (e.g. +91 for India)
                  </p>
                </div>

                {error && (
                  <div className="text-sm text-danger bg-danger-bg p-3 rounded-lg">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading || !whatsappNumber.trim()}
                  className="w-full text-on-solid py-2.5 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed bg-primary-solid hover:bg-primary-solid-hover"
                >
                  {loading ? 'Sending OTP...' : 'Send OTP'}
                </button>

                <div className="text-center">
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="text-sm font-medium transition text-text-muted"
                  >
                    ← Back to login
                  </button>
                </div>
              </form>
            </>
          ) : (
            // Step 2: Verify OTP
            <>
              <div className="text-center mb-8">
                <div className="inline-flex items-center justify-center bg-success-bg-strong rounded-full mb-4 w-16 h-16">
                  <svg className="text-success w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                  </svg>
                </div>
                <h2 className="text-2xl font-semibold text-text mb-2">
                  Verify WhatsApp
                </h2>
                <p className="text-sm text-text-muted">
                  We've sent a 6-digit code to your WhatsApp<br />
                  <span className="font-semibold text-text">{currentPhone}</span>
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
                  {loading ? 'Verifying...' : 'Verify WhatsApp'}
                </button>

                <div className="text-center space-y-3">
                  <button
                    type="button"
                    onClick={handleResendOTP}
                    disabled={resendCooldown > 0 || loading}
                    className={`text-sm font-medium transition ${resendCooldown > 0 ? 'text-text-subtle' : 'text-link'}`}
                  >
                    {resendCooldown > 0 
                      ? `Resend OTP in ${resendCooldown}s` 
                      : 'Resend OTP'}
                  </button>
                  
                  {state?.requiresPhoneCollection && (
                    <div>
                      <button
                        type="button"
                        onClick={handleBackToPhoneCollection}
                        className="text-sm font-medium transition text-link"
                      >
                        Change WhatsApp number
                      </button>
                    </div>
                  )}
                  
                  <div>
                    <button
                      type="button"
                      onClick={handleLogout}
                      className="text-sm font-medium transition text-text-muted"
                    >
                      ← Back to login
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
