/**
 * The dashboard's light and dark mode: groundwork's page theme, kept to
 * Glazing, with the app bar's mode picker in step with it. Only the mode can
 * change, from the same four choices and icons as groundwork's theme picker
 * (auto, light, dark and darker); the theme stays Glazing. The boot script
 * shares `themeOptions`, so the stored mode applies before the first paint.
 */
import {
  mdiMoonWaningCrescent,
  mdiThemeLightDark,
  mdiWeatherNight,
  mdiWhiteBalanceSunny,
} from "@mdi/js";
import {
  coreThemeChoices,
  pageTheme,
  type ThemeMode,
} from "@timmo001/groundwork-tokens/page";
import { on } from "@timmo001/groundwork-ui";
import type { GwSegmented } from "@timmo001/groundwork-ui/gw-segmented.ts";
import { themeOptions } from "./theme-options.ts";

/** The modes, as groundwork's theme picker offers them. */
export const modeOptions = [
  { value: "auto", label: "Auto", icon: mdiThemeLightDark },
  { value: "light", label: "Light", icon: mdiWhiteBalanceSunny },
  { value: "dark", label: "Dark", icon: mdiMoonWaningCrescent },
  { value: "darker", label: "Darker", icon: mdiWeatherNight },
] as const;

const modes: ReadonlyArray<ThemeMode> = ["auto", "light", "dark", "darker"];

/** Keep a mode picker in step with the page's mode, both ways. */
export const bindModes = (picker: GwSegmented) => {
  const page = pageTheme({
    ...themeOptions,
    themes: coreThemeChoices.filter(
      (choice) => choice.id === themeOptions.defaultTheme,
    ),
  });

  const render = () => {
    picker.value = page.state().mode;
  };

  page.subscribe(render);
  render();

  on(picker, "change", () => {
    const mode = modes.find((entry) => entry === picker.value);

    if (mode !== undefined) page.setMode(mode);
  });
};
