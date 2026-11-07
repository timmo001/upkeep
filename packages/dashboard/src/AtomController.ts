/**
 * Ties Effect atoms to Lit elements, after groundwork's lit-effect: an element
 * keeps an atom mounted while it's connected and redraws when it changes.
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { type Atom, AsyncResult, AtomRegistry } from "effect/reactivity";
import { live } from "./upkeep.ts";

/** The registry every element reads its atoms from. */
export const registry = AtomRegistry.make();

/** How often a polled atom is refreshed while the server's changes are live. */
const fallbackPoll = 60_000;

/**
 * Keeps an atom mounted while its host is connected, and redraws the host
 * whenever the atom changes. `select` runs before each render, so the atom
 * can depend on the host's properties. With `poll`, the atom is refreshed
 * every five seconds while the page is visible and `poll` holds for its
 * value, so lists of runs keep up without a reload. While the server's
 * changes reach the page, which refresh what they touch, that drops to once a
 * minute in case one was missed.
 */
export class AtomController<A> implements ReactiveController {
  readonly #host: ReactiveControllerHost;
  readonly #select: () => Atom.Atom<A>;
  readonly #poll: ((value: A) => boolean) | undefined;
  #atom: Atom.Atom<A> | undefined;
  #unsubscribe: (() => void) | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #polled = 0;

  constructor(
    host: ReactiveControllerHost,
    select: () => Atom.Atom<A>,
    poll?: (value: A) => boolean,
  ) {
    this.#host = host;
    this.#select = select;
    this.#poll = poll;
    host.addController(this);
  }

  get value(): A {
    return registry.get(this.#atom ?? this.#select());
  }

  hostConnected() {
    this.#host.requestUpdate();

    const poll = this.#poll;

    if (poll === undefined) return;

    this.#timer = setInterval(() => {
      const atom = this.#atom;

      if (atom === undefined || document.visibilityState !== "visible") return;

      const value = registry.get(atom);

      // A request still retrying is left to finish, so a failure shows
      // instead of being restarted by every poll
      if (AsyncResult.isAsyncResult(value) && AsyncResult.isWaiting(value))
        return;

      const now = Date.now();

      if (
        AsyncResult.getOrElse(registry.get(live), () => false) &&
        now - this.#polled < fallbackPoll
      )
        return;

      if (poll(value)) {
        this.#polled = now;
        registry.refresh(atom);
      }
    }, 5000);
  }

  hostUpdate() {
    const atom = this.#select();

    if (atom === this.#atom) return;

    this.#unsubscribe?.();
    this.#atom = atom;
    this.#unsubscribe = registry.subscribe(atom, () =>
      this.#host.requestUpdate(),
    );
  }

  hostDisconnected() {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#atom = undefined;
  }
}

/** Polls for as long as the element is on screen. */
export const always = () => true;
