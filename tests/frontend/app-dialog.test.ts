import { beforeEach, expect, test } from "vitest";

import { confirmDialog } from "../../src/app-dialog";

beforeEach(() => {
  document.body.innerHTML = `<button id="origin">原按钮</button>`;
});

test("确认弹窗使用 App 按钮并恢复焦点", async () => {
  const origin = document.getElementById("origin") as HTMLButtonElement;
  origin.focus();

  const result = confirmDialog("继续执行这个操作吗？", {
    title: "操作确认",
    kind: "warning",
    confirmLabel: "继续"
  });
  await Promise.resolve();

  const accept = document.querySelector<HTMLButtonElement>("[data-app-confirm-accept]");
  const cancel = document.querySelector<HTMLButtonElement>("[data-app-confirm-cancel]");
  expect(document.querySelector(".app-confirm-card")?.textContent).toContain("继续执行这个操作吗？");
  expect(accept?.classList.contains("button")).toBe(true);
  expect(accept?.classList.contains("primary")).toBe(true);
  expect(cancel?.classList.contains("button")).toBe(true);
  expect(cancel?.classList.contains("subtle")).toBe(true);
  expect(document.activeElement).toBe(accept);

  accept?.click();
  await expect(result).resolves.toBe(true);
  expect(document.querySelector(".app-confirm-backdrop")).toBeNull();
  expect(document.activeElement).toBe(origin);
});

test("点击遮罩或按 Escape 会取消弹窗", async () => {
  const backdropResult = confirmDialog("第一项");
  await Promise.resolve();
  document.querySelector<HTMLElement>(".app-confirm-backdrop")?.click();
  await expect(backdropResult).resolves.toBe(false);

  const escapeResult = confirmDialog("第二项");
  await Promise.resolve();
  const escapedToPage = { value: false };
  document.addEventListener("keydown", () => {
    escapedToPage.value = true;
  }, { once: true });
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await expect(escapeResult).resolves.toBe(false);
  expect(escapedToPage.value).toBe(false);
});
