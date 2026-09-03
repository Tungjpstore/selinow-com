import { bindToastRegion } from "../lib/toast";

/**
 * Console toast boot (EX0): binds the shell's ToastRegion controller so any
 * bundled script (starting with the shared mutate() scheme) can push
 * localized feedback without wiring per page.
 */
bindToastRegion();
