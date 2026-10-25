import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// App-wide select. Native <select> popups are drawn by the browser and cannot
// be themed, so the closed state and the menu are both ours. The trigger keeps
// a normal button/keyboard contract; the menu is a listbox driven from that
// button, which avoids moving focus into a popup that browsers may clip.
export default function FormSelect({
  id,
  label,
  ariaLabel,
  value,
  options = [],
  onChange,
  disabled = false,
  compact = false,
  className = '',
  placeholder = 'Choose…',
}) {
  const generatedId = useId();
  const fieldId = id || `select-${generatedId}`;
  const labelId = `${fieldId}-label`;
  const menuId = `${fieldId}-menu`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [menuPos, setMenuPos] = useState(null);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  const selectedIndex = options.findIndex((option) => String(option.value) === String(value));
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutside = (event) => {
      if (!rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOnOutside);
    return () => document.removeEventListener('pointerdown', closeOnOutside);
  }, [open]);

  // The menu is portalled to <body>: cards use overflow:hidden/backdrop-filter,
  // which would otherwise clip the popup or trap it below later cards.
  useEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, compact ? 168 : 0), window.innerWidth - 16);
      const gap = 6;
      const below = window.innerHeight - rect.bottom - gap - 6;
      const above = rect.top - gap - 6;
      const openUp = below < 180 && above > below;
      const available = Math.max(120, openUp ? above : below);
      setMenuPos({
        top: openUp ? Math.max(8, rect.top - Math.min(270, available) - gap) : rect.bottom + gap,
        left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8)),
        width,
        maxHeight: Math.max(120, Math.min(270, available)),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, compact]);

  useEffect(() => {
    if (!open || active < 0) return;
    const option = menuRef.current?.children[active];
    option?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const openMenu = () => {
    if (disabled) return;
    setMenuPos(null);
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  };

  const choose = (option) => {
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const move = (step) => {
    if (!options.length) return;
    setOpen(true);
    setActive((current) => {
      const start = current >= 0 ? current : (selectedIndex >= 0 ? selectedIndex : 0);
      return (start + step + options.length) % options.length;
    });
  };

  const onKeyDown = (event) => {
    if (disabled) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (open) move(1);
      else openMenu();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (open) move(-1);
      else openMenu();
    } else if (event.key === 'Home' && open) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End' && open) {
      event.preventDefault();
      setActive(options.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open && active >= 0) choose(options[active]);
      else openMenu();
    } else if (event.key === 'Escape') {
      setOpen(false);
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className={`app-field app-select${compact ? ' app-field--compact' : ''}${className ? ` ${className}` : ''}`}
    >
      {label && <span className="app-field-label" id={labelId}>{label}</span>}
      <button
        ref={triggerRef}
        type="button"
        id={fieldId}
        className="app-field-control app-select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-labelledby={label ? `${labelId} ${fieldId}-value` : undefined}
        aria-label={!label ? (ariaLabel || placeholder) : undefined}
        aria-activedescendant={open && active >= 0 ? `${fieldId}-option-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="app-field-value" id={`${fieldId}-value`}>{selected ? selected.label : placeholder}</span>
        <span className="app-field-icon material-symbols-rounded" aria-hidden="true">expand_more</span>
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          className="app-select-menu is-portal"
          id={menuId}
          role="listbox"
          aria-labelledby={label ? labelId : undefined}
          style={{
            top: menuPos ? `${menuPos.top}px` : undefined,
            left: menuPos ? `${menuPos.left}px` : undefined,
            width: menuPos ? `${menuPos.width}px` : undefined,
            maxHeight: menuPos ? `${menuPos.maxHeight}px` : undefined,
            visibility: menuPos ? 'visible' : 'hidden',
          }}
        >
          {options.map((option, index) => {
            const isSelected = String(option.value) === String(value);
            return (
              <div
                key={option.value}
                id={`${fieldId}-option-${index}`}
                role="option"
                aria-selected={isSelected}
                className={`app-select-option${index === active ? ' is-active' : ''}${isSelected ? ' is-selected' : ''}`}
                onPointerEnter={() => setActive(index)}
                onClick={() => choose(option)}
              >
                <span>{option.label}</span>
                {isSelected && <span className="material-symbols-rounded" aria-hidden="true">check</span>}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
