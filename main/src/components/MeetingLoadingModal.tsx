import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Video, Loader2, Clock } from 'lucide-react';

interface MeetingLoadingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function MeetingLoadingModal({ isOpen, onClose }: MeetingLoadingModalProps) {
  const [dots, setDots] = useState('');
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isOpen) {
      setElapsed(0);
      return;
    }
    
    // Animated dots
    const dotsInterval = setInterval(() => {
      setDots(prev => prev.length >= 3 ? '' : prev + '.');
    }, 500);

    // Elapsed time counter
    const startTime = Date.now();
    const timeInterval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    return () => {
      clearInterval(dotsInterval);
      clearInterval(timeInterval);
    };
  }, [isOpen]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="">
      <div className="flex flex-col items-center justify-center py-8 px-4">
        {/* Animated Icon */}
        <div className="relative mb-6">
          <div className="absolute inset-0 bg-success-bg-strong rounded-full animate-ping opacity-75"></div>
          <div className="relative bg-success-solid p-6 rounded-full">
            <Video className="w-12 h-12 text-on-solid" />
          </div>
        </div>

        {/* Heading */}
        <h3 className="text-2xl font-semibold text-text mb-3 text-center">
          Starting Meeting Server
        </h3>

        {/* Status Message */}
        <div className="flex items-center space-x-3 mb-6">
          <Loader2 className="w-6 h-6 text-success animate-spin" />
          <span className="text-text font-medium">
            Please wait{dots}
          </span>
        </div>

        {/* Elapsed Time */}
        <div className="flex items-center space-x-2 mb-6 text-sm text-text-muted">
          <Clock className="w-4 h-4" />
          <span>{elapsed} seconds elapsed</span>
        </div>

        {/* Status Messages */}
        <div className="bg-info-bg border border-info-border rounded-lg p-4 max-w-md w-full">
          <ul className="space-y-2 text-sm text-text-muted">
            <li className="flex items-start">
              <span className="text-info mr-2">•</span>
              <span>Initializing secure video server</span>
            </li>
            <li className="flex items-start">
              <span className="text-info mr-2">•</span>
              <span>This typically takes 30–60 seconds</span>
            </li>
            <li className="flex items-start">
              <span className="text-info mr-2">•</span>
              <span>You'll be redirected automatically when ready</span>
            </li>
          </ul>
        </div>

        {/* Additional Info */}
        <p className="text-sm text-text-muted mt-6 text-center max-w-md">
          <span className="font-medium">Please do not close or refresh this page.</span>
          <br />
          The meeting will open automatically when the server is ready.
        </p>
      </div>
    </Modal>
  );
}
