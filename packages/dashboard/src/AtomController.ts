/**
 * Ties Effect atoms to Lit elements, after groundwork's lit-effect: an element
 * keeps an atom mounted while it's connected and redraws when its data
 * changes, not when a refresh brings back the same.
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

  /** The atom's latest value, as last read. */
  #seen: { readonly value: A } | undefined;

  /** The value the host draws, kept while a refresh brings the same data. */
  #shown: { readonly value: A } | undefined;

  /** The data the shown value holds, to tell a refresh that changed nothing. */
  #digest: string | undefined;

  /**
   * The value to draw: the shown one again when a refresh brought the same
   * data, so nothing redraws and the host's lists keep their items.
   */
  #settle(value: A): A {
    if (this.#seen?.value === value && this.#shown !== undefined) {
      return this.#shown.value;
    }

    this.#seen = { value };

    const digest =
      AsyncResult.isAsyncResult(value) && AsyncResult.isSuccess(value)
        ? JSON.stringify(value.value)
        : undefined;

    if (
      digest !== undefined &&
      digest === this.#digest &&
      this.#shown !== undefined
    ) {
      return this.#shown.value;
    }

    this.#digest = digest;
    this.#shown = { value };

    return value;
  }

  get value(): A {
    return this.#settle(registry.get(this.#atom ?? this.#select()));
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
    this.#seen = undefined;
    this.#shown = undefined;
    this.#digest = undefined;
    this.#unsubscribe = registry.subscribe(atom, (value) => {
      const before = this.#shown;

      this.#settle(value);

      // A refresh that brought the same data leaves the host as it is
      if (this.#shown !== before) this.#host.requestUpdate();
    });
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
