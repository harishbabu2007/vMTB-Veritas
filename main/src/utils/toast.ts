import toast from 'react-hot-toast';

// Colours are theme tokens (CSS variables resolve at paint time), so a toast
// follows the theme of whoever is looking at it.
const toastConfig = {
  style: {
    background: 'var(--color-surface)',
    color: 'var(--color-text)',
    padding: '16px',
    borderRadius: '8px',
    border: '1px solid var(--color-border)',
    boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)', // theme-allow: neutral shadow, reads on both themes
  },
  success: {
    duration: 3000,
    iconTheme: {
      primary: 'var(--color-success)',
      secondary: 'var(--color-surface)',
    },
  },
  error: {
    duration: 4000,
    iconTheme: {
      primary: 'var(--color-danger)',
      secondary: 'var(--color-surface)',
    },
  },
};

export const showToast = {
  success: (message: string) => {
    toast.success(message, {
      style: toastConfig.style,
      iconTheme: toastConfig.success.iconTheme,
      duration: toastConfig.success.duration,
    });
  },
  
  error: (message: string) => {
    toast.error(message, {
      style: toastConfig.style,
      iconTheme: toastConfig.error.iconTheme,
      duration: toastConfig.error.duration,
    });
  },
  
  warning: (message: string) => {
    toast(message, {
      icon: '⚠️',
      style: {
        ...toastConfig.style,
        borderColor: 'var(--color-warning-solid)',
      },
      duration: 3500,
    });
  },
  
  info: (message: string) => {
    toast(message, {
      icon: 'ℹ️',
      style: {
        ...toastConfig.style,
        borderColor: 'var(--color-info)',
      },
      duration: 3000,
    });
  },
};
