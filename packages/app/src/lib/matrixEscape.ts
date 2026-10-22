/** Returns the exact cleanup used when MATRIX closes or unmounts. */
export function subscribeMatrixEscape(target: EventTarget, close: () => void): () => void {
  const onKeyDown = (event: Event) => {
    if (event.defaultPrevented || !("key" in event) || event.key !== "Escape") return;
    if ("isComposing" in event && event.isComposing === true) return;
    event.preventDefault();
    close();
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}
