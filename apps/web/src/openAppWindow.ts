/**
 * App-route pop-outs. The desktop shell currently denies every window.open;
 * same-origin hrefs are allowed there so this lands a real second window.
 */
export function shouldOpenInNewWindow(
  event: Pick<MouseEvent, "button" | "ctrlKey" | "metaKey">,
): boolean {
  return event.button === 1 || event.metaKey || event.ctrlKey;
}

export function openAppHrefInNewWindow(href: string): Window | null {
  return window.open(href, "_blank", "noopener,noreferrer");
}
