/**
 * The address each worker last called the server from, so the dashboard can
 * tell which machine it's open on: a browser reaches the server from the same
 * address as the worker beside it. Kept in memory, as each worker calls every
 * few minutes; a browser that comes another way, such as over a VPN while
 * its worker doesn't, matches none.
 */
import { Context, Effect, Layer, Option, Ref } from "effect";

/** An address as compared: an IPv4 one mapped into IPv6 as plain IPv4. */
const normalise = (address: string) => address.replace(/^::ffff:/, "");

export class Addresses extends Context.Service<
  Addresses,
  {
    /** Note that `worker` called from `address`. */
    readonly seen: (worker: string, address: string) => Effect.Effect<void>;
    /** The worker that last called from `address`, if one has. */
    readonly workerAt: (
      address: string,
    ) => Effect.Effect<Option.Option<string>>;
  }
>()("@upkeep/server/Addresses") {
  static readonly layer = Layer.effect(
    Addresses,
    Effect.gen(function* () {
      // Each worker's latest address, so a worker that moves leaves its old one
      const latest = yield* Ref.make(new Map<string, string>());

      return Addresses.of({
        seen: (worker, address) =>
          Ref.update(latest, (map) =>
            map.get(worker) === normalise(address)
              ? map
              : new Map(map).set(worker, normalise(address)),
          ),
        workerAt: (address) =>
          Ref.get(latest).pipe(
            Effect.map((map) =>
              Option.fromNullishOr(
                [...map]
                  .toSorted(([a], [b]) => a.localeCompare(b))
                  .find(([, at]) => at === normalise(address))?.[0],
              ),
            ),
          ),
      });
    }),
  );
}
