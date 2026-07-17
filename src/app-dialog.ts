export type AppDialogKind = "info" | "warning" | "danger";

export type AppDialogOptions = {
  title?: string;
  kind?: AppDialogKind;
  confirmLabel?: string;
  cancelLabel?: string;
};

let dialogQueue = Promise.resolve();

export function confirmDialog(message: string, options: AppDialogOptions = {}): Promise<boolean> {
  const result = dialogQueue.then(() => showConfirmDialog(message, options));
  dialogQueue = result.then(() => undefined, () => undefined);
  return result;
}

function showConfirmDialog(message: string, options: AppDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop app-confirm-backdrop";
    backdrop.innerHTML = `
      <div class="modal-card app-confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="app-confirm-title" aria-describedby="app-confirm-message">
        <span class="eyebrow"></span>
        <h3 id="app-confirm-title"></h3>
        <p id="app-confirm-message" class="app-confirm-message"></p>
        <div class="app-confirm-actions">
          <button type="button" class="button subtle" data-app-confirm-cancel></button>
          <button type="button" class="button primary" data-app-confirm-accept></button>
        </div>
      </div>`;

    const title = backdrop.querySelector<HTMLElement>("#app-confirm-title");
    const eyebrow = backdrop.querySelector<HTMLElement>(".eyebrow");
    const messageNode = backdrop.querySelector<HTMLElement>("#app-confirm-message");
    const cancelButton = backdrop.querySelector<HTMLButtonElement>("[data-app-confirm-cancel]");
    const acceptButton = backdrop.querySelector<HTMLButtonElement>("[data-app-confirm-accept]");
    if (!title || !eyebrow || !messageNode || !cancelButton || !acceptButton) {
      resolve(false);
      return;
    }

    title.textContent = options.title ?? "请确认";
    eyebrow.textContent = options.kind === "danger" ? "ATTENTION" : options.kind === "warning" ? "PLEASE CONFIRM" : "CONFIRM";
    messageNode.textContent = message;
    cancelButton.textContent = options.cancelLabel ?? "取消";
    acceptButton.textContent = options.confirmLabel ?? "确认";
    if (options.kind === "danger") acceptButton.classList.add("danger-confirm");

    const finish = (confirmed: boolean): void => {
      document.removeEventListener("keydown", onKeyDown, true);
      backdrop.remove();
      previousFocus?.focus();
      resolve(confirmed);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    };

    cancelButton.addEventListener("click", () => finish(false), { once: true });
    acceptButton.addEventListener("click", () => finish(true), { once: true });
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) finish(false);
    });
    document.addEventListener("keydown", onKeyDown, true);
    document.body.append(backdrop);
    acceptButton.focus();
  });
}
