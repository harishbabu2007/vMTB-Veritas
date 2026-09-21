import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import {
  CANCER_TYPES,
  CancerType,
  cancerTypeLabel,
  findCancerTypeByName,
  searchCancerTypes,
} from '../data/cancerTypes';
import { useIsMobile } from '../hooks/useMobile';

// Picks one of the 418 cancer types (see src/data/cancerTypes.ts). Type to
// search by name, abbreviation or body region; the list is grouped by region
// and every row shows its abbreviation, because that's what the case name is
// built from.

interface Props {
  value: string;
  onChange: (type: CancerType | null) => void;
  id?: string;
  disabled?: boolean;
  required?: boolean;
}

interface Row {
  kind: 'category' | 'option';
  category: string;
  type?: CancerType;
}

// With no query the list is the full one, grouped by body region. Search
// results are ranked across regions instead, so they stay in best-match
// order and each row names its own region.
const toRows = (types: CancerType[], grouped: boolean): Row[] => {
  if (!grouped) return types.map(type => ({ kind: 'option' as const, category: type.category, type }));
  const rows: Row[] = [];
  let current = '';
  for (const type of types) {
    if (type.category !== current) {
      current = type.category;
      rows.push({ kind: 'category', category: current });
    }
    rows.push({ kind: 'option', category: type.category, type });
  }
  return rows;
};

