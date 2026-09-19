import { useState, useRef, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { showToast } from '../utils/toast';
import { sendWhatsAppOTP, verifyWhatsAppOTPForLogin, isPhoneNumberRegistered } from '../services/whatsappOtp';
import { supabase } from '../Supabase/client';
import { PasswordInput } from '../components/PasswordInput';

type LoginMode = 'password' | 'otp-send' | 'otp-verify';

export function Login() {
  const [countryCode, setCountryCode] = useState('91');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [password, setPassword] = useState('');
  const navigate = useNavigate();
  const { loginWithPhone, signInWithGoogle } = useAuth();

  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<LoginMode>('password');

  // OTP state
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [resendCooldown, setResendCooldown] = useState(0);
  const otpInputsRef = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (resendCooldown > 0) {
      const timer = setTimeout(() => setResendCooldown(resendCooldown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [resendCooldown]);

  useEffect(() => {
    if (mode === 'otp-verify') {
      otpInputsRef.current[0]?.focus();
    }
  }, [mode]);

  const getFullPhone = () => {
    const cleanCode = countryCode.replace(/\D/g, '');
    const cleanNum = phoneNumber.replace(/\D/g, '');
    return `${cleanCode}${cleanNum}`;
  };

  const handlePhonePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const cleanPhone = phoneNumber.replace(/\D/g, '');
      if (!cleanPhone) {
        setError('Phone number is required');
        setLoading(false);
        return;
      }
      if (!password.trim()) {
        setError('Password is required');
        setLoading(false);
        return;
      }

      const fullPhone = getFullPhone();
      // Check if phone number exists in database
      const checkRes = await isPhoneNumberRegistered(fullPhone);
      if (!checkRes.registered) {
        showToast.error("No account was found with this phone number. Let's create your account.");
        navigate('/signup');
        setLoading(false);
        return;
      }

      await loginWithPhone(countryCode, cleanPhone, password);
      showToast.success('Logged in successfully!');
      navigate('/my-cases');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      if (message.toLowerCase().includes('no account') || message.toLowerCase().includes('not found')) {
        showToast.error("No account was found with this phone number. Let's create your account.");
        navigate('/signup');
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setError(null);
    setGoogleLoading(true);
    try {
      await signInWithGoogle('login');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Google login failed';
      setError(message);
      setGoogleLoading(false);
    }
  };

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const cleanPhone = phoneNumber.replace(/\D/g, '');
      if (!cleanPhone) {
        setError('Phone number is required');
        setLoading(false);
        return;
      }
      
      const fullPhone = getFullPhone();
      // Check if phone number exists in database before sending OTP
      const checkRes = await isPhoneNumberRegistered(fullPhone);
      if (!checkRes.registered) {
        showToast.error("No account was found with this phone number. Let's create your account.");
        navigate('/signup');
        setLoading(false);
        return;
      }

      const result = await sendWhatsAppOTP(fullPhone);
      
      if (!result.success) {
        setError(result.error || 'Failed to send OTP');
        return;
      }
      
      showToast.success('OTP sent to your WhatsApp');
      setMode('otp-verify');
      setResendCooldown(60);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send OTP';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleResendOtp = async () => {
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

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    
    const otpString = otp.join('');
    if (otpString.length !== 6) {
      setError('Please enter the complete 6-digit OTP');
      setLoading(false);
      return;
    }
    
    try {
      const fullPhone = getFullPhone();
      
      // Step 1: Call Edge Function to verify OTP and obtain login token
      const result = await verifyWhatsAppOTPForLogin({
        phone: fullPhone,
        otp: otpString,
      });
      
      if (!result.success || !result.email || !result.email_otp) {
        const errStr = (result.error || '').toLowerCase();
        if (errStr.includes('no account') || errStr.includes('not found')) {
          showToast.error("No account was found with this phone number. Let's create your account.");
          navigate('/signup');
        } else {
          setError(result.error || 'The OTP entered is incorrect. Please try again.');
        }
        return;
      }
      
      // Step 2: Establish client session directly using verifyOtp
      const { error: authError } = await supabase.auth.verifyOtp({
        email: result.email,
        token: result.email_otp,
        type: 'email',
      });

      if (authError) {
        console.error('[Login] verifyOtp session error:', authError);
        setError('Failed to establish login session. Please try again.');
        return;
      }

      showToast.success('Logged in successfully!');
      navigate('/my-cases', { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'OTP verification failed';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md">
        <div className="bg-surface rounded-2xl shadow-sm p-8">
          <div className="flex items-center justify-center space-x-3 mb-8">
            <img src="https://i.ibb.co/vxP6Cs3c/logo.png" alt="VMTB" className="h-12 w-auto" />
            <h1 className="text-3xl font-bold text-text">vMTB</h1>
          </div>

          <h2 className="text-2xl font-semibold text-text mb-2 text-center">
            Welcome Back
          </h2>
          <p className="text-center text-text-muted mb-8">
            Login to your account
          </p>

          {/* Google Login Button */}
          <button
            type="button"
            onClick={handleGoogleLogin}
            disabled={googleLoading}
            className="w-full flex items-center justify-center gap-3 px-4 py-2.5 border border-border rounded-lg font-medium text-text transition hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed mb-6"
          >
            {googleLoading ? (
              <div
                className="w-5 h-5 border-2 border-border rounded-full animate-spin"
                style={{ borderTopColor: 'var(--color-primary)' }}
              />
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
            )}
            {googleLoading ? 'Connecting...' : 'Continue with Google'}
          </button>

          {/* Separator */}
          <div className="relative mb-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-4 bg-surface text-text-muted">OR</span>
            </div>
          </div>

          {mode === 'password' && (
            <form onSubmit={handlePhonePasswordLogin} className="space-y-5">
              <div>
                <label htmlFor="phone" className="block text-sm font-medium text-text mb-2">
                  Phone Number
                </label>
                <div className="flex gap-2">
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">+</span>
                    <input
                      id="countryCode"
                      type="text"
                      inputMode="numeric"
                      value={countryCode}
                      onChange={(e) => setCountryCode(e.target.value.replace(/\D/g, ''))}
                      className="w-20 pl-7 pr-2 py-2.5 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0 transition text-sm"
                      placeholder="91"
                    />
                  </div>
                  <input
                    id="phone"
                    type="tel"
                    inputMode="numeric"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value.replace(/\D/g, ''))}
                    className="flex-1 px-4 py-2.5 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0 transition text-sm"
                    placeholder="9876543210"
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
                  placeholder="Enter your password"
                  required
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
                className="w-full bg-primary hover:bg-primary-hover text-white py-2.5 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Logging in...' : 'Login'}
              </button>
            </form>
          )}

          {mode === 'otp-send' && (
            <form onSubmit={handleSendOtp} className="space-y-5">
              <div>
                <label htmlFor="otp-phone" className="block text-sm font-medium text-text mb-2">
                  Phone Number
                </label>
                <div className="flex gap-2">
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">+</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={countryCode}
                      onChange={(e) => setCountryCode(e.target.value.replace(/\D/g, ''))}
                      className="w-20 pl-7 pr-2 py-2.5 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0 transition text-sm"
                      placeholder="91"
                    />
                  </div>
                  <input
                    id="otp-phone"
                    type="tel"
                    inputMode="numeric"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value.replace(/\D/g, ''))}
                    className="flex-1 px-4 py-2.5 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0 transition text-sm"
                    placeholder="9876543210"
                    required
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
                className="w-full bg-primary hover:bg-primary-hover text-white py-2.5 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Sending OTP...' : 'Send OTP'}
              </button>

              <button
                type="button"
                onClick={() => { setMode('password'); setError(null); }}
                className="w-full text-sm font-medium transition text-center text-text-muted"
              >
                ← Back to password login
              </button>
            </form>
          )}

          {mode === 'otp-verify' && (
            <form onSubmit={handleVerifyOtp} className="space-y-6">
              <div className="text-center mb-2">
                <p className="text-sm text-text-muted">
                  OTP sent to <span className="font-semibold text-text">+{getFullPhone()}</span>
                </p>
              </div>

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
                <div className="text-sm text-red-600 bg-red-50 p-3 rounded-lg text-center">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || otp.join('').length !== 6}
                className="w-full bg-primary hover:bg-primary-hover text-white py-2.5 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Verifying...' : 'Verify & Login'}
              </button>

              <div className="text-center space-y-3">
                <button
                  type="button"
                  onClick={handleResendOtp}
                  disabled={resendCooldown > 0 || loading}
                  className={`block text-sm font-medium transition ${resendCooldown > 0 ? 'text-gray-400' : 'text-primary'}`}
                >
                  {resendCooldown > 0 
                    ? `Resend OTP in ${resendCooldown}s` 
                    : 'Resend OTP'}
                </button>
                
                <div>
                  <button
                    type="button"
                    onClick={() => { setMode('otp-send'); setOtp(['', '', '', '', '', '']); setError(null); }}
                    className="text-sm font-medium transition text-text-muted"
                  >
                    ← Change phone number
                  </button>
                </div>
              </div>
            </form>
          )}

          <div className="mt-7 text-center space-y-3">
            {mode === 'password' && (
              <button
                type="button"
                onClick={() => { setMode('otp-send'); setError(null); }}
                className="block w-full text-sm font-medium transition text-primary"
              >
                Login using OTP
              </button>
            )}
            <Link
              to="/forgot-password"
              className="block text-sm font-medium transition text-primary"
            >
              Forgot your password?
            </Link>
            <div className="text-sm text-text-muted">
              Don't have an account?{' '}
              <Link
                to="/signup"
                className="font-semibold transition text-primary"
              >
                Sign Up
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
