/**
 * Pieces every dashboard element shares: icons, times, run state badges, and
 * how a request's result shows while it loads or when it fails.
 */
import {
  mdiAlertCircleOutline,
  mdiCancel,
  mdiCheckCircleOutline,
  mdiCloseCircleOutline,
  mdiLogout,
  mdiMinusCircleOutline,
  mdiOpenInNew,
  mdiPlayCircleOutline,
  mdiProgressClock,
} from "@mdi/js";
import { type Api, Catalogue, type Domain } from "@upkeep/api";
import { type Cause, Option, Predicate } from "effect";
import { AsyncResult } from "effect/reactivity";
import { css, html, svg, type TemplateResult } from "lit";
import { registry } from "./AtomController.ts";
import { token } from "./upkeep.ts";
import "@timmo001/groundwork-ui/gw-alert.ts";
import "@timmo001/groundwork-ui/gw-badge.ts";
import "@timmo001/groundwork-ui/gw-button.ts";
import "@timmo001/groundwork-ui/gw-empty-state.ts";
import "@timmo001/groundwork-ui/gw-card.ts";
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

  .visually-hidden {
    position: absolute;
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
`;

/** A Material Design icon, from one of `@mdi/js`'s paths. */
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
    >${content}${icon(mdiOpenInNew)}<span class="visually-hidden">
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
  { readonly path: string; readonly tone: string }
> = {
  queued: { path: mdiProgressClock, tone: "neutral" },
  running: { path: mdiPlayCircleOutline, tone: "info" },
  succeeded: { path: mdiCheckCircleOutline, tone: "success" },
  skipped: { path: mdiMinusCircleOutline, tone: "neutral" },
  failed: { path: mdiCloseCircleOutline, tone: "danger" },
  cancelled: { path: mdiCancel, tone: "warning" },
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
    >${capitalise(state)}</gw-badge
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
          icon=${mdiLogout}
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

/** A pushed commit: its repository, short SHA linked to it, and subject. */
export const commit = (change: Domain.Change) =>
  html`<span class="commit"
    ><span class="muted">${change.repo.split("/").at(-1)}</span>
    ${externalLink(change.url, html`<code>${change.sha.slice(0, 7)}</code>`)}
    ${change.subject}</span
  >`;

/** A badge for a run that left something for a person. */
export const attentionBadge = html`<gw-badge
  size="small"
  icon=${mdiAlertCircleOutline}
  tone="warning"
  >needs you</gw-badge
>`;
