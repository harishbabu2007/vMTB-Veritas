import { useEffect, useState } from 'react';
import { useAvatarUrl } from '../hooks/useAvatarUrl';

interface AvatarProps {
  avatarKey?: string | null;
  name?: string | null;
  email?: string | null;
  /** Tailwind size + text classes, e.g. "w-9 h-9 text-sm" */
  sizeClassName: string;
  className?: string;
}

export function Avatar({ avatarKey, name, email, sizeClassName, className = '' }: AvatarProps) {
  const { url, retry } = useAvatarUrl(avatarKey);
  const [hasRetried, setHasRetried] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const initial = name?.charAt(0).toUpperCase() || email?.charAt(0).toUpperCase() || 'U';

  // A new key (upload, or a different user) deserves a fresh attempt.
  useEffect(() => {
    setHasRetried(false);
    setImgFailed(false);
  }, [avatarKey]);

  const handleError = () => {
    if (!hasRetried) {
      setHasRetried(true);
      retry();
    } else {
      // Retried once and still failing (e.g. the object no longer exists) —
      // stop trying so a broken-image glyph never lingers on screen.
      setImgFailed(true);
    }
  };

  if (url && !imgFailed) {
    return (
      <img
        src={url}
        alt="Profile"
        onError={handleError}
        className={`rounded-full object-cover ${sizeClassName} ${className}`}
      />
    );
  }

  return (
    <div
      className={`rounded-full flex items-center justify-center text-on-solid font-bold bg-primary-solid ${sizeClassName} ${className}`}
    >
      {initial}
    </div>
  );
}
