import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { HeaderTarget } from '@/core/types';
import { newId } from '@/core/id';
import { suggestHeaderNames } from './header-names';

export function HeaderNamePicker({
  value,
  target,
  invalid,
  onChange,
}: {
  value: string;
  target: HeaderTarget;
  invalid: boolean;
  onChange: (name: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const listId = useMemo(() => `header-names-${newId()}`, []);
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [active, setActive] = useState(0);
  const [above, setAbove] = useState(false);
  const [menuHeight, setMenuHeight] = useState(240);
  const suggestions = suggestHeaderNames(target, showAll ? '' : value);

  const openMenu = (all: boolean, query = value) => {
    const field = input.current?.getBoundingClientRect();
    const popup = root.current?.closest('.popup')?.getBoundingClientRect();
    if (field) {
      const top = popup?.top ?? 0;
      const bottom = popup?.bottom ?? window.innerHeight;
      const below = bottom - field.bottom - 8;
      const aboveSpace = field.top - top - 8;
      const desired = Math.min(240, suggestHeaderNames(target, all ? '' : query).length * 32 + 8);
      const openAbove = below < desired && aboveSpace > below;
      setAbove(openAbove);
      setMenuHeight(Math.max(40, Math.min(240, openAbove ? aboveSpace : below)));
    }
    setShowAll(all);
    setActive(0);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('focusin', closeOutside);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('focusin', closeOutside);
    };
  }, [open]);

  useEffect(() => {
    const panel = menu.current;
    const option = panel?.children[active] as HTMLElement | undefined;
    if (!open || !panel || !option) return;
    if (option.offsetTop < panel.scrollTop) panel.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > panel.scrollTop + panel.clientHeight)
      panel.scrollTop = option.offsetTop + option.offsetHeight - panel.clientHeight;
  }, [active, open, value, target, showAll]);

  const select = (name: string) => {
    onChange(name);
    setOpen(false);
    setShowAll(false);
    input.current?.focus();
  };

  return (
    <div class="header-name-picker" ref={root}>
      <input
        ref={input}
        type="text"
        aria-label="Header name"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && suggestions.length ? `${listId}-${active}` : undefined}
        placeholder="Header name"
        value={value}
        class={invalid ? 'invalid' : ''}
        onFocus={() => openMenu(!value)}
        onInput={(event) => {
          const next = (event.target as HTMLInputElement).value;
          onChange(next);
          openMenu(false, next);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            setOpen(false);
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) {
              openMenu(false);
            } else if (suggestions.length) {
              setActive(
                (index) =>
                  (index + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) %
                  suggestions.length,
              );
            }
          } else if (event.key === 'Enter' && open && suggestions[active]) {
            event.preventDefault();
            select(suggestions[active]);
          }
        }}
      />
      <button
        type="button"
        class="header-name-toggle"
        aria-label="Show popular header names"
        title="Show popular header names"
        onClick={() => {
          input.current?.focus();
          openMenu(true);
        }}
      >
        ▾
      </button>
      {open && (
        <div
          ref={menu}
          class={`header-name-menu${above ? ' above' : ''}`}
          id={listId}
          role="listbox"
          aria-label="Header names"
          style={{ maxHeight: menuHeight }}
        >
          {suggestions.length ? (
            suggestions.map((name, index) => (
              <div
                key={name}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                class={`header-name-option${index === active ? ' active' : ''}`}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => select(name)}
              >
                {name}
              </div>
            ))
          ) : (
            <div class="header-name-empty">No match. Custom names are welcome.</div>
          )}
        </div>
      )}
    </div>
  );
}
