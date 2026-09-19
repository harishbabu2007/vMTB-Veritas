import React, { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircle, ShieldCheck } from 'lucide-react';
import { PasswordInput } from '../components/PasswordInput';
import { validatePasswordRules } from '../components/PasswordStrength';
import { sendWhatsAppOTP, verifyWhatsAppOTPForReset, completePasswordReset } from '../services/whatsappOtp';

export function ForgotPassword() {
  const navigate = useNavigate();

  // Multi-step state: 'phone' | 'otp' | 'reset' | 'success'
  const [step, setStep] = useState<'phone' | 'otp' | 'reset' | 'success'>('phone');

  // Form State
  const [countryCode, setCountryCode] = useState('91');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Auxiliary State
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendTimer, setResendTimer] = useState(0);

  // Input refs for 6 OTP boxes
  const otpInputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Timer for OTP resend cooldown
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (resendTimer > 0) {
      interval = setInterval(() => {
        setResendTimer((prev) => prev - 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [resendTimer]);

  // Clean full phone number
  const getFullPhone = () => {
    const cleanCC = countryCode.replace(/\D/g, '');
    const cleanPN = phoneNumber.replace(/\D/g, '');
    return `${cleanCC}${cleanPN}`;
  };

  // STEP 1: Send WhatsApp OTP
  const handleSendOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const cleanPN = phoneNumber.replace(/\D/g, '');
    if (cleanPN.length < 10) {
      setError('Please enter a valid 10-digit phone number');
      return;
    }

    setLoading(true);
    try {
      const fullPhone = getFullPhone();
      const res = await sendWhatsAppOTP(fullPhone);
      if (!res.success) {
        throw new Error(res.error || 'Failed to send WhatsApp OTP');
      }
      setStep('otp');
      setResendTimer(60);
    } catch (err: any) {
      setError(err?.message || 'Failed to send WhatsApp OTP');
    } finally {
      setLoading(false);
    }
  };

  // Resend OTP
  const handleResendOTP = async () => {
    if (resendTimer > 0 || loading) return;
    setError(null);
    setLoading(true);
    try {
      const fullPhone = getFullPhone();
      const res = await sendWhatsAppOTP(fullPhone);
      if (!res.success) {
        throw new Error(res.error || 'Failed to resend OTP');
      }
      setResendTimer(60);
    } catch (err: any) {
      setError(err?.message || 'Failed to resend OTP');
    } finally {
      setLoading(false);
    }
  };

  // OTP Box Handlers
  const handleOtpChange = (index: number, value: string) => {
    if (value.length > 1) {
      const pasted = value.replace(/\D/g, '').slice(0, 6);
      if (pasted.length > 0) {
        const newOtp = [...otp];
        for (let i = 0; i < 6; i++) {
          newOtp[i] = pasted[i] || '';
        }
        setOtp(newOtp);
        const nextFocus = Math.min(pasted.length, 5);
        otpInputRefs.current[nextFocus]?.focus();
      }
      return;
    }

    const digit = value.replace(/\D/g, '');
    const newOtp = [...otp];
    newOtp[index] = digit;
    setOtp(newOtp);

    if (digit && index < 5) {
      otpInputRefs.current[index + 1]?.focus();
    }
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      otpInputRefs.current[index - 1]?.focus();
    }
  };

  const handleOtpPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pastedData) {
      const newOtp = [...otp];
      for (let i = 0; i < 6; i++) {
        newOtp[i] = pastedData[i] || '';
      }
      setOtp(newOtp);
      const focusIndex = Math.min(pastedData.length, 5);
      otpInputRefs.current[focusIndex]?.focus();
    }
  };

  // STEP 2: Verify OTP
  const handleVerifyOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const otpString = otp.join('');
    if (otpString.length < 6) {
      setError('Please enter the complete 6-digit OTP');
      return;
    }

    setLoading(true);
    try {
      const fullPhone = getFullPhone();
      const res = await verifyWhatsAppOTPForReset({
        phone: fullPhone,
        otp: otpString,
      });

      if (!res.success || !res.userId) {
        throw new Error(res.error || 'Invalid OTP or account not found');
      }

      setUserId(res.userId);
      setStep('reset');
    } catch (err: any) {
      setError(err?.message || 'Failed to verify OTP');
    } finally {
      setLoading(false);
    }
  };

  // STEP 3: Complete Password Reset
  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const passRules = validatePasswordRules(newPassword);
    if (!passRules.isValid) {
      setError('Password must be at least 8 characters long, contain a number, and contain an uppercase letter.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (!userId) {
      setError('Session expired. Please restart password reset.');
      setStep('phone');
      return;
    }

    setLoading(true);
    try {
      const fullPhone = getFullPhone();
      const res = await completePasswordReset({
        userId,
        newPassword,
        phone: fullPhone,
      });

      if (!res.success) {
        throw new Error(res.error || 'Failed to reset password');
      }

      setStep('success');
      setTimeout(() => {
        navigate('/login');
      }, 2500);
    } catch (err: any) {
      setError(err?.message || 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md">
        <div className="bg-surface rounded-2xl shadow-sm p-8">
          {/* Header */}
          <div className="flex items-center justify-center space-x-3 mb-8">
            <img src="https://i.ibb.co/vxP6Cs3c/logo.png" alt="VMTB" className="h-12 w-auto" />
            <h1 className="text-3xl font-bold text-text">vMTB</h1>
          </div>

          {/* STEP 1: Enter Phone Number */}
          {step === 'phone' && (
            <>
              <h2 className="text-2xl font-semibold text-text mb-2 text-center">
                Reset Your Password
              </h2>
              <p className="text-center mb-8 text-text-muted text-sm">
                Enter your WhatsApp phone number to receive a verification code.
              </p>

              <form onSubmit={handleSendOTP} className="space-y-5">
                <div>
                  <label htmlFor="phoneNumber" className="block text-sm font-medium text-text mb-2">
                    Phone Number (WhatsApp)
                  </label>
                  {/* Side-by-Side Country Code + Phone Input */}
                  <div className="flex gap-2">
                    <div className="relative w-28 flex-shrink-0">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm font-medium">
                        +
                      </span>
                      <input
                        type="text"
                        value={countryCode}
                        onChange={(e) => setCountryCode(e.target.value.replace(/\D/g, ''))}
                        className="w-full pl-7 pr-3 py-2.5 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary text-sm font-medium text-text"
                        style={{ fontSize: '16px' }}
                        placeholder="91"
                        required
                        disabled={loading}
                      />
                    </div>
                    <input
                      id="phoneNumber"
                      type="tel"
                      value={phoneNumber}
                      onChange={(e) => setPhoneNumber(e.target.value)}
                      className="w-full px-4 py-2.5 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary transition text-sm"
                      style={{ fontSize: '16px' }}
                      placeholder="10-digit phone number"
                      required
                      disabled={loading}
                    />
                  </div>
                </div>

                {error && (
                  <div className="text-sm text-red-600 bg-red-50 p-3 rounded-lg">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full text-white py-2.5 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed bg-primary hover:bg-primary-hover"
                >
                  {loading ? 'Sending OTP...' : 'Send WhatsApp OTP'}
                </button>
              </form>
            </>
          )}

          {/* STEP 2: Enter 6-Box OTP */}
          {step === 'otp' && (
            <>
              <div className="flex justify-center mb-4">
                <div className="w-12 h-12 rounded-full bg-status-processing-bg flex items-center justify-center">
                  <ShieldCheck className="w-6 h-6 text-primary" />
                </div>
              </div>
              <h2 className="text-2xl font-semibold text-text mb-2 text-center">
                Verify WhatsApp OTP
              </h2>
              <p className="text-center mb-6 text-text-muted text-sm">
                Enter the 6-digit code sent to your WhatsApp number:<br />
                <span className="font-semibold text-text">+{countryCode} {phoneNumber}</span>
              </p>

              <form onSubmit={handleVerifyOTP} className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-text mb-3 text-center">
                    Enter Verification Code
                  </label>
                  {/* 6-box OTP Inputs */}
                  <div className="flex justify-center gap-2" onPaste={handleOtpPaste}>
                    {otp.map((digit, index) => (
                      <input
                        key={index}
                        ref={(el) => (otpInputRefs.current[index] = el)}
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        value={digit}
                        onChange={(e) => handleOtpChange(index, e.target.value)}
                        onKeyDown={(e) => handleOtpKeyDown(index, e)}
                        className="w-11 h-12 text-center text-xl font-bold border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition"
                        disabled={loading}
                        autoFocus={index === 0}
                      />
                    ))}
                  </div>
                </div>

                {error && (
                  <div className="text-sm text-red-600 bg-red-50 p-3 rounded-lg text-center">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading || otp.join('').length < 6}
                  className="w-full text-white py-2.5 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed bg-primary hover:bg-primary-hover"
                >
                  {loading ? 'Verifying...' : 'Verify OTP'}
                </button>

                <div className="text-center pt-2">
                  {resendTimer > 0 ? (
                    <p className="text-xs text-text-muted">
                      Resend code in <span className="font-semibold text-text">{resendTimer}s</span>
                    </p>
                  ) : (
                    <button
                      type="button"
                      onClick={handleResendOTP}
                      disabled={loading}
                      className="text-xs font-semibold text-primary hover:underline focus:outline-none"
                    >
                      Resend WhatsApp OTP
                    </button>
                  )}
                </div>
              </form>
            </>
          )}

          {/* STEP 3: Enter New Password */}
          {step === 'reset' && (
            <>
              <h2 className="text-2xl font-semibold text-text mb-2 text-center">
                Set New Password
              </h2>
              <p className="text-center mb-6 text-text-muted text-sm">
                Create a new secure password for your vMTB account.
              </p>

              <form onSubmit={handleResetPassword} className="space-y-5">
                <div>
                  <label htmlFor="newPassword" className="block text-sm font-medium text-text mb-2">
                    New Password
                  </label>
                  <PasswordInput
                    id="newPassword"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Min. 8 chars, 1 number, 1 uppercase"
                    required
                    disabled={loading}
                    showStrength={true}
                  />
                </div>

                <div>
                  <label htmlFor="confirmPassword" className="block text-sm font-medium text-text mb-2">
                    Confirm New Password
                  </label>
                  <PasswordInput
                    id="confirmPassword"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter new password"
                    required
                    disabled={loading}
                  />
                </div>

                {error && (
                  <div className="text-sm text-red-600 bg-red-50 p-3 rounded-lg">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full text-white py-2.5 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed bg-primary hover:bg-primary-hover"
                >
                  {loading ? 'Updating Password...' : 'Reset Password'}
                </button>
              </form>
            </>
          )}

          {/* STEP 4: Success Message */}
          {step === 'success' && (
            <div className="text-center py-4">
              <div className="inline-flex items-center justify-center bg-green-100 rounded-full mb-6 w-16 h-16">
                <CheckCircle className="text-green-600 w-8 h-8" />
              </div>
              <h2 className="text-2xl font-semibold text-text mb-2">
                Password Reset Successful!
              </h2>
              <p className="text-text-muted mb-6 text-sm">
                Your password has been updated successfully. Redirecting you to the login page...
              </p>
            </div>
          )}

          {/* Footer Back to Login Link */}
          {step !== 'success' && (
            <div className="mt-8 text-center">
              <Link
                to="/login"
                className="text-sm font-medium text-text-muted hover:text-text transition"
              >
                ← Back to Login
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
