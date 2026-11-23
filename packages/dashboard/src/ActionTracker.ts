/**
 * Follows what a button asked the server for, so the page can say what's
 * happening rather than leave you guessing: sending it, then the run the
 * server queued for it, waiting for a worker, running, and how it ended,
 * with a link to the run. Each action is kept by a key, such as an inbox
 * entry's, so a page of them shows each one's status under its own buttons,
 * and only the button pressed shows it's busy.
 */
import { Domain } from "@upkeep/api";
import { Schema } from "effect";
import { AsyncResult, type Atom } from "effect/reactivity";
import {
  html,
  nothing,
  type ReactiveController,
  type ReactiveControllerHost,
  type TemplateResult,
} from "lit";
import { registry } from "./AtomController.ts";
import { phCheckCircle, phWarningCircle } from "./icons.ts";
import { icon } from "./ui.ts";
import { run as runAtom, runHref } from "./upkeep.ts";
import "@timmo001/groundwork-ui/define/gw-spinner.ts";

/** What the status says at each step. */
export interface Words {
  /** While the request is on its way to the server. */
  readonly sending: string;
  /** Once a run is queued, until a worker takes it. */
  readonly waiting: string;
  /** While a worker runs it. */
  readonly running: string;
  /** Once it's worked. */
  readonly done: string;
  /** Once it's failed; why follows it. */
  readonly failed: string;
}

/** The same words at every step, for an action with one thing to say. */
export const saying = (text: string): Words => ({
  sending: text,
  waiting: text,
  running: text,
  done: text,
  failed: text,
});

type Step =
  | { readonly kind: "sending" }
  | { readonly kind: "run"; readonly run: string }
  | {
      readonly kind: "ended";
      readonly ok: boolean;
      readonly why: string | null;
      readonly run: string | null;
    };

interface Action {
  readonly words: Words;
  /** Which of the buttons under the key was pressed. */
  readonly button: string;
  readonly step: Step;
  readonly at: number;
}

/** How long a status shows once its action has ended. */
const shownFor = 5 * 60_000;

/** How often a run being followed is read again, in case a change is missed. */
const pollEvery = 3000;

const going = (state: Domain.RunState) =>
  state === "queued" || state === "running";

const isRun = Schema.is(Domain.Run);

/** Why a request failed, in a few words. */
const why = (result: AsyncResult.Failure<unknown, unknown>) => {
  const error = AsyncResult.error(result);

  return error instanceof Error && error.message !== ""
    ? error.message
    : "the server didn't take it";
};

export class ActionTracker implements ReactiveController {
  readonly #host: ReactiveControllerHost;
  readonly #actions = new Map<string, Action>();
  readonly #stops = new Map<string, () => void>();

  constructor(host: ReactiveControllerHost) {
    this.#host = host;
    host.addController(this);
  }

