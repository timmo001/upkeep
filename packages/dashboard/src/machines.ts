/**
 * Which machine an agent launches on, and the button that does it. The
 * first choice is the machine the dashboard is open on, when the server can
 * tell, then the one picked last in this browser, then where the agent ran.
 * The button launches there, with the other machines that are up in a menu
 * beside it, so the usual case is one press.
 */
import type { MenuItem } from "@timmo001/groundwork-ui/gw-menu-button.ts";
import { AsyncResult } from "effect/reactivity";
import { html } from "lit";
import { phCaretDown } from "./icons.ts";
import { chosen } from "./ui.ts";
import "@timmo001/groundwork-ui/define/gw-button.ts";
import "@timmo001/groundwork-ui/define/gw-control-group.ts";
import "@timmo001/groundwork-ui/define/gw-menu-button.ts";

/** How recently a worker must have asked for work to count as up. */
export const upFor = 10 * 60_000;

/** Where the machine picked last in this browser is kept. */
const pickedKey = "upkeep.worker";

/** Where the Attention page kept it, before every page shared one. */
const legacyKey = "upkeep.attention.worker";

/** A worker as the pages list them: what it can do, and when it last asked. */
interface Worker {
  readonly worker: string;
  readonly launch?: boolean;
  readonly resume?: boolean;
  readonly at: number;
}

/**
 * The workers up now that can `launch` an agent or `resume` a session, by
 * name.
 */
export const machinesFor = (
  workers: ReadonlyArray<Worker>,
  can: "launch" | "resume",
  now = Date.now(),
) =>
  workers
    .flatMap((each) =>
      each[can] === true && now - each.at < upFor ? [each.worker] : [],
    )
    .toSorted((a, b) => a.localeCompare(b));

/** The worker the dashboard is open on, from the `here` query, if known. */
export const hereOf = (
  result: AsyncResult.AsyncResult<{ readonly worker: string | null }, unknown>,
) => (AsyncResult.isSuccess(result) ? result.value.worker : null);

/** Remember the machine picked here, to offer it first next time. */
export const pickMachine = (worker: string) => {
  localStorage.setItem(pickedKey, worker);
};

/**
 * The machine of `machines` to launch on first: the one the dashboard is
 * open on, the one picked last here, then the one it `ran` on.
 */
export const firstMachine = (
  machines: ReadonlyArray<string>,
  here: string | null,
  ran: string | null = null,
) =>
  [
    here,
    localStorage.getItem(pickedKey),
    localStorage.getItem(legacyKey),
    ran,
  ].find((each): each is string => each !== null && machines.includes(each)) ??
  machines[0];

/**
 * A button that launches on the first machine, with the others in a menu
 * beside it as one control. Choosing one from the menu launches there and
 * offers it first next time. With one machine it's a plain button.
 */
export const machineButton = (options: {
  readonly machines: ReadonlyArray<string>;
  readonly first: string;
  /** The button's text for launching on a machine. */
  readonly label: (worker: string) => string;
  readonly icon: string;
  readonly size?: "xs" | "small";
  readonly busy?: boolean;
  readonly launch: (worker: string) => void;
}) => {
  const size = options.size ?? "small";
  const others = options.machines.filter((each) => each !== options.first);

  const button = html`<gw-button
    size=${size}
    appearance="outlined"
    variant="neutral"
    icon=${options.icon}
    ?loading=${options.busy === true}
    @click=${() => options.launch(options.first)}
    >${options.label(options.first)}</gw-button
  >`;

  if (others.length === 0) return button;

  const items: MenuItem[] = others.map((worker) => ({
    value: worker,
    label: options.label(worker),
    icon: options.icon,
  }));

  return html`<gw-control-group class="machine-button">
    ${button}
    <gw-menu-button
      size=${size}
      appearance="plain"
      labels="hide"
      icon=${phCaretDown}
      label="Other machines"
      heading="On another machine"
      ?loading=${options.busy === true}
      .items=${items}
      @select=${(event: Event) => {
        const worker = chosen(event);

        pickMachine(worker);
        options.launch(worker);
      }}
    ></gw-menu-button>
  </gw-control-group>`;
};
