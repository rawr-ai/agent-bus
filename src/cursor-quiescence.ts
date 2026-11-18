type Reply = { readonly status: number; readonly text: string };
type Probe = (
  command: "/bin/launchctl" | "/usr/sbin/lsof",
  args: ReadonlyArray<string>,
  capture: "stdout" | "stderr" | "both"
) => Reply;

/** The caller has already positively identified this installation's managed job and listener. */
export const cursorWriterIsStopped = (
  label: string | undefined,
  uid: number | undefined,
  port: string | undefined,
  probe: Probe
): boolean => {
  if (
    label === undefined ||
    !/^[a-zA-Z0-9_.-]+$/.test(label) ||
    uid === undefined ||
    port === undefined ||
    !/^[1-9][0-9]{0,4}$/.test(port) ||
    Number(port) > 65535
  )
    return false;
  const domain = `gui/${uid}`;
  const disabled = probe("/bin/launchctl", ["print-disabled", domain], "stdout");
  if (
    disabled.status !== 0 ||
    !disabled.text
      .split("\n")
      .some((line) => line.trim() === `${JSON.stringify(label)} => disabled`)
  ) {
    return false;
  }
  const job = probe("/bin/launchctl", ["print", `${domain}/${label}`], "stderr");
  const absent = `Could not find service ${JSON.stringify(label)} in domain for user gui: ${uid}`;
  if (job.status !== 113 || !job.text.split("\n").some((line) => line.trim() === absent))
    return false;
  const listeners = probe("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], "both");
  return listeners.status === 1 && listeners.text === "";
};
