/**
 * `upkeep-schedules`: the schedules on the agent's session a run worked in,
 * as its worker last reported them, such as a wake-up for when GitHub is
 * back. Pause, resume or delete each, or schedule a prompt of your own, all
 * done by the worker the session is on, through OpenCode's schedules.
 */
import { Domain } from "@upkeep/api";
import { GwInput } from "@timmo001/groundwork-ui/gw-input.ts";
import { GwSegmented } from "@timmo001/groundwork-ui/gw-segmented.ts";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement, nothing } from "lit";
import { AtomController, registry } from "./AtomController.ts";
import { phCheck, phClock, phPause, phPlay, phPlus, phTrash } from "./icons.ts";
import { shared, time } from "./ui.ts";
import { runSchedules, scheduleCommand } from "./upkeep.ts";
import "@timmo001/groundwork-ui/define/gw-badge.ts";
import "@timmo001/groundwork-ui/define/gw-button.ts";
import "@timmo001/groundwork-ui/define/gw-input.ts";
import "@timmo001/groundwork-ui/define/gw-section.ts";
import "@timmo001/groundwork-ui/define/gw-segmented.ts";

type WhenKind = "in" | "every" | "at" | "cron";

type AddCommand = Extract<Domain.Command, { readonly kind: "schedule-add" }>;

/** A schedule to add, filled in from the form a field at a time. */
type ScheduleAdd = { -readonly [Key in keyof AddCommand]: AddCommand[Key] };

const whenKinds: ReadonlyArray<{
  readonly value: WhenKind;
  readonly label: string;
  readonly placeholder: string;
}> = [
  { value: "in", label: "Once, in", placeholder: "1 hour" },
  { value: "every", label: "Every", placeholder: "30 minutes" },
  { value: "at", label: "At", placeholder: "2026-11-16T09:00" },
  { value: "cron", label: "Cron", placeholder: "0 9 * * 1-5" },
];

const isWhenKind = (value: string): value is WhenKind =>
  whenKinds.some((kind) => kind.value === value);

const whenOf = (kind: WhenKind, value: string): Domain.ScheduleWhen => {
  switch (kind) {
    case "in":
      return { in: value };
    case "every":
      return { every: value };
    case "at":
      return { at: value };
    case "cron":
      return { cron: value };
  }
};

const statuses: Record<
  Domain.SessionSchedule["status"],
  {
    readonly tone: string;
    readonly icon: string;
    readonly label: string;
    /** The button that pauses or resumes it, none once it's done. */
    readonly toggle: {
      readonly kind: "schedule-pause" | "schedule-resume";
      readonly icon: string;
      readonly label: string;
    } | null;
  }
> = {
  active: {
    tone: "success",
    icon: phPlay,
    label: "Active",
    toggle: { kind: "schedule-pause", icon: phPause, label: "Pause" },
  },
  paused: {
    tone: "warning",
    icon: phPause,
    label: "Paused",
    toggle: { kind: "schedule-resume", icon: phPlay, label: "Resume" },
  },
  done: { tone: "neutral", icon: phCheck, label: "Done", toggle: null },
};

export class UpkeepSchedules extends LitElement {
  static override properties = {
    runId: { attribute: "run-id" },
  };

  static override styles = [
    shared,
    css`
      .schedule {
        display: grid;
        gap: var(--gw-space-1);
        padding-block: var(--gw-space-2);
        border-bottom: var(--gw-border-width) solid var(--gw-color-border-quiet);
      }

      .head {
        display: flex;
        flex-wrap: wrap;
        gap: var(--gw-space-2);
        align-items: center;
      }

      .name {
        font-weight: 600;
      }

      .meta {
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
      }

      .actions {
        display: flex;
        gap: var(--gw-space-2);
        margin-inline-start: auto;
      }

      form {
        display: grid;
        gap: var(--gw-space-3);
        margin-top: var(--gw-space-3);
      }

      form .row {
        display: flex;
        flex-wrap: wrap;
        gap: var(--gw-space-2);
        align-items: end;
      }
    `,
  ];

  declare runId: string;

  constructor() {
    super();
    this.runId = "";
  }

