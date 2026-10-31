import { useEffect, useRef, useState, useId } from "react";
/**
 * Selector de tema V2 — a peça do `topbar` do laboratório que precisa de saber
 * os oito nomes. Vive separado do `App.tsx` de propósito: o root da app não deve
 * importar dados de identidade, e há harness que correm `AuthenticatedApp` num
 * contexto com o mapa de módulos falseado, onde uma importação de dados rebentava
 * o render por completo (foi o que aconteceu em D2a com `V2_THEME_META`).
 *
 * Lê e escreve o mesmo eixo do `AppearanceContext` — não há segundo estado de
 * tema nem espelho local.
 */
import { useAppearance } from "../contexts/AppearanceContext";
import { V2_THEME_META, V2_THEME_ORDER } from "./theme";

export function ThemeMenu() {
  const { prefs, setTheme } = useAppearance();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const labelId = useId();

  // Fecha o dropdown ao clicar fora ou ao perder foco
  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Tab") { setIsOpen(false); return; }
    if (event.key === "Escape") {
      setIsOpen(false);
      event.preventDefault();
      return;
    }

    if (!isOpen && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ")) {
      setIsOpen(true);
      event.preventDefault();
      return;
    }

    if (isOpen) {
      const currentIndex = V2_THEME_ORDER.indexOf(prefs.theme);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        const nextIndex = (currentIndex + 1) % V2_THEME_ORDER.length;
        setTheme(V2_THEME_ORDER[nextIndex]);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        const prevIndex = (currentIndex - 1 + V2_THEME_ORDER.length) % V2_THEME_ORDER.length;
        setTheme(V2_THEME_ORDER[prevIndex]);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setIsOpen(false);
      }
    }
  };

  const currentTheme = prefs.theme;
  const currentMeta = V2_THEME_META[currentTheme];

  return (
    <div className="theme-select" ref={containerRef} onKeyDown={handleKeyDown}>
      <span className="sr-only" id={labelId}>
        Tema visual
      </span>
      <button
        type="button"
        className="theme-select-trigger"
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-activedescendant={isOpen ? `${listboxId}-${currentTheme}` : undefined}
        aria-expanded={isOpen}
        aria-labelledby={labelId}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <span className={`theme-dot ${currentTheme}`} aria-hidden="true" />
        <span className="theme-select-label">{currentMeta.name}</span>
        <svg
          className={`theme-select-caret ${isOpen ? "open" : ""}`}
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 4.5L6 7.5L9 4.5" />
        </svg>
      </button>

      {isOpen && (
        <div
          id={listboxId}
          className="theme-select-dropdown"
          role="listbox"
          aria-labelledby={labelId}
          tabIndex={-1}
        >
          {V2_THEME_ORDER.map((tema) => {
            const isSelected = tema === currentTheme;
            return (
              <button
                key={tema}
                id={`${listboxId}-${tema}`}
                tabIndex={-1}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`theme-select-option ${isSelected ? "selected" : ""}`}
                onClick={() => {
                  setTheme(tema);
                  setIsOpen(false);
                }}
              >
                <span className={`theme-dot ${tema}`} aria-hidden="true" />
                <span className="theme-select-option-text">
                  <span className="theme-select-option-name">{V2_THEME_META[tema].name}</span>
                </span>
                {isSelected && (
                  <svg
                    className="theme-select-check"
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M2.5 6L5 8.5L9.5 3.5" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
