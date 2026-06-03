import "ses";

let lockedDown = false;

export function initializeSES(): void {
  if (lockedDown) return;
  lockdown({ errorTaming: "unsafe", stackFiltering: "verbose" });
  lockedDown = true;
}