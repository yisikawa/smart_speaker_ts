import { must } from "./dom";

/**
 * ハンバーガーメニューの開閉・フォーカス・キーボード操作を担当する。
 * ドロワー内の設定・言語・マイク・診断は既存の ChatView / SettingsPanel が扱う。
 */
export class MenuDrawer {
  private readonly btnMenu = must<HTMLButtonElement>("btnMenu");
  private readonly btnClose = must<HTMLButtonElement>("btnMenuClose");
  private readonly drawer = must<HTMLElement>("menuDrawer");
  private readonly backdrop = must<HTMLElement>("menuBackdrop");
  private open = false;
  private lastFocused: HTMLElement | null = null;

  bind(): void {
    this.btnMenu.addEventListener("click", () => this.toggle());
    this.btnClose.addEventListener("click", () => this.close());
    this.backdrop.addEventListener("click", () => this.close());
    document.addEventListener("keydown", (event) => {
      if (!this.open) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
        return;
      }
      if (event.key === "Tab") {
        this.trapFocus(event);
      }
    });
  }

  close(): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    document.body.classList.remove("menu-open");
    this.drawer.classList.remove("open");
    this.backdrop.classList.remove("open");
    this.btnMenu.setAttribute("aria-expanded", "false");
    // Safari はフォーカスが body のままだと復元できないため、☰ にフォールバックする
    const target = this.lastFocused && this.lastFocused !== document.body ? this.lastFocused : this.btnMenu;
    this.lastFocused = null;
    // フォーカスがドロワー内にあると Chrome が aria-hidden の変更を無視するため、先に外へ移す
    target.focus();
    this.drawer.setAttribute("aria-hidden", "true");
  }

  private toggle(): void {
    if (this.open) {
      this.close();
    } else {
      this.show();
    }
  }

  private show(): void {
    const active = document.activeElement as HTMLElement | null;
    this.lastFocused = active && typeof active.focus === "function" ? active : null;
    this.open = true;
    document.body.classList.add("menu-open");
    this.drawer.classList.add("open");
    this.backdrop.classList.add("open");
    this.drawer.setAttribute("aria-hidden", "false");
    this.btnMenu.setAttribute("aria-expanded", "true");
    this.btnClose.focus();
  }

  private trapFocus(event: KeyboardEvent): void {
    const focusable = Array.from(
      this.drawer.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => !element.hasAttribute("disabled"));
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
