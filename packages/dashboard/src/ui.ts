/**
 * Pieces every dashboard element shares: icons, times, run state badges, and
 * how a request's result shows while it loads or when it fails.
 */
import { type Api, Catalogue, type Domain } from "@upkeep/api";
import { type Cause, Option, Predicate, Schema } from "effect";
import { AsyncResult } from "effect/reactivity";
import { css, html, render, svg, type TemplateResult } from "lit";
import { registry } from "./AtomController.ts";
import {
  phArrowSquareOut,
  phCheck,
  phCheckCircle,
  phCopy,
  phHourglass,
  phMinusCircle,
  phPlayCircle,
  phProhibit,
  phRobot,
  phSignOut,
  phTerminalWindow,
  phWarningCircle,
  phXCircle,
} from "./icons.ts";
import { openSession, token } from "./upkeep.ts";
import "@timmo001/groundwork-ui/define/gw-alert.ts";
import "@timmo001/groundwork-ui/define/gw-badge.ts";
import "@timmo001/groundwork-ui/define/gw-button.ts";
import "@timmo001/groundwork-ui/define/gw-empty-state.ts";
import "@timmo001/groundwork-ui/define/gw-card.ts";
import "@timmo001/groundwork-ui/define/gw-markdown.ts";
import "./upkeep-sign-in.ts";

/** Styles every element shares. */
export const shared = css`
  :host {
    display: block;
  }

  a {
    color: var(--gw-color-link);
  }

  .muted {
    color: var(--gw-color-text-secondary);
  }

  code,
  pre {
    font-family: var(--gw-font-mono);
  }

  .icon {
    width: 1.25em;
    height: 1.25em;
    fill: currentColor;
    vertical-align: middle;
  }

  a.external .icon {
    width: 0.9em;
    height: 0.9em;
    margin-inline-start: 0.2em;
    vertical-align: baseline;
  }

  /* Pinned to its container's corner: left at its place in a line cut short,
     it would sit past the clip and widen the page */
  .visually-hidden {
    position: absolute;
    top: 0;
    left: 0;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .message {
    margin-block: var(--gw-space-3);
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th,
  td {
    padding: var(--gw-space-2) var(--gw-space-3);
    border-bottom: 1px solid var(--gw-color-border-quiet);
    text-align: left;
    vertical-align: middle;
  }

  th {
    color: var(--gw-color-text-secondary);
    font-weight: var(--gw-font-weight-strong);
  }

  td code,
  td time,
  td gw-badge {
    white-space: nowrap;
  }

  .table {
    overflow-x: auto;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gw-space-2);
    justify-content: end;
  }

  .parked {
    color: var(--gw-color-warning);
  }

  .session {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--gw-space-2);
  }

  .session code {
    user-select: all;
    overflow-wrap: anywhere;
  }
`;

/** A Phosphor icon, from one of `icons.ts`'s paths. */
export const icon = (path: string) =>
  html`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
    ${svg`<path d=${path}></path>`}
  </svg>`;

/**
 * A link that leaves the dashboard: it opens in a new tab, with an icon
 * saying so.
 */
export const externalLink = (href: string, content: string | TemplateResult) =>
  html`<a
    class="external"
    href=${href}
    target="_blank"
    rel="noopener noreferrer"
    >${content}${icon(phArrowSquareOut)}<span class="visually-hidden">
      (opens in a new tab)</span
    ></a
  >`;

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const units: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
  ["second", 1000],
];

/** How long ago a time was, such as "3 hours ago". */
export const ago = (millis: number) => {
  const elapsed = millis - Date.now();
  const unit = units.find(([, size]) => Math.abs(elapsed) >= size);

  return unit === undefined
    ? relative.format(0, "second")
    : relative.format(Math.round(elapsed / unit[1]), unit[0]);
};

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

export const formatTime = (millis: number) => dateTime.format(millis);

/** A time as "3 hours ago", with the exact time in its tooltip. */
export const time = (millis: number) =>
  html`<time
    datetime=${new Date(millis).toISOString()}
    title=${formatTime(millis)}
    >${ago(millis)}</time
  >`;

