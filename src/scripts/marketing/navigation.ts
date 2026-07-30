const menus = Array.from(document.querySelectorAll<HTMLElement>("[data-marketing-menu]"));

for (const menu of menus) {
  const trigger = menu.querySelector<HTMLElement>("[data-marketing-menu-trigger]");
  if (trigger === null) continue;
  const closeLabel = trigger.dataset.marketingMenuCloseLabel ?? "Close menu";
  const openLabel = trigger.dataset.marketingMenuOpenLabel ?? "Open menu";

  const syncState = (): void => {
    const open = menu instanceof HTMLDetailsElement && menu.open;
    trigger.setAttribute("aria-expanded", String(open));
    trigger.setAttribute("aria-label", open ? closeLabel : openLabel);
  };

  menu.addEventListener("toggle", syncState);
  menu.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      if (menu instanceof HTMLDetailsElement) menu.open = false;
    });
  });
  trigger.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !(menu instanceof HTMLDetailsElement) || !menu.open) return;
    menu.open = false;
    trigger.focus();
  });
  syncState();
}

export {};
