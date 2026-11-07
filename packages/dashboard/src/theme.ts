/**
 * The dashboard's theme and mode: groundwork's page theme, starting on
 * Glazing, with the app bar's theme picker in step with it. It offers
 * Glazing, then the other core themes, then the optional families, and
 * nothing to import: the only theme past those is the desktop's Omarchy
 * one, which the server passes on. The boot script shares `themeOptions`,
 * so the stored pick applies before the first paint.
 */
import {
  coreThemeChoices,
  optionalThemeChoices,
  pageTheme,
  type ThemeChoice,
  type ThemeMode,
  themeOptions as pickerOptions,
} from "@timmo001/groundwork-tokens/page";
import { on } from "@timmo001/groundwork-ui";
import type { GwThemePicker } from "@timmo001/groundwork-ui/gw-theme-picker.ts";
import { themeOptions } from "./theme-options.ts";

/** Glazing first, then the other core themes, then the optional ones by family. */
const themes: ReadonlyArray<ThemeChoice> = [
  ...coreThemeChoices.filter(({ id }) => id === themeOptions.defaultTheme),
  ...coreThemeChoices.filter(({ id }) => id !== themeOptions.defaultTheme),
  ...optionalThemeChoices,
];

const modes: ReadonlyArray<ThemeMode> = ["auto", "light", "dark", "darker"];

/** The page's theme, set up once for the whole dashboard. */
export const page = pageTheme({ ...themeOptions, themes });

/** Keep a theme picker in step with the page's theme and mode, both ways. */
export const bindTheme = (picker: GwThemePicker) => {
  const render = () => {
    const { mode, theme, only, omarchy } = page.state();

    picker.mode = mode;
    picker.theme = theme;
    picker.scheme = only ?? "";
    picker.themes = [
      ...pickerOptions(themes),
      ...(omarchy === null ? [] : pickerOptions([omarchy], "Desktop")),
    ];
  };

  page.subscribe(render);
  render();

  on(picker, "mode", (event) => {
    const mode = modes.find((entry) => entry === event.detail.mode);

    if (mode !== undefined) page.setMode(mode);
  });

  on(picker, "theme", (event) => page.setTheme(event.detail.id));

  on(picker, "reset", () => page.reset());
};
