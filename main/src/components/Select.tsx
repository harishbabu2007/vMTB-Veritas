import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Lock } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder: string;
  disabled?: boolean;
  required?: boolean;
  'aria-describedby'?: string;
}

// A custom-styled single-select that matches the app's card/input design
// language in both its closed and open states (a native <select>'s open
// option list is OS-rendered and can't be restyled). Implements the WAI-ARIA
// "collapsible listbox" pattern: a button with role="combobox" driving a
// role="listbox" popup via aria-activedescendant, so focus stays on the
// button throughout -- full arrow-key/Home/End/typeahead navigation and a
// visible focus ring, the same keyboard/screen-reader contract a native
// <select> gives for free.
export function Select({
  id,
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  required = false,
  'aria-describedby': describedBy,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = `${id}-listbox`;

  const selectedOption = options.find((o) => o.value === value);
  const firstEnabledIndex = options.findIndex((o) => !o.disabled);
  const lastEnabledIndex = (() => {
    for (let i = options.length - 1; i >= 0; i--) {
      if (!options[i].disabled) return i;
    }
    return -1;
  })();

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    listRef.current?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const openList = (initialIndex?: number) => {
    setOpen(true);
    const currentIndex = options.findIndex((o) => o.value === value);
    setActiveIndex(initialIndex ?? (currentIndex >= 0 ? currentIndex : firstEnabledIndex));
  };

  const commitSelection = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    buttonRef.current?.focus();
  };

  const moveActive = (delta: number) => {
    setActiveIndex((prev) => {
      const start = prev < 0 ? (delta > 0 ? -1 : 0) : prev;
      let next = start;
      for (let i = 0; i < options.length; i++) {
        next = (next + delta + options.length) % options.length;
        if (!options[next].disabled) return next;
      }
      return prev;
    });
  };

  const jumpToTypeahead = (key: string) => {
    const lower = key.toLowerCase();
    const startAt = (activeIndex + 1) % options.length;
    for (let i = 0; i < options.length; i++) {
      const idx = (startAt + i) % options.length;
      const option = options[idx];
      if (!option.disabled && option.label.toLowerCase().startsWith(lower)) return idx;
    }
    return -1;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) openList();
        else moveActive(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) openList();
        else moveActive(-1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (!open) openList();
        else commitSelection(activeIndex);
        break;
      case 'Escape':
        if (open) {
          e.preventDefault();
          setOpen(false);
        }
        break;
      case 'Home':
        if (open && firstEnabledIndex >= 0) {
          e.preventDefault();
          setActiveIndex(firstEnabledIndex);
        }
        break;
      case 'End':
        if (open && lastEnabledIndex >= 0) {
          e.preventDefault();
          setActiveIndex(lastEnabledIndex);
        }
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        if (e.key.length === 1 && /\S/.test(e.key)) {
          const idx = jumpToTypeahead(e.key);
          if (idx >= 0) {
            if (!open) openList(idx);
            else setActiveIndex(idx);
          }
        }
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
        aria-describedby={describedBy}
        aria-required={required}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={handleKeyDown}
        className={`w-full flex items-center justify-between gap-2 px-4 py-2.5 border rounded-lg text-sm text-left transition focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-0 ${
          disabled
            ? 'bg-surface-muted border-border text-text-muted cursor-not-allowed'
            : 'bg-surface border-border hover:border-border-strong'
        }`}
      >
        <span className={selectedOption ? 'text-text' : 'text-text-subtle'}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        {disabled ? (
          // A lock, not just a dimmed chevron -- reads as "fixed by
          // something else," not "temporarily unavailable."
          <Lock className="w-4 h-4 flex-shrink-0 text-text-muted" />
        ) : (
          <ChevronDown className={`w-4 h-4 flex-shrink-0 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
        )}
      </button>

      {open && !disabled && (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={placeholder}
          tabIndex={-1}
          className="absolute z-20 mt-1 w-full max-h-64 overflow-auto rounded-lg border border-border bg-surface shadow-lg py-1"
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${listboxId}-option-${index}`}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              data-index={index}
              onMouseEnter={() => !option.disabled && setActiveIndex(index)}
              onClick={() => commitSelection(index)}
              className={`flex items-center justify-between gap-2 px-4 py-2 text-sm ${
                option.disabled
                  ? 'text-text-faint cursor-not-allowed'
                  : `cursor-pointer text-text ${index === activeIndex ? 'bg-surface-hover' : ''}`
              }`}
            >
              <span>{option.label}</span>
              {option.value === value && <Check className="w-4 h-4 flex-shrink-0 text-primary" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