  readonly #schedules = new AtomController(this, () =>
    runSchedules(this.runId),
  );

  #adding = false;

  #kind: WhenKind = "in";

  #schedule(found: Domain.RunSchedules, schedule: Domain.SessionSchedule) {
    const { worker, session } = found;

    if (worker === null || session === null) return nothing;

    const act = (
      kind: "schedule-pause" | "schedule-resume" | "schedule-delete",
    ) =>
      registry.set(scheduleCommand, {
        kind,
        worker,
        session,
        schedule: schedule.id,
      });

    const status = statuses[schedule.status];

    return html`<div class="schedule">
      <div class="head">
        <span class="name">${schedule.name ?? schedule.when}</span>
        <gw-badge size="small" icon=${status.icon} tone=${status.tone}
          >${status.label}</gw-badge
        >
        <span class="actions">
          ${
            status.toggle === null
              ? nothing
              : html`<gw-button
                  size="small"
                  appearance="outlined"
                  variant="neutral"
                  icon=${status.toggle.icon}
                  @click=${() => {
                    if (status.toggle !== null) act(status.toggle.kind);
                  }}
                  >${status.toggle.label}</gw-button
                >`
          }
          <gw-button
            size="small"
            appearance="outlined"
            variant="danger"
            icon=${phTrash}
            @click=${() => act("schedule-delete")}
            >Delete</gw-button
          >
        </span>
      </div>
      <div>${schedule.prompt}</div>
      <div class="meta">
        ${schedule.name === null ? nothing : html`${schedule.when} · `}
        ${schedule.condition === null ? nothing : html`once <code>${schedule.condition}</code> passes · `}
        ${schedule.nextDueAt === null ? nothing : html`next ${time(schedule.nextDueAt)} · `}
        ${schedule.endsAt === null ? nothing : html`ends ${time(schedule.endsAt)} · `}
        woke ${schedule.runCount === 1 ? "once" : `${schedule.runCount} times`}
        ${schedule.lastOutcome === null ? nothing : html` · last ${schedule.lastOutcome}`}
      </div>
    </div>`;
  }

  #add(event: SubmitEvent, worker: string, session: string) {
    event.preventDefault();

    const form = event.currentTarget;

    if (!(form instanceof HTMLFormElement)) return;

    const field = (name: string) => {
      const input = form.querySelector(`gw-input[name="${name}"]`);

      return input instanceof GwInput ? input.value.trim() : "";
    };

    const when = field("when");
    const prompt = field("prompt");
    const condition = field("condition");
    const name = field("name");

    if (when === "" || prompt === "") return;

    const add: ScheduleAdd = {
      kind: "schedule-add",
      worker,
      session,
      when: whenOf(this.#kind, when),
      prompt,
    };

    if (name !== "") add.name = name;

    if (condition !== "") add.condition = condition;

    registry.set(scheduleCommand, add);

    this.#adding = false;
    this.requestUpdate();
  }

  #form(worker: string, session: string) {
    const kind = whenKinds.find((each) => each.value === this.#kind);

    return html`<form
      @submit=${(event: SubmitEvent) => this.#add(event, worker, session)}
    >
      <gw-segmented
        size="small"
        label="When"
        value=${this.#kind}
        .options=${whenKinds.map(({ value, label }) => ({ value, label }))}
        @change=${(event: Event) => {
          const value =
            event.currentTarget instanceof GwSegmented
              ? event.currentTarget.value
              : "";

          if (isWhenKind(value)) {
            this.#kind = value;
            this.requestUpdate();
          }
        }}
      ></gw-segmented>
      <gw-input
        name="when"
        label=${kind?.label ?? "When"}
        placeholder=${kind?.placeholder ?? ""}
        required
      ></gw-input>
      <gw-input
        name="prompt"
        label="Prompt"
        hint="What the session is told when it wakes"
        multiline
        required
      ></gw-input>
      <gw-input
        name="condition"
        label="Only once this passes"
        hint="A shell command, run in the session's directory"
        monospace
        optional
      ></gw-input>
      <gw-input name="name" label="Name" optional></gw-input>
      <div class="row">
        <gw-button type="submit" size="small" icon=${phPlus}
          >Schedule</gw-button
        >
        <gw-button
          size="small"
          appearance="plain"
          variant="neutral"
          @click=${() => {
            this.#adding = false;
            this.requestUpdate();
          }}
          >Cancel</gw-button
        >
      </div>
    </form>`;
  }

  override render() {
    const result = this.#schedules.value;

    if (!AsyncResult.isSuccess(result)) return nothing;

    const found = result.value;
    const { worker, session } = found;

    if (worker === null || session === null) return nothing;

    return html`<gw-section
      heading="Schedules"
      count=${found.schedules.length}
      storage-key="upkeep.run.section.schedules"
    >
      ${
        this.#adding
          ? nothing
          : html`<gw-button
              slot="actions"
              size="small"
              appearance="outlined"
              variant="neutral"
              icon=${phClock}
              @click=${() => {
                this.#adding = true;
                this.requestUpdate();
              }}
              >Schedule a prompt</gw-button
            >`
      }
      ${
        found.schedules.length === 0 && !this.#adding
          ? html`<p class="muted">Nothing scheduled on this session.</p>`
          : found.schedules.map((schedule) => this.#schedule(found, schedule))
      }
      ${this.#adding ? this.#form(worker, session) : nothing}
    </gw-section>`;
  }
}

customElements.define("upkeep-schedules", UpkeepSchedules);
