/** Another process already holds the viewer port; carries only the port number. */
export class ViewerPortInUse extends Error {
  constructor(readonly port: number) {
    super(`Viewer port ${port} is already in use`);
    this.name = "ViewerPortInUse";
  }
}

export const isAddressInUse = (error: unknown): boolean =>
  typeof error === "object" && error !== null && Reflect.get(error, "code") === "EADDRINUSE";

/**
 * Refuses a port held on 0.0.0.0 or [::]. On macOS Bun still binds 127.0.0.1 over such a
 * holder and then takes its loopback traffic, so each wildcard address is bound and released at
 * once, serving nothing. A holder on 127.0.0.1 itself makes the viewer's own bind fail.
 */
export const assertPortFree = (port: number): void => {
  if (port === 0) return;
  for (const hostname of ["0.0.0.0", "::"]) {
    let probe: { stop: (closeActiveConnections?: boolean) => void };
    try {
      probe = Bun.listen({ hostname, port, socket: { data: () => {} } });
    } catch (error) {
      if (isAddressInUse(error)) throw new ViewerPortInUse(port);
      // Another failure, such as a missing address family, is left to the real bind.
      continue;
    }
    probe.stop(true);
  }
};