/** How long a run took, or has taken so far. */
export const duration = (run: Domain.Run) => {
  if (run.startedAt === null) return "";

  const seconds = Math.round(
    ((run.finishedAt ?? Date.now()) - run.startedAt) / 1000,
  );

  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const states: Record<
  Domain.RunState,
  {
    readonly path: string;
    readonly tone: string;
    readonly label?: string;
  }
> = {
  queued: { path: phHourglass, tone: "neutral" },
  running: { path: phPlayCircle, tone: "info" },
  succeeded: { path: phCheckCircle, tone: "success" },
  skipped: { path: phMinusCircle, tone: "neutral" },
  "handed-off": { path: phRobot, tone: "info", label: "Handed off" },
  failed: { path: phXCircle, tone: "danger" },
  cancelled: { path: phProhibit, tone: "warning" },
};

const decodeChoice = Schema.decodeUnknownOption(
  Schema.Struct({ value: Schema.String }),
);

/** The value a menu item chosen carries. */
export const chosen = (event: Event) => {
  const detail: unknown = event instanceof CustomEvent ? event.detail : null;

  return Option.match(decodeChoice(detail), {
    onNone: () => "",
    onSome: ({ value }) => value,
  });
};

/** Text with its first letter in capitals, for an ID shown as a label. */
export const capitalise = (text: string) =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** A model with its variant, such as `opencode/big-pickle (high)`. */
export const agentLabel = (agent: Domain.AgentModel) =>
  agent.variant === null ? agent.model : `${agent.model} (${agent.variant})`;

/** A job's name, such as `Stalled updates`, from its ID. */
export const jobName = (id: string) =>
  Catalogue.jobs.find((job) => job.id === id)?.name ?? capitalise(id);

export const stateBadge = (state: Domain.RunState) =>
  html`<gw-badge
    size="small"
    icon=${states[state].path}
    tone=${states[state].tone}
    >${states[state].label ?? capitalise(state)}</gw-badge
  >`;

const signOut = () => registry.set(token, "");

/**
 * The errors the dashboard's requests fail with. A stream fails with
 * `NoSuchElementError` when it ends without a value.
 */
type ApiError =
  | Api.Unauthorized
  | Api.JobNotFound
  | Api.RunNotFound
  | Api.RunNotClaimed
  | Api.RunFinished
  | Cause.NoSuchElementError;

/**
 * A request's error. A refusal asks for an admin token, unless one was
 * already given, when it offers to sign out instead. Behind Home Assistant
 * ingress the server never refuses, so no token is needed. With no error,
 * the request itself failed.
 */
const renderError = (error: Option.Option<ApiError>) => {
  if (Option.isNone(error)) {
    return html`<gw-alert class="message" tone="danger" urgent
      >Couldn't reach the Upkeep server.</gw-alert
    >`;
  }

  if (!Predicate.isTagged(error.value, "Unauthorized")) {
    return html`<gw-alert class="message" tone="warning"
      >${error.value.message}</gw-alert
    >`;
  }

  return registry.get(token) === ""
    ? html`<upkeep-sign-in></upkeep-sign-in>`
    : html`<gw-alert class="message" tone="danger" urgent>
        The server refused this admin token.
        <gw-button
          slot="actions"
          size="small"
          appearance="filled"
          variant="neutral"
          icon=${phSignOut}
          @click=${signOut}
          >Sign out</gw-button
        >
      </gw-alert>`;
};

/** A card of skeleton lines, for content still loading. */
export const skeleton = html`<div aria-busy="true">
  <gw-card loading lines="4"></gw-card>
</div>`;

/**
 * A request's result: a skeleton until it first loads, shaped like the page
 * where `loading` is given, then its value, kept while it refreshes, or what
 * went wrong.
 */
export const view = <A>(
  result: AsyncResult.AsyncResult<A, ApiError>,
  render: (value: A) => TemplateResult,
  loading: TemplateResult = skeleton,
) => {
  if (AsyncResult.isFailure(result)) {
    return renderError(AsyncResult.error(result));
  }

  return Option.match(AsyncResult.value(result), {
    onNone: () => loading,
    onSome: render,
  });
};

/** What a list shows with nothing in it. */
export const empty = (path: string, message: string) =>
  html`<gw-empty-state icon=${path}><p>${message}</p></gw-empty-state>`;

/**
 * An expansion panel's `draw`: draws a template into the panel the first
 * time it opens, so a closed panel costs nothing.
 */
export const drawn =
  (content: () => TemplateResult) => (target: HTMLElement) => {
    render(content(), target);
  };

/** Text a person or an agent wrote, read as markdown. */
export const written = (text: string) =>
  html`<gw-markdown .content=${text}></gw-markdown>`;

/** A badge for a run that left something for a person. */
export const attentionBadge = html`<gw-badge
  size="small"
  icon=${phWarningCircle}
  tone="warning"
  >needs you</gw-badge
>`;

/**
 * An agent's OpenCode session: the command that resumes it, with a button to
 * copy it, and one to open it in Herdr on each worker in `on`, the one it ran
 * on first.
 */
export const agentSession = (
  open: {
    readonly worker: string;
    readonly session: string;
    readonly directory: string;
    readonly title: string;
  },
  on: ReadonlyArray<string> = [open.worker],
) => {
  const resume = `opencode2 --session ${open.session}`;

  const workers = [
    open.worker,
    ...on.filter((each) => each !== open.worker).toSorted(),
  ];

  return html`<span class="session">
    <code>${resume}</code>
    <gw-button
      size="xs"
      appearance="plain"
      variant="neutral"
      labels="hide"
      icon=${phCopy}
      @click=${(event: Event) => {
        const button = event.currentTarget;

        void navigator.clipboard.writeText(resume).then(() => {
          if (button instanceof HTMLElement)
            button.setAttribute("icon", phCheck);
        });
      }}
      >Copy</gw-button
    >
    ${workers.map(
      (worker) =>
        html`<gw-button
          size="xs"
          appearance="outlined"
          variant="neutral"
          icon=${phTerminalWindow}
          @click=${() => registry.set(openSession, { ...open, worker })}
          >Resume in Herdr on ${worker}</gw-button
        >`,
    )}
    <gw-button
      size="xs"
      appearance="plain"
      variant="neutral"
      icon=${phArrowSquareOut}
      href=${sessionLink(open)}
      >Open here</gw-button
    >
  </span>`;
};

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
