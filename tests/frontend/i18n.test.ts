import { afterEach, expect, test } from "vitest";

import { resolveSystemLanguage, setResolvedLanguage, t } from "../../src/i18n";
import { mt } from "../../src/i18n-marketplace";

afterEach(() => setResolvedLanguage("zh-CN"));

test("系统语言只将 zh 系列解析为简体中文", () => {
  expect(resolveSystemLanguage("zh-Hans-CN")).toBe("zh-CN");
  expect(resolveSystemLanguage("zh-TW")).toBe("zh-CN");
  expect(resolveSystemLanguage("en-US")).toBe("en");
  expect(resolveSystemLanguage("ja-JP")).toBe("en");
});

test("主界面与主题广场共享当前语言和参数插值", () => {
  setResolvedLanguage("en");
  expect(t("themeInstalled", { name: "Aurora" })).toBe('Installed "Aurora"');
  expect(mt("pagination", { total: 21, page: 2, pages: 3 })).toBe("21 themes · Page 2 of 3");
  expect(document.documentElement.lang).toBe("en");

  setResolvedLanguage("zh-CN");
  expect(t("themeInstalled", { name: "极光" })).toBe("已安装“极光”");
});