export function CancerTypeSelect({ value, onChange, id, disabled, required }: Props) {
  const isMobile = useIsMobile();
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const listId = `${generatedId}-list`;
  const selected = useMemo(() => findCancerTypeByName(value) ?? null, [value]);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Focus goes back to the field after choosing; that must not reopen the list.
  const keepClosedRef = useRef(false);

  const searching = query.trim().length > 0;
  const matches = useMemo(() => (open ? searchCancerTypes(query) : []), [open, query]);
  const rows = useMemo(() => toRows(matches, !searching), [matches, searching]);
  const optionIndexes = useMemo(
    () => rows.map((row, i) => (row.kind === 'option' ? i : -1)).filter(i => i !== -1),
    [rows]
  );

  // Opening lands on the chosen type, or the first match.
  useEffect(() => {
    if (!open) return;
    const chosen = rows.findIndex(row => row.type && selected && row.type.id === selected.id);
    setActiveIndex(chosen !== -1 ? chosen : optionIndexes[0] ?? -1);
  }, [open, rows, optionIndexes, selected]);

  // Typing moves back to the top of the results.
  useEffect(() => {
    if (open) setActiveIndex(optionIndexes[0] ?? -1);
  }, [query, open, optionIndexes]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapperRef.current?.contains(e.target as Node)) return;
      // Closing without choosing drops the half-typed search, so what the
      // field shows is always the chosen type.
      setOpen(false);
      setQuery('');
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    listRef.current?.querySelector(`[data-row="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const step = (direction: 1 | -1) => {
    if (optionIndexes.length === 0) return;
    const position = optionIndexes.indexOf(activeIndex);
    const next = position === -1
      ? optionIndexes[direction === 1 ? 0 : optionIndexes.length - 1]
      : optionIndexes[(position + direction + optionIndexes.length) % optionIndexes.length];
    setActiveIndex(next);
  };

  const choose = (type: CancerType) => {
    onChange(type);
    setQuery('');
    setOpen(false);
    keepClosedRef.current = true;
    inputRef.current?.focus();
  };

  const clear = () => {
    onChange(null);
    setQuery('');
    setOpen(true);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) setOpen(true);
      else step(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      if (!open) return;
      e.preventDefault();
      const row = rows[activeIndex];
      if (row?.type) choose(row.type);
    } else if (e.key === 'Escape') {
      if (!open) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setQuery('');
    } else if (e.key === 'Home' || e.key === 'End') {
      if (!open || optionIndexes.length === 0) return;
      e.preventDefault();
      setActiveIndex(e.key === 'Home' ? optionIndexes[0] : optionIndexes[optionIndexes.length - 1]);
    } else if (e.key === 'Tab') {
      setOpen(false);
      setQuery('');
    }
  };

  const text = open ? query : selected ? cancerTypeLabel(selected) : '';
  const activeRow = rows[activeIndex];

  return (
    <div ref={wrapperRef} className="relative">
      <div className="relative">
        <Search
          className={`w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none ${open ? 'text-primary' : 'text-text-muted'}`}
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && activeRow?.type ? `${listId}-${activeRow.type.id}` : undefined}
          autoComplete="off"
          disabled={disabled}
          // The form's own "required" check: a case can't be created without a
          // type, and only a type from the list can be chosen.
          required={required && !selected}
          value={text}
          placeholder="Search 418 cancer types, or an abbreviation"
          onChange={e => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => {
            if (keepClosedRef.current) keepClosedRef.current = false;
            else setOpen(true);
          }}
          onClick={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className={`w-full pl-9 border border-border rounded-lg bg-surface text-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-shadow ${
            selected && !open ? 'pr-16' : 'pr-9'
          } ${isMobile ? 'py-2.5 text-base' : 'py-2'}`}
          style={{ fontSize: isMobile ? '16px' : undefined }}
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
          {selected && !open && (
            <button
              type="button"
              onClick={clear}
              disabled={disabled}
              aria-label="Clear cancer type"
              title="Clear"
              className="w-7 h-7 flex items-center justify-center rounded-md text-text-muted hover:text-text hover:bg-bg transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            disabled={disabled}
            onClick={() => {
              setOpen(o => !o);
              inputRef.current?.focus();
            }}
            className="w-7 h-7 flex items-center justify-center rounded-md text-text-muted hover:text-text transition-colors"
          >
            <ChevronDown className={`w-4 h-4 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>

      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-border bg-surface shadow-xl overflow-hidden">
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Cancer types"
            className={`overflow-y-auto overscroll-contain py-1 ${isMobile ? 'max-h-64' : 'max-h-80'}`}
          >
            {rows.length === 0 ? (
              <li className="px-3 py-6 text-center">
                <p className="text-sm text-text">No cancer type matches “{query.trim()}”.</p>
                <p className="text-xs text-text-muted mt-1">
                  Try an abbreviation or a body region, or pick “Other Cancer Type (Not Listed)”.
                </p>
              </li>
            ) : (
              rows.map((row, i) =>
                row.kind === 'category' ? (
                  <li
                    key={`category-${i}`}
                    data-row={i}
                    role="presentation"
                    className="sticky top-0 z-10 bg-bg px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted border-y border-border"
                  >
                    {row.category}
                  </li>
                ) : (
                  <li key={row.type!.id} data-row={i} role="none">
                    <button
                      type="button"
                      id={`${listId}-${row.type!.id}`}
                      role="option"
                      aria-selected={selected?.id === row.type!.id}
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => choose(row.type!)}
                      className={`w-full flex items-center gap-3 px-3 text-left transition-colors ${
                        isMobile ? 'min-h-[44px] py-2' : 'py-2'
                      } ${activeIndex === i ? 'bg-status-processing-bg' : ''}`}
                    >
                      <Check
                        className={`w-4 h-4 flex-shrink-0 text-primary ${selected?.id === row.type!.id ? '' : 'opacity-0'}`}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-text truncate">{row.type!.name}</span>
                        <span className="block text-xs text-text-muted truncate">
                          {searching ? [row.type!.category, row.type!.notes].filter(Boolean).join(' · ') : row.type!.notes}
                        </span>
                      </span>
                      <span className="flex-shrink-0 px-2 py-0.5 rounded text-xs font-semibold font-mono bg-bg text-text-muted border border-border">
                        {row.type!.abbreviation}
                      </span>
                    </button>
                  </li>
                )
              )
            )}
          </ul>
          <p className="border-t border-border bg-bg px-3 py-1.5 text-[11px] text-text-muted">
            {query.trim()
              ? `${matches.length} of ${CANCER_TYPES.length} types`
              : `${CANCER_TYPES.length} types · type to search`}
          </p>
        </div>
      )}
    </div>
  );
}