  /** Start an action under `key`, in place of the one before. */
  #start(key: string, words: Words, button: string, step: Step) {
    this.#stop(key);
    this.#actions.set(key, { words, button, step, at: Date.now() });
    this.#host.requestUpdate();
  }

  /** Move the action under `key` on to `step`. */
  #step(key: string, step: Step) {
    const action = this.#actions.get(key);

    if (action === undefined) return;

    this.#actions.set(key, { ...action, step, at: Date.now() });
    this.#host.requestUpdate();
  }

  #stop(key: string) {
    this.#stops.get(key)?.();
    this.#stops.delete(key);
  }

  /**
   * Whether the action under `key` came from `button` and is still on its
   * way or running.
   */
  busy(key: string, button: string) {
    const action = this.#actions.get(key);

    return (
      action !== undefined &&
      action.button === button &&
      action.step.kind !== "ended"
    );
  }

  /**
   * Ask the server for something through `atom`, with `payload`, as `button`
   * was pressed, and follow it under `key`: the run it answers with, when
   * it's a run, or the answer alone when it isn't, such as a dismissal.
   */
  track<R, W>(
    key: string,
    button: string,
    words: Words,
    atom: Atom.Writable<R, W>,
    payload: W,
  ) {
    this.#start(key, words, button, { kind: "sending" });

    const before = registry.get(atom);

    // Subscribed before it's set, so it's mounted while the request runs
    const unsubscribe = registry.subscribe(atom, (value) => {
      if (
        value === before ||
        !AsyncResult.isAsyncResult(value) ||
        AsyncResult.isInitial(value) ||
        AsyncResult.isWaiting(value)
      )
        return;

      this.#stop(key);

      if (AsyncResult.isFailure(value)) {
        this.#step(key, {
          kind: "ended",
          ok: false,
          why: why(value),
          run: null,
        });

        return;
      }

      if (AsyncResult.isSuccess(value) && isRun(value.value)) {
        this.#follow(key, value.value.id);

        return;
      }

      this.#step(key, { kind: "ended", ok: true, why: null, run: null });
    });

    this.#stops.set(key, unsubscribe);
    registry.set(atom, payload);
  }

  /**
   * Say what happened under `key` for something that never reaches the
   * server, such as a link this machine opens.
   */
  say(key: string, button: string, text: string) {
    this.#start(key, saying(text), button, {
      kind: "ended",
      ok: true,
      why: null,
      run: null,
    });
  }

  /** Follow the run `id` under `key` until it ends. */
  #follow(key: string, id: string) {
    const atom = runAtom(id);

    this.#step(key, { kind: "run", run: id });

    const read = (value: AsyncResult.AsyncResult<Domain.Run, unknown>) => {
      if (!AsyncResult.isSuccess(value) || going(value.value.state)) {
        this.#host.requestUpdate();

        return;
      }

      const ended = value.value;

      this.#stop(key);
      this.#step(key, {
        kind: "ended",
        ok: ended.state === "succeeded" || ended.state === "skipped",
        why: ended.error,
        run: id,
      });
    };

    const unsubscribe = registry.subscribe(atom, read);

    const timer = setInterval(() => {
      if (!AsyncResult.isWaiting(registry.get(atom))) registry.refresh(atom);
    }, pollEvery);

    this.#stops.set(key, () => {
      clearInterval(timer);
      unsubscribe();
    });

    read(registry.get(atom));
  }

  /** The status of the action under `key`, or nothing once it's old. */
  status(key: string) {
    const action = this.#actions.get(key);

    if (action === undefined) return nothing;

    const { words, step } = action;

    const line = (
      lead: TemplateResult,
      text: string,
      run: string | null,
      failed = false,
    ) =>
      html`<p class="action-status ${failed ? "failed" : ""}" role="status">
        ${lead}
        <span
          >${text}${
            run === null
              ? nothing
              : html` · <a href=${runHref(run)}>See the run</a>`
          }</span
        >
      </p>`;

    const spinner = (label: string) =>
      html`<gw-spinner size="small" label=${label}></gw-spinner>`;

    switch (step.kind) {
      case "sending":
        return line(spinner("Sending"), words.sending, null);

      case "run": {
        const value = registry.get(runAtom(step.run));

        const state = AsyncResult.isSuccess(value)
          ? value.value.state
          : "queued";

        return state === "running"
          ? line(spinner("Running"), words.running, step.run)
          : line(spinner("Waiting"), words.waiting, step.run);
      }

      case "ended":
        if (Date.now() - action.at > shownFor) return nothing;

        return step.ok
          ? line(icon(phCheckCircle), words.done, step.run)
          : line(
              icon(phWarningCircle),
              step.why === null ? words.failed : `${words.failed}: ${step.why}`,
              step.run,
              true,
            );
    }
  }

  hostConnected() {
    // Back on the page: pick up following the runs left going, and forget a
    // request whose answer came while away
    for (const [key, action] of this.#actions) {
      if (this.#stops.has(key)) continue;

      if (action.step.kind === "run") this.#follow(key, action.step.run);
      else if (action.step.kind === "sending") this.#actions.delete(key);
    }
  }

  hostDisconnected() {
    for (const key of this.#stops.keys()) this.#stop(key);
  }
}
