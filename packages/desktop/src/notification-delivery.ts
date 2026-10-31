/** OS acknowledgement is diagnostic only; it never proves a human saw a toast. */
export type NotificationDeliveryStatus = 'unsupported' | 'accepted' | 'failed';
interface NativeNotification { once(event: 'show' | 'failed', listener: () => void): unknown; show(): void; }
export interface NativeNotificationDeps {
  isSupported(): boolean;
  create(options: {title:string;body:string}): NativeNotification;
  notificationsEnabled(): boolean;
  isQuitting(): boolean;
  diagnostic(status: NotificationDeliveryStatus): void;
}
export function createNativeNotificationDelivery(deps: NativeNotificationDeps) {
  let lastStatus: NotificationDeliveryStatus | undefined;
  const record = (status: NotificationDeliveryStatus) => {
    if (lastStatus === status) return;
    lastStatus = status;
    // No titles, bodies, paths or OS error strings are persisted.
    try { deps.diagnostic(status); } catch { /* Diagnosis must not break delivery. */ }
  };
  return {notify(title:string,body:string):void {
    if (deps.isQuitting() || !deps.notificationsEnabled()) return;
    let supported=false;
    try { supported=deps.isSupported(); } catch { /* Capability unavailable. */ }
    if(!supported){record('unsupported');return;}
    try {
      const notification=deps.create({title,body});
      notification.once('failed',()=>record('failed'));
      notification.once('show',()=>record('accepted'));
      notification.show();
    } catch { record('failed'); }
  }};
}
