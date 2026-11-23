/**
 * What you can do with an agent's OpenCode session: resume it in Herdr, on
 * the machine you're on by default with the others in a menu, have it ask
 * you in the Plannotator Inbox, or open it on this machine. Each says how
 * it's going through the page's `ActionTracker`, under the buttons.
 */
import { html } from "lit";
import type { ActionTracker, Words } from "./ActionTracker.ts";
import { phArrowSquareOut, phChatCircle, phTerminalWindow } from "./icons.ts";
import { firstMachine, machineButton } from "./machines.ts";
import { capitalise } from "./ui.ts";
import { askInbox, openSession } from "./upkeep.ts";
import "@timmo001/groundwork-ui/define/gw-button.ts";

/** An agent's OpenCode session, and the worker it ran on. */
export interface OpenSession {
  readonly worker: string;
  readonly session: string;
  readonly directory: string;
  readonly title: string;
}

const resumeWords = (worker: string): Words => ({
  sending: `Asking ${worker} to open the session…`,
  waiting: `Waiting for ${worker} to pick it up…`,
  running: `${capitalise(worker)} is opening the session in Herdr…`,
  done: `Opened in Herdr on ${worker}`,
  failed: `Couldn't open it on ${worker}`,
});

const askWords = (worker: string): Words => ({
  sending: "Asking the agent to write to your Inbox…",
  waiting: `Waiting for ${worker} to pick it up…`,
  running: `The agent on ${worker} is writing to your Inbox…`,
  done: "The agent has written to your Inbox",
  failed: "The agent couldn't write to your Inbox",
});

/**
 * An `upkeep://` link that opens a session on the machine the browser is
 * on, through `upkeep open`, where the `upkeep-git` package registered it.
 */
export const sessionLink = (open: {
  readonly session: string;
  readonly directory: string;
  readonly title: string;
}) =>
  `upkeep://open/${encodeURIComponent(open.session)}?${new URLSearchParams({
    directory: open.directory,
    title: open.title,
  }).toString()}`;

/**
 * The buttons for a session: Resume in Herdr on the first of `machines`
 * (the ones it can resume on), with the rest in its menu; with `ask`, the ID
 * of a run that left work for you, Ask me in the Inbox, which resumes it in
 * the background where it ran and dismisses that run once nothing waits on
 * you; and Open here. `key` is what `tracker` keeps their status under.
 */
export const sessionActions = (options: {
  readonly open: OpenSession;
  readonly machines: ReadonlyArray<string>;
  readonly here: string | null;
  readonly ask?: string | null;
  readonly tracker: ActionTracker;
  readonly key: string;
  readonly size?: "xs" | "small";
}) => {
  const { open, tracker, key } = options;
  const size = options.size ?? "small";

  const machines =
    options.machines.length === 0 ? [open.worker] : options.machines;

  const first =
    firstMachine(machines, options.here, open.worker) ?? open.worker;

  const ask = options.ask ?? null;

  return html`${machineButton({
      machines,
      first,
      label: (worker) => `Resume in Herdr on ${worker}`,
      icon: phTerminalWindow,
      size,
      busy: tracker.busy(key, "resume"),
      launch: (worker) =>
        tracker.track(key, "resume", resumeWords(worker), openSession, {
          ...open,
          worker,
        }),
    })}
    ${
      ask === null
        ? null
        : html`<gw-button
            size=${size}
            appearance="outlined"
            variant="neutral"
            icon=${phChatCircle}
            ?loading=${tracker.busy(key, "ask")}
            @click=${() =>
              tracker.track(key, "ask", askWords(open.worker), askInbox, {
                ...open,
                run: ask,
              })}
            >Ask me in the Inbox</gw-button
          >`
    }
    <gw-button
      size=${size}
      appearance="plain"
      variant="neutral"
      icon=${phArrowSquareOut}
      href=${sessionLink(open)}
      title="Opens it in OpenCode on the machine this browser is on, through Upkeep"
      @click=${() =>
        tracker.say(
          key,
          "here",
          "Asked this machine to open it in OpenCode. Nothing opening means Upkeep isn't installed here",
        )}
      >Open here</gw-button
    >`;
};
