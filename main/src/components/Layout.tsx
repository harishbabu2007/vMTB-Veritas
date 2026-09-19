import { ReactNode, useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { LogOut, MessageSquare, Settings, ChevronDown, Bell, Upload, Archive, Sun, Moon, Monitor } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { Modal } from './Modal';
import { MobileNav } from './MobileNav';
import { VoiceRecorder } from './VoiceRecorder';
import { Avatar } from './Avatar';
import { DismissButton } from './DismissButton';
import { useIsMobile } from '../hooks/useMobile';
import { supabase } from '../Supabase/client';
import { sendWhatsAppOTP, verifyWhatsAppOTPForExistingUser } from '../services/whatsappOtp';
import { uploadProfilePhoto } from '../services/profilePhoto';

interface LayoutProps {
  children: ReactNode;
  wide?: boolean;
}

export function Layout({ children, wide = false }: LayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { logout, user, updateAvatarKey } = useAuth();
  const { theme, setTheme } = useTheme();
  const [showDropdown, setShowDropdown] = useState(false);
  const [showNotificationDropdown, setShowNotificationDropdown] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const notificationRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  // Photo upload state
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const handlePhotoSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !user?.id) return;

    setPhotoError(null);
    setPhotoUploading(true);
    try {
      const key = await uploadProfilePhoto(file);
      await supabase.from('profiles').update({ avatar_key: key }).eq('id', user.id);
      updateAvatarKey(key);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to upload photo.';
      setPhotoError(message);
    } finally {
      setPhotoUploading(false);
    }
  };

  // Profile form state
  const [profileName, setProfileName] = useState(user?.name || '');
  const [profileProfession, setProfileProfession] = useState('');
  const [profileHospital, setProfileHospital] = useState('');
  const [profileWhatsapp, setProfileWhatsapp] = useState('');
  const [originalWhatsapp, setOriginalWhatsapp] = useState('');
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);

  // WhatsApp number change verification state
  const [whatsappStep, setWhatsappStep] = useState<'idle' | 'otp-sent'>('idle');
  const [whatsappOtp, setWhatsappOtp] = useState(['', '', '', '', '', '']);
  const [whatsappOtpError, setWhatsappOtpError] = useState<string | null>(null);
  const [whatsappOtpLoading, setWhatsappOtpLoading] = useState(false);
  const [whatsappResendCooldown, setWhatsappResendCooldown] = useState(0);
  const whatsappOtpInputsRef = useRef<(HTMLInputElement | null)[]>([]);

  // Feedback form state
  const [feedbackType, setFeedbackType] = useState('');
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
      if (notificationRef.current && !notificationRef.current.contains(event.target as Node)) {
        setShowNotificationDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Load profile data when modal opens
  useEffect(() => {
    const loadProfile = async () => {
      if (showProfileModal && user?.id) {
        const { data } = await supabase
          .from('profiles')
          .select('full_name, profession, hospital, whatsapp_number')
          .eq('id', user.id)
          .single();
        if (data) {
          setProfileName(data.full_name || '');
          setProfileProfession(data.profession || '');
          setProfileHospital(data.hospital || '');
          setProfileWhatsapp(data.whatsapp_number || '');
          setOriginalWhatsapp(data.whatsapp_number || '');
        }
      }
    };
    loadProfile();
  }, [showProfileModal, user?.id]);

  // Validation for required profile fields
  const isProfileValid = profileName.trim() && profileProfession.trim() && profileHospital.trim() && profileWhatsapp.trim();
  const [profileError, setProfileError] = useState<string | null>(null);

  // WhatsApp OTP resend cooldown timer
  useEffect(() => {
    if (whatsappResendCooldown > 0) {
      const timer = setTimeout(() => setWhatsappResendCooldown(whatsappResendCooldown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [whatsappResendCooldown]);

  const resetWhatsappOtpState = () => {
    setWhatsappStep('idle');
    setWhatsappOtp(['', '', '', '', '', '']);
    setWhatsappOtpError(null);
    setWhatsappResendCooldown(0);
  };

  const handleSaveProfile = async () => {
    if (!user?.id) return;

    // Validate required fields
    if (!profileName.trim()) {
      setProfileError('Full name is required');
      return;
    }
    if (!profileProfession.trim()) {
      setProfileError('Profession is required');
      return;
    }
    if (!profileHospital.trim()) {
      setProfileError('Hospital/Institution is required');
      return;
    }
    if (!profileWhatsapp.trim()) {
      setProfileError('WhatsApp number is required');
      return;
    }

    setProfileError(null);
    setProfileLoading(true);
    try {
      // whatsapp_number is intentionally excluded here — it's only ever written
      // server-side by the Edge Function, after OTP verification below.
      await supabase
        .from('profiles')
        .update({
          full_name: profileName.trim(),
          profession: profileProfession.trim(),
          hospital: profileHospital.trim(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', user.id);

      const whatsappChanged = profileWhatsapp.trim() !== originalWhatsapp.trim();
      if (!whatsappChanged) {
        setProfileSaved(true);
        setTimeout(() => {
          setProfileSaved(false);
          setShowProfileModal(false);
        }, 1500);
        return;
      }

      const otpResult = await sendWhatsAppOTP(profileWhatsapp.trim());
      if (!otpResult.success) {
        setProfileError(otpResult.error || 'Failed to send OTP. Please try again.');
        return;
      }
      setWhatsappStep('otp-sent');
      setWhatsappResendCooldown(60);
    } catch (err) {
      console.error('Failed to save profile:', err);
      setProfileError('Failed to save profile. Please try again.');
    } finally {
      setProfileLoading(false);
    }
  };

  const handleVerifyWhatsappOtp = async () => {
    if (!user?.id) return;
    const otpString = whatsappOtp.join('');
    if (otpString.length !== 6) {
      setWhatsappOtpError('Please enter the complete 6-digit OTP');
      return;
    }

    setWhatsappOtpError(null);
    setWhatsappOtpLoading(true);
    try {
      const result = await verifyWhatsAppOTPForExistingUser({
        phone: profileWhatsapp.trim(),
        otp: otpString,
        userId: user.id,
      });

      if (!result.success) {
        setWhatsappOtpError(result.error || 'Failed to verify OTP');
        return;
      }

      // The Edge Function has already written whatsapp_number/whatsapp_verified
      // server-side — nothing further to save client-side.
      setOriginalWhatsapp(profileWhatsapp.trim());
      resetWhatsappOtpState();
      setProfileSaved(true);
      setTimeout(() => {
        setProfileSaved(false);
        setShowProfileModal(false);
      }, 1500);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to verify OTP';
      setWhatsappOtpError(message);
    } finally {
      setWhatsappOtpLoading(false);
    }
  };

  const handleChangeWhatsappNumber = () => {
    resetWhatsappOtpState();
  };

  const handleResendWhatsappOtp = async () => {
    if (whatsappResendCooldown > 0) return;
    setWhatsappOtp(['', '', '', '', '', '']);
    setWhatsappOtpError(null);
    const result = await sendWhatsAppOTP(profileWhatsapp.trim());
    if (!result.success) {
      setWhatsappOtpError(result.error || 'Failed to resend OTP');
      return;
    }
    setWhatsappResendCooldown(60);
    whatsappOtpInputsRef.current[0]?.focus();
  };

  const handleWhatsappOtpChange = (index: number, value: string) => {
    if (!/^\d*$/.test(value)) return;
    const newOtp = [...whatsappOtp];
    newOtp[index] = value.slice(-1);
    setWhatsappOtp(newOtp);
    if (value && index < 5) {
      whatsappOtpInputsRef.current[index + 1]?.focus();
    }
  };

  const handleWhatsappOtpKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !whatsappOtp[index] && index > 0) {
      whatsappOtpInputsRef.current[index - 1]?.focus();
    }
  };

  const handleWhatsappOtpPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pastedData) {
      const newOtp = [...whatsappOtp];
      for (let i = 0; i < pastedData.length && i < 6; i++) {
        newOtp[i] = pastedData[i];
      }
      setWhatsappOtp(newOtp);
      const focusIndex = Math.min(pastedData.length, 5);
      whatsappOtpInputsRef.current[focusIndex]?.focus();
    }
  };

  const handleSendFeedback = async () => {
    if (!user?.id || !feedbackText.trim() || !feedbackType) return;
    setFeedbackLoading(true);
    try {
      // Concatenate feedbackType with feedbackText
      const fullFeedback = `${feedbackType} - ${feedbackText.trim()}`;
      await supabase.from('feedback').insert({
        user_id: user.id,
        content: fullFeedback,
      });
      setFeedbackSent(true);
      setFeedbackText('');
      setFeedbackType('');
      setTimeout(() => {
        setFeedbackSent(false);
        setShowFeedbackModal(false);
      }, 1500);
    } catch (err) {
      console.error('Failed to send feedback:', err);
    } finally {
      setFeedbackLoading(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const isActive = (path: string) => location.pathname === path;

  const greetingText = (() => {
    const emailPrefix = user?.email ? user.email.split('@')[0] : '';
    const rawName = (user?.name && user.name.trim()) || emailPrefix;
    if (!rawName) return '';
    const formatted = rawName.charAt(0).toUpperCase() + rawName.slice(1);
    return `Hello, Dr ${formatted}`;
  })();

  return (
    <div className="min-h-screen bg-bg">
      {/* Mobile Navigation - Only visible on mobile screens */}
      {isMobile && (
        <MobileNav
          onProfileClick={() => setShowProfileModal(true)}
          onFeedbackClick={() => setShowFeedbackModal(true)}
        />
      )}

      {/* Desktop Navigation - Hidden on mobile screens */}
      <nav className="desktop-nav bg-surface border-b border-border sticky top-0 z-50 w-full">
        <div className="w-full px-4 lg:px-6">
          <div className="flex justify-between items-center h-12">
            <div className="flex items-center space-x-8">
              <div className="flex items-center space-x-2 cursor-pointer" onClick={() => navigate('/my-cases')}>
                <img 
                  src="https://i.ibb.co/vxP6Cs3c/logo.png" 
                  alt="VMTB" 
                  className="h-10 w-auto"
                />
                <span className="text-xxl font-semibold text-text">vMTB</span>
              </div>

              <div className="flex space-x-1">
                <button
                  onClick={() => navigate('/my-cases')}
                  data-tour="nav-my-cases"
                  className={`px-4 py-2 text-sm font-medium transition-colors relative ${
                    isActive('/my-cases')
                      ? 'text-text'
                      : 'text-text-muted hover:text-text'
                  }`}
                >
                  My Cases
                  {isActive('/my-cases') && (
                    <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary"></div>
                  )}
                </button>
                <button
                  onClick={() => navigate('/mtbs')}
                  data-tour="nav-mtbs"
                  className={`px-4 py-2 text-sm font-medium transition-colors relative ${
                    isActive('/mtbs')
                      ? 'text-text'
                      : 'text-text-muted hover:text-text'
                  }`}
                >
                  MTBs
                  {isActive('/mtbs') && (
                    <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary"></div>
                  )}
                </button>
              </div>
            </div>

            <div className="flex items-center space-x-4">
              <div className="text-sm text-text-muted">{greetingText}</div>
              
              {/* Notification Icon */}
              <div className="relative" ref={notificationRef}>
                <button
                  onClick={() => setShowNotificationDropdown(!showNotificationDropdown)}
                  className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors relative"
                >
                  <Bell className="w-5 h-5 text-text-muted" />
                </button>
                
                {showNotificationDropdown && (
                  <div className="absolute right-0 mt-2 w-80 bg-surface rounded-lg shadow-lg border border-border p-4 z-50">
                    <div className="text-center">
                      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-status-processing-bg mb-3">
                        <Bell className="w-6 h-6 text-primary" />
                      </div>
                      <h3 className="text-sm font-semibold text-text mb-2">Coming Soon!</h3>
                      <p className="text-sm text-text-muted">
                        We're working on this feature. Notifications will be available soon.
                      </p>
                    </div>
                  </div>
                )}
              </div>
              
              {/* Profile Dropdown */}
              <div className="relative" ref={dropdownRef}>
                <button
                  onClick={() => setShowDropdown(!showDropdown)}
                  className="flex items-center space-x-2 p-1 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  <Avatar avatarKey={user?.avatarKey} name={user?.name} email={user?.email} sizeClassName="w-9 h-9 text-sm font-semibold" />
                  <ChevronDown className={`w-4 h-4 transition-transform text-text-muted ${showDropdown ? 'rotate-180' : ''}`} />
                </button>

                {showDropdown && (
                  <div className="absolute right-0 mt-2 w-48 bg-surface rounded-lg shadow-lg border border-border py-1.5 z-50">
                    <button
                      onClick={() => {
                        setShowDropdown(false);
                        setShowProfileModal(true);
                      }}
                      className="flex items-center space-x-3 w-full px-4 py-2.5 text-sm text-text hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    >
                      <Settings className="w-4 h-4" />
                      <span>Profile</span>
                    </button>
                    <button
                      onClick={() => {
                        setShowDropdown(false);
                        setShowFeedbackModal(true);
                      }}
                      className="flex items-center space-x-3 w-full px-4 py-2.5 text-sm text-text hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    >
                      <MessageSquare className="w-4 h-4" />
                      <span>Feedback</span>
                    </button>
                    <button
                      onClick={() => {
                        setShowDropdown(false);
                        navigate('/my-cases?view=archived');
                      }}
                      className="flex items-center space-x-3 w-full px-4 py-2.5 text-sm text-text hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    >
                      <Archive className="w-4 h-4" />
                      <span>Archived cases</span>
                    </button>
                    <hr className="my-1.5 border-border" />
                    <div className="px-4 py-2">
                      <p className="text-xs font-medium text-text-muted mb-1.5">Theme</p>
                      <div className="flex gap-1 bg-bg rounded-lg p-1">
                        {([
                          { value: 'light' as const, label: 'Light', Icon: Sun },
                          { value: 'dark' as const, label: 'Dark', Icon: Moon },
                          { value: 'system' as const, label: 'System', Icon: Monitor },
                        ]).map(({ value, label, Icon }) => (
                          <button
                            key={value}
                            onClick={() => setTheme(value)}
                            aria-label={label}
                            title={label}
                            className={`flex-1 flex items-center justify-center py-1.5 rounded-md transition-colors ${
                              theme === value ? 'bg-surface text-text shadow-sm' : 'text-text-muted hover:text-text'
                            }`}
                          >
                            <Icon className="w-3.5 h-3.5" />
                          </button>
                        ))}
                      </div>
                    </div>
                    <hr className="my-1.5 border-border" />
                    <button
                      onClick={handleLogout}
                      className="flex items-center space-x-3 w-full px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      <span>Logout</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </nav>

      <main className={`${wide ? 'max-w-[1440px]' : 'max-w-7xl'} mx-auto px-4 sm:px-6 lg:px-8 py-6 ${isMobile ? 'mobile-main-content' : ''}`}>
        {children}
      </main>

      {/* Profile Modal */}
      <Modal
        isOpen={showProfileModal}
        onClose={() => {
          setShowProfileModal(false);
          setProfileError(null);
          resetWhatsappOtpState();
        }}
        title="Edit Profile"
      >
        <div className="space-y-4">
          {/* Profile Picture Section */}
          <div className="flex items-center space-x-4 pb-4 border-b border-border">
            <Avatar avatarKey={user?.avatarKey} name={user?.name} email={user?.email} sizeClassName="w-20 h-20 text-2xl" />
            <div className="flex-1">
              <input
                ref={photoInputRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                className="hidden"
                onChange={handlePhotoSelected}
              />
              <button
                onClick={() => photoInputRef.current?.click()}
                disabled={photoUploading}
                className="flex items-center space-x-2 px-4 py-2 border border-border rounded-lg text-sm font-medium text-text hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Upload className="w-4 h-4" />
                <span>{photoUploading ? 'Uploading...' : 'Upload Photo'}</span>
              </button>
              <p className="text-xs text-text-muted mt-1.5">JPG, PNG or GIF (max 2MB)</p>
              {photoError && <p className="text-xs text-red-600 mt-1">{photoError}</p>}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text mb-2">Email Address</label>
            <input
              type="email"
              value={user?.email || ''}
              disabled
              className="w-full px-4 py-2.5 border border-border rounded-lg bg-bg text-text-muted text-sm"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text mb-2">
                Full Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={profileName}
                onChange={(e) => {
                  setProfileName(e.target.value);
                  setProfileError(null);
                }}
                className={`w-full px-4 py-2.5 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0 text-sm transition ${
                  !profileName.trim() && profileError ? 'border-red-300' : 'border-border'
                }`}
                placeholder="Dr. John Doe"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text mb-2">
                Profession <span className="text-red-500">*</span>
              </label>
              <select
                value={profileProfession}
                onChange={(e) => {
                  setProfileProfession(e.target.value);
                  setProfileError(null);
                }}
                className={`w-full px-4 py-2.5 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0 text-sm transition ${
                  !profileProfession.trim() && profileError ? 'border-red-300' : 'border-border'
                }`}
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
              <p className="text-xs mt-1.5 text-text-muted">If not listed, please mention in feedback</p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text mb-2">
                Hospital / Institution <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={profileHospital}
                onChange={(e) => {
                  setProfileHospital(e.target.value);
                  setProfileError(null);
                }}
                className={`w-full px-4 py-2.5 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0 text-sm transition ${
                  !profileHospital.trim() && profileError ? 'border-red-300' : 'border-border'
                }`}
                placeholder="City Cancer Hospital"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text mb-2">
                WhatsApp Number <span className="text-red-500">*</span>
              </label>
              {whatsappStep === 'idle' ? (
                <>
                  <input
                    type="tel"
                    value={profileWhatsapp}
                    onChange={(e) => {
                      setProfileWhatsapp(e.target.value);
                      setProfileError(null);
                    }}
                    className={`w-full px-4 py-2.5 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0 text-sm transition ${
                      !profileWhatsapp.trim() && profileError ? 'border-red-300' : 'border-border'
                    }`}
                    placeholder="e.g., +91 98765 43210"
                  />
                  <p className="text-xs mt-1.5 text-text-muted">Include country code (e.g. +91 for India)</p>
                </>
              ) : (
                <div>
                  <p className="text-xs mb-2 text-text-muted">
                    Enter the 6-digit code sent to <span className="font-semibold text-text">{profileWhatsapp.trim()}</span>
                  </p>
                  <div className="flex gap-1.5" onPaste={handleWhatsappOtpPaste}>
                    {whatsappOtp.map((digit, index) => (
                      <input
                        key={index}
                        ref={(el) => (whatsappOtpInputsRef.current[index] = el)}
                        type="text"
                        inputMode="numeric"
                        maxLength={1}
                        value={digit}
                        onChange={(e) => handleWhatsappOtpChange(index, e.target.value)}
                        onKeyDown={(e) => handleWhatsappOtpKeyDown(index, e)}
                        className="w-9 h-10 text-center text-sm font-semibold border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0"
                      />
                    ))}
                  </div>
                  <div className="flex items-center gap-3 mt-1.5">
                    <button
                      type="button"
                      onClick={handleResendWhatsappOtp}
                      disabled={whatsappResendCooldown > 0}
                      className={`text-xs font-medium transition ${whatsappResendCooldown > 0 ? 'text-gray-400' : 'text-primary'}`}
                    >
                      {whatsappResendCooldown > 0 ? `Resend in ${whatsappResendCooldown}s` : 'Resend OTP'}
                    </button>
                    <button
                      type="button"
                      onClick={handleChangeWhatsappNumber}
                      className="text-xs font-medium transition text-primary"
                    >
                      Change number
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {(profileError || whatsappOtpError) && (
            <div className="flex items-start justify-between gap-3 text-sm text-red-600 bg-red-50 p-3 rounded-lg border border-red-200" role="alert">
              <span>{profileError || whatsappOtpError}</span>
              <DismissButton
                onClick={() => { setProfileError(null); setWhatsappOtpError(null); }}
                label="Dismiss error"
              />
            </div>
          )}

          <div className="flex justify-end space-x-3 pt-3">
            <button
              onClick={() => {
                setShowProfileModal(false);
                setProfileError(null);
                resetWhatsappOtpState();
              }}
              className="px-5 py-2.5 border border-border rounded-lg text-sm font-medium text-text hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              Cancel
            </button>
            {whatsappStep === 'otp-sent' ? (
              <button
                onClick={handleVerifyWhatsappOtp}
                disabled={whatsappOtpLoading || whatsappOtp.join('').length !== 6}
                className="px-5 py-2.5 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-primary hover:bg-primary-hover"
                              >
                {whatsappOtpLoading ? 'Verifying...' : profileSaved ? 'Saved!' : 'Verify & Save'}
              </button>
            ) : (
            <button
              onClick={handleSaveProfile}
              disabled={profileLoading || !isProfileValid}
              className="px-5 py-2.5 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-primary hover:bg-primary-hover"
                          >
              {profileLoading ? 'Saving...' : profileSaved ? 'Saved!' : 'Save Changes'}
            </button>
            )}
          </div>
        </div>
      </Modal>

      {/* Feedback Modal */}
      <Modal
        isOpen={showFeedbackModal}
        onClose={() => {
          setShowFeedbackModal(false);
          setFeedbackType('');
          setFeedbackText('');
        }}
        title="Send Feedback"
        size="large"
      >
        <div className="space-y-5">
          <p className="text-sm text-text-muted">
            We'd love to hear from you! Share your feedback, suggestions, or report any issues.
          </p>
          
          <div>
            <label className="block text-sm font-medium text-text mb-2">
              Feedback Type <span className="text-red-500">*</span>
            </label>
            <select
              value={feedbackType}
              onChange={(e) => setFeedbackType(e.target.value)}
              className="w-full px-4 py-2.5 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0 text-sm transition"
            >
              <option value="">Select feedback type</option>
              <option value="Bug Report">Bug Report</option>
              <option value="Feature Request">Feature Request</option>
              <option value="Suggestion">Suggestion</option>
              <option value="General Feedback">General Feedback</option>
              <option value="Other">Other</option>
            </select>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-text mb-2">
              Your Feedback <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <textarea
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                rows={8}
                className="w-full px-4 py-2.5 pr-10 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0 text-sm transition"
                placeholder="Please share your thoughts..."
              />
              <div className="absolute right-3 top-2.5">
                <VoiceRecorder
                  onTranscriptionComplete={(text) => setFeedbackText((prev) => (prev ? prev + ' ' + text : text))}
                  variant="inline"
                  source="feedback"
                />
              </div>
            </div>
          </div>
          
          <div className="flex justify-end space-x-3 pt-4">
            <button
              onClick={() => {
                setShowFeedbackModal(false);
                setFeedbackType('');
                setFeedbackText('');
              }}
              className="px-5 py-2.5 border border-border rounded-lg text-sm font-medium text-text hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSendFeedback}
              disabled={feedbackLoading || !feedbackText.trim() || !feedbackType}
              className="px-5 py-2.5 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-primary hover:bg-primary-hover"
                          >
              {feedbackLoading ? 'Sending...' : feedbackSent ? 'Sent!' : 'Send Feedback'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
