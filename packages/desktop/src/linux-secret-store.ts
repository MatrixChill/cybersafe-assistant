/** Nigor is a custom desktop, not one of Chromium's recognised DE names.
 * Select the real Secret Service backend before app.ready. This does not
 * install, unlock or start a keyring, and never selects basic_text. */
export function configureLinuxSecretStore(
  app: { commandLine: { hasSwitch(name: string): boolean; appendSwitch(name: string, value: string): void } },
  options = { platform: process.platform as string, desktop: process.env.XDG_CURRENT_DESKTOP ?? process.env.DESKTOP_SESSION ?? "" },
) {
  if (options.platform === "linux" && /(^|[:;\s/-])nigor(?:[-_ ]?os)?($|[:;\s/-])/i.test(options.desktop)
    && !app.commandLine.hasSwitch("password-store")) {
    app.commandLine.appendSwitch("password-store", "gnome-libsecret");
  }
}
