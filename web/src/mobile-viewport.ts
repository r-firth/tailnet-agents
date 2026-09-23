export function trackViewport(
  element: HTMLElement,
  viewport = window.visualViewport,
) {
  if (!viewport) return () => {};
  let baseline = Math.max(window.innerHeight, viewport.height);
  let width = window.innerWidth;
  let frame = 0;
  const update = () => {
    const editing = document.activeElement?.matches(
      'input, textarea, [contenteditable="true"]',
    );
    if (!editing || window.innerWidth !== width) {
      baseline = Math.max(window.innerHeight, viewport.height);
      width = window.innerWidth;
    }
    element.style.setProperty("--app-height", `${viewport.height}px`);
    element.style.setProperty("--viewport-top", `${viewport.offsetTop}px`);
    element.dataset.keyboard =
      editing && baseline - viewport.height > 120 ? "open" : "closed";
  };
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
  };
  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  document.addEventListener("focusin", schedule);
  document.addEventListener("focusout", schedule);
  update();
  return () => {
    cancelAnimationFrame(frame);
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    document.removeEventListener("focusin", schedule);
    document.removeEventListener("focusout", schedule);
    element.style.removeProperty("--app-height");
    element.style.removeProperty("--viewport-top");
    delete element.dataset.keyboard;
  };
}
