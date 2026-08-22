/**
 * auth-google.ts — Google sign-in button wiring (LP3).
 *
 * The OAuth backend route is not connected yet; until it lands, activating
 * the button surfaces an honest inline notice instead of a dead link. When
 * `/api/auth/google/start` ships, replace this module with a plain
 * `location.assign()` to that route.
 */

const soonNotice = document.querySelector<HTMLElement>("[data-google-soon]");

for (const button of [...document.querySelectorAll<HTMLButtonElement>("[data-google-oauth]")]) {
  button.addEventListener("click", () => {
    if (soonNotice !== null) soonNotice.hidden = false;
    button.blur();
  });
}
