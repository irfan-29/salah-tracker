import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const pad = (value) => String(value).padStart(2, '0');

function toISO(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fromISO(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) return new Date();
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function displayDate(value) {
  if (!value) return 'Select date';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  }).format(fromISO(value));
}

function monthLabel(year, month) {
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' })
    .format(new Date(year, month, 1));
}

function fullDateLabel(date) {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(date);
}

// Native date inputs open the operating system's date picker. That picker
// varies by browser and cannot be themed, so the app uses its own small
// calendar. The button keeps the same field chrome as FormSelect and text
// inputs, and the calendar is a normal focusable popup.
export default function DateField({
  id,
  label,
  value,
  onChange,
  className = '',
  disabled = false,
  min,
  max,
}) {
  const generatedId = useId();
  const fieldId = id || `date-${generatedId}`;
  const labelId = `${fieldId}-label`;
  const dialogId = `${fieldId}-dialog`;
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const dialogRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState(null);
  const initialDate = fromISO(value);
  const [view, setView] = useState({
    year: initialDate.getFullYear(),
    month: initialDate.getMonth(),
  });

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutside = (event) => {
      if (!rootRef.current?.contains(event.target) && !dialogRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  // Portalled for the same reason as FormSelect: cards clip their children.
  useEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const gap = 6;
      const width = Math.min(318, window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - gap - 6;
      const above = rect.top - gap - 6;
      const openUp = below < 250 && above > below;
      const available = Math.max(150, openUp ? above : below);
      setMenuPos({
        top: openUp ? Math.max(8, rect.top - Math.min(360, available) - gap) : rect.bottom + gap,
        left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8)),
        width,
        maxHeight: Math.max(150, Math.min(380, available)),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    // Focus after the click's default action has finished. Query the document
    // rather than the portal ref so the node is the one currently painted.
    const timer = window.setTimeout(() => {
      const menu = document.getElementById(dialogId);
      const target = menu?.querySelector('[data-selected="true"], [data-today="true"]');
      target?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, view, dialogId]);

  useEffect(() => {
    if (!value) return;
    const date = fromISO(value);
    setView({ year: date.getFullYear(), month: date.getMonth() });
  }, [value]);

  const calendarDays = useMemo(() => {
    const first = new Date(view.year, view.month, 1);
    const start = first.getDay();
    const total = new Date(view.year, view.month + 1, 0).getDate();
    const cells = Array.from({ length: start }, () => null);
    for (let day = 1; day <= total; day += 1) {
      cells.push(new Date(view.year, view.month, day));
    }
    return cells;
  }, [view.year, view.month]);

  const todayISO = toISO(new Date());
  const isDisabled = (date) => {
    const iso = toISO(date);
    return Boolean((min && iso < min) || (max && iso > max));
  };

  const choose = (date) => {
    const iso = toISO(date);
    if (isDisabled(date)) return;
    onChange(iso);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const moveMonth = (step) => {
    setView((current) => {
      const next = new Date(current.year, current.month + step, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  };

  return (
    <div
      ref={rootRef}
      className={`app-field app-date${className ? ` ${className}` : ''}`}
    >
      {label && <span className="app-field-label" id={labelId}>{label}</span>}
      <button
        ref={triggerRef}
        type="button"
        id={fieldId}
        className="app-field-control app-date-trigger"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        aria-labelledby={label ? `${labelId} ${fieldId}-value` : undefined}
        aria-label={!label ? 'Select date' : undefined}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          const date = fromISO(value);
          setMenuPos(null);
          setView({ year: date.getFullYear(), month: date.getMonth() });
          setOpen(true);
        }}
      >
        <span className="app-field-value" id={`${fieldId}-value`}>{displayDate(value)}</span>
        <span className="app-field-icon material-symbols-rounded" aria-hidden="true">calendar_month</span>
      </button>

      {open && createPortal(
        <div
          ref={dialogRef}
          id={dialogId}
          className="app-date-menu is-portal"
          role="dialog"
          aria-label={label ? `${label} calendar` : 'Calendar'}
          style={{
            top: menuPos ? `${menuPos.top}px` : undefined,
            left: menuPos ? `${menuPos.left}px` : undefined,
            width: menuPos ? `${menuPos.width}px` : undefined,
            maxHeight: menuPos ? `${menuPos.maxHeight}px` : undefined,
            visibility: menuPos ? 'visible' : 'hidden',
          }}
        >
          <div className="app-date-head">
            <button type="button" className="app-date-nav" aria-label="Previous month"
                    onClick={() => moveMonth(-1)}>
              <span className="material-symbols-rounded" aria-hidden="true">chevron_left</span>
            </button>
            <strong>{monthLabel(view.year, view.month)}</strong>
            <button type="button" className="app-date-nav" aria-label="Next month"
                    onClick={() => moveMonth(1)}>
              <span className="material-symbols-rounded" aria-hidden="true">chevron_right</span>
            </button>
          </div>

          <div className="app-date-grid app-date-weekdays" aria-hidden="true">
            {WEEKDAYS.map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}
          </div>

          <div className="app-date-grid">
            {calendarDays.map((date, index) => {
              if (!date) return <span key={`blank-${index}`} />;
              const iso = toISO(date);
              const selected = iso === value;
              const today = iso === todayISO;
              const unavailable = isDisabled(date);
              return (
                <button
                  key={iso}
                  type="button"
                  className={`app-date-day${selected ? ' is-selected' : ''}${today ? ' is-today' : ''}`}
                  data-selected={selected ? 'true' : undefined}
                  data-today={today ? 'true' : undefined}
                  aria-current={today ? 'date' : undefined}
                  aria-label={fullDateLabel(date)}
                  aria-pressed={selected}
                  disabled={unavailable}
                  onClick={() => choose(date)}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>

          <div className="app-date-foot">
            <button type="button" className="app-date-today" onClick={() => choose(fromISO(todayISO))}>
              Today
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
