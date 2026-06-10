/** Run sync immediately after a structural local change (create / rename / delete). */
export function triggerInstantSync(): void {
  void import('./SyncController').then(({ SyncController }) => {
    try {
      SyncController.getInstance().scheduleInstantSync();
    } catch {
      /* sync not initialized */
    }
  });
}
