import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Menu, X, LogOut, Settings, MessageSquare, Home, Users, Archive } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Avatar } from './Avatar';

interface MobileNavProps {
  onProfileClick: () => void;
  onFeedbackClick: () => void;
}

export function MobileNav({ onProfileClick, onFeedbackClick }: MobileNavProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { logout, user } = useAuth();
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  // Close menu when route changes
  useEffect(() => {
    setIsMenuOpen(false);
  }, [location.pathname]);

  // Prevent body scroll when menu is open
  useEffect(() => {
    if (isMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isMenuOpen]);

  const handleLogout = async () => {
    setIsMenuOpen(false);
    await logout();
    navigate('/login', { replace: true });
  };

  const isActive = (path: string) => location.pathname === path;

  const greetingText = (() => {
    const emailPrefix = user?.email ? user.email.split('@')[0] : '';
    const rawName = (user?.name && user.name.trim()) || emailPrefix;
    if (!rawName) return '';
    const formatted = rawName.charAt(0).toUpperCase() + rawName.slice(1);
    return `Dr ${formatted}`;
  })();

  return (
    <>
      {/* Mobile Header */}
      <nav className="mobile-nav-header bg-surface border-b border-border sticky top-0 z-50 w-full">
        <div className="flex justify-between items-center h-14 px-4">
          {/* Logo */}
          <div 
            className="flex items-center space-x-2 cursor-pointer" 
            onClick={() => navigate('/my-cases')}
          >
            <img 
              src="https://i.ibb.co/vxP6Cs3c/logo.png" 
              alt="VMTB" 
              className="h-8 w-auto"
            />
            <span className="text-lg font-semibold text-text">vMTB</span>
          </div>

          {/* Hamburger Button */}
          <button
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            data-tour="mobile-menu"
            className="p-2 rounded-md text-text-muted hover:bg-surface-muted transition-colors"
            aria-label="Toggle menu"
          >
            {isMenuOpen ? (
              <X className="w-6 h-6" />
            ) : (
              <Menu className="w-6 h-6" />
            )}
          </button>
        </div>
      </nav>

      {/* Mobile Menu Overlay */}
      {isMenuOpen && (
        <div 
          className="mobile-menu-overlay fixed inset-0 bg-overlay z-40"
          onClick={() => setIsMenuOpen(false)}
        />
      )}

      {/* Mobile Menu Drawer */}
      <div 
        className={`mobile-menu-drawer fixed top-0 right-0 h-full w-72 bg-surface z-50 transform transition-transform duration-300 ease-in-out ${
          isMenuOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Menu Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center space-x-3">
            <Avatar avatarKey={user?.avatarKey} name={user?.name} email={user?.email} sizeClassName="w-10 h-10 font-medium" />
            <div>
              <p className="font-medium text-text">{greetingText}</p>
              <p className="text-xs text-text-muted truncate max-w-[150px]">{user?.email}</p>
            </div>
          </div>
          <button
            onClick={() => setIsMenuOpen(false)}
            className="p-2 rounded-md text-text-muted hover:bg-surface-muted"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Links */}
        <div className="py-4">
          <p className="px-4 text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
            Navigation
          </p>
          <button
            onClick={() => {
              navigate('/my-cases');
              setIsMenuOpen(false);
            }}
            className={`flex items-center space-x-3 w-full px-4 py-3 text-left transition-colors ${
              isActive('/my-cases')
                ? 'bg-status-processing-bg text-status-processing-text border-r-4 border-primary'
                : 'text-text hover:bg-surface-hover'
            }`}
          >
            <Home className="w-5 h-5" />
            <span className="font-medium">My Cases</span>
          </button>
          <button
            onClick={() => {
              navigate('/mtbs');
              setIsMenuOpen(false);
            }}
            className={`flex items-center space-x-3 w-full px-4 py-3 text-left transition-colors ${
              isActive('/mtbs')
                ? 'bg-status-processing-bg text-status-processing-text border-r-4 border-primary'
                : 'text-text hover:bg-surface-hover'
            }`}
          >
            <Users className="w-5 h-5" />
            <span className="font-medium">MTBs</span>
          </button>
        </div>

        {/* Settings Section */}
        <div className="py-4 border-t border-border">
          <p className="px-4 text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
            Settings
          </p>
          <button
            onClick={() => {
              setIsMenuOpen(false);
              onProfileClick();
            }}
            className="flex items-center space-x-3 w-full px-4 py-3 text-left text-text hover:bg-surface-hover transition-colors"
          >
            <Settings className="w-5 h-5" />
            <span className="font-medium">Profile</span>
          </button>
          <button
            onClick={() => {
              setIsMenuOpen(false);
              onFeedbackClick();
            }}
            className="flex items-center space-x-3 w-full px-4 py-3 text-left text-text hover:bg-surface-hover transition-colors"
          >
            <MessageSquare className="w-5 h-5" />
            <span className="font-medium">Feedback</span>
          </button>
          <button
            onClick={() => {
              setIsMenuOpen(false);
              navigate('/my-cases?view=archived');
            }}
            className="flex items-center space-x-3 w-full px-4 py-3 text-left text-text hover:bg-surface-hover transition-colors"
          >
            <Archive className="w-5 h-5" />
            <span className="font-medium">Archived cases</span>
          </button>
        </div>

        {/* Logout Section */}
        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-border bg-surface">
          <button
            onClick={handleLogout}
            className="flex items-center justify-center space-x-2 w-full py-3 bg-danger-bg text-danger rounded-lg hover:bg-danger-bg-strong transition-colors font-medium"
          >
            <LogOut className="w-5 h-5" />
            <span>Logout</span>
          </button>
        </div>
      </div>
    </>
  );
}
