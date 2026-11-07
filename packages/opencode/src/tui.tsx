/**
 * The upkeep plugin's TUI part: the count of what needs you in the prompt
 * footer, from `upkeep status --json`, the same status the bar reads.
 * Clicking it lists what needs you. Nothing shows while nothing does, and
 * there are no toasts: anything that needs you already goes to the Inbox.
 */
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { TextAttributes } from "@opentui/core";
import { Effect, Schema } from "effect";
import { createSignal, For, Show } from "solid-js";
import { runUpkeep } from "./upkeep";

/** The parts of `upkeep status --json` the footer reads. */
const Status = Schema.fromJsonString(
  Schema.Struct({
    health: Schema.Literals(["ok", "warning", "degraded"]),
    summary: Schema.String,
    needs: Schema.Array(Schema.Struct({ title: Schema.String })),
    footer: Schema.Struct({ text: Schema.String }),
  }),
);

type Current = typeof Status.Type;

/** How often the footer reads the status again. */
const pollMillis = 60_000;

// No server, token or binary leaves the footer empty rather than failing
const read = () =>
  Effect.runPromise(
    runUpkeep(["status", "--json"], { timeout: "10 seconds" }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Status)),
      Effect.orElseSucceed((): Current | null => null),
    ),
  );

export default Plugin.define({
  id: "upkeep",
  setup(context) {
    if (Bun.which("upkeep") === null) return;

    const [status, setStatus] = createSignal<Current | null>(null);

    const poll = async () => setStatus(await read());

    void poll();

    const timer = setInterval(() => void poll(), pollMillis);

    function Needs() {
      const theme = context.theme.surface("dialog");

      return (
        <box gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
          <box flexDirection="row" gap={2}>
            <text
              attributes={TextAttributes.BOLD}
              fg={theme.text.base}
              flexGrow={1}
            >
              Upkeep
            </text>
            <text
              fg={theme.text.muted}
              flexShrink={0}
              onMouseUp={() => context.ui.dialog.clear()}
            >
              esc
            </text>
          </box>
          <text fg={theme.text.base}>{status()?.summary}</text>
          <For each={status()?.needs ?? []}>
            {(item) => <text fg={theme.text.base}>- {item.title}</text>}
          </For>
          <text fg={theme.text.muted}>
            Open Upkeep in the Home Assistant sidebar to deal with them.
          </text>
        </box>
      );
    }

    const open = () => {
      context.ui.dialog.show(() => <Needs />);
      context.ui.dialog.set({ size: "medium", centered: true });
    };

    function Footer() {
      const plugin = usePlugin();

      return (
        <Show when={status()?.footer.text}>
          {(text) => (
            <box flexShrink={0}>
              <text
                fg={
                  status()?.health === "degraded"
                    ? plugin.theme.text.feedback.error.base
                    : plugin.theme.text.feedback.warning.base
                }
                onMouseUp={open}
              >
                {text()}
              </text>
            </box>
          )}
        </Show>
      );
    }

    const slot = context.ui.slot({
      append: "prompt.footer.status",
      render: () => <Footer />,
    });

    return () => {
      clearInterval(timer);
      slot();
    };
  },
});
