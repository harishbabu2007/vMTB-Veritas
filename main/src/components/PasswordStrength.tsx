import { Check, X } from 'lucide-react';

export interface PasswordRulesState {
  hasMinLength: boolean;
  hasNumber: boolean;
  hasUppercase: boolean;
  isValid: boolean;
}

export function validatePasswordRules(password: string): PasswordRulesState {
  const hasMinLength = password.length >= 8;
  const hasNumber = /\d/.test(password);
  const hasUppercase = /[A-Z]/.test(password);
  return {
    hasMinLength,
    hasNumber,
    hasUppercase,
    isValid: hasMinLength && hasNumber && hasUppercase,
  };
}

interface PasswordStrengthProps {
  password: string;
  isFocused?: boolean;
}

export function PasswordStrength({ password, isFocused }: PasswordStrengthProps) {
  // Only display rules once user has focused or entered text
  if (!isFocused && !password) {
    return null;
  }

  const { hasMinLength, hasNumber, hasUppercase } = validatePasswordRules(password);

  const rules = [
    { label: 'At least 8 characters', met: hasMinLength },
    { label: 'Contains a number', met: hasNumber },
    { label: 'Contains an uppercase letter', met: hasUppercase },
  ];

  return (
    <div className="mt-2.5 p-3 bg-bg rounded-lg border border-border space-y-1.5 transition-all text-xs">
      <p className="text-text-muted font-semibold mb-1.5 text-[11px] uppercase tracking-wider">
        Password Requirements:
      </p>
      {rules.map((rule, idx) => (
        <div key={idx} className="flex items-center space-x-2">
          {rule.met ? (
            <Check className="w-3.5 h-3.5 text-success flex-shrink-0" />
          ) : (
            <X className="w-3.5 h-3.5 text-danger flex-shrink-0" />
          )}
          <span className={`text-xs font-medium ${rule.met ? 'text-success' : 'text-danger'}`}>
            {rule.label}
          </span>
        </div>
      ))}
    </div>
  );
}
