/**
 * `upkeep-inbox`: the home page. A summary of what's new since the inbox was
 * last read, what needs a person with the button that settles it, then what
 * changed by day, with routine updates folded into one line.
 */
import {
  mdiAlertCircleOutline,
  mdiCheckAll,
  mdiCheckCircleOutline,
  mdiClose,
  mdiPlayPause,
} from "@mdi/js";
import type { Domain } from "@upkeep/api";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement, nothing } from "lit";
import { always, AtomController, registry } from "./AtomController.ts";
import { empty, externalLink, icon, shared, time, view } from "./ui.ts";
import {
  dismissEntry,
  inbox,
  jobHref,
  jobs,
  markRead,
  runHref,
  unparkJob,
} from "./upkeep.ts";
import "@timmo001/groundwork-ui/gw-button.ts";

const short = (repo: string) => repo.split("/").at(-1) ?? repo;

/** The distinct repositories an entry reached, by short name. */
const reposOf = (entry: Domain.Entry) => [
  ...new Set(entry.items.map((item) => short(item.repo))),
];

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** A list in words: "a, b and c". */
const listed = (words: ReadonlyArray<string>) =>
  words.length <= 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

const kindLabels: Record<Domain.EntryKind, string> = {
  needs: "Needs you",
  release: "First-party release",
  update: "Update",
  drift: "Drift",
  fix: "Fixed by Upkeep",
  commit: "Commits",
};

/** The day an entry belongs to, as the feed's heading. */
const dayOf = (millis: number) => {
  const day = new Date(millis).toDateString();
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);

  if (day === today.toDateString()) return "Today";

  if (day === yesterday.toDateString()) return "Yesterday";

  return new Date(millis).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
};

/**
 * A few sentences on what's new: releases and where they went, commits by
 * you and others, updates that needed a change, the routine count, and
 * whether anything needs you.
 */
const summarise = (fresh: ReadonlyArray<Domain.Entry>, needs: number) => {
  const sentences: Array<string> = [];

  const releases = fresh.filter((entry) => entry.kind === "release");

  for (const release of releases.slice(0, 3)) {
    const repos = reposOf(release);

    const fixed = release.items.filter((item) =>
      item.text.startsWith("Fixed:"),
    );

    sentences.push(
      repos.length === 0
        ? `${release.title} was released.`
        : `${release.title} reached ${plural(repos.length, "repository", "repositories")}${fixed.length > 0 ? `, and ${plural(fixed.length, "fix", "fixes")} went in with it` : ""}.`,
    );
  }

  if (releases.length > 3) {
    sentences.push(`${plural(releases.length - 3, "more release")} went out.`);
  }

  const yours = fresh.filter((entry) => entry.you && !entry.routine);

  if (yours.length > 0) {
    const commits = yours.reduce((sum, entry) => sum + entry.items.length, 0);
    const repos = [...new Set(yours.flatMap(reposOf))];

    sentences.push(
      `You pushed ${plural(commits, "commit")} to ${listed(repos.slice(0, 4))}${repos.length > 4 ? ` and ${repos.length - 4} more` : ""}.`,
    );
  }

  const others = fresh.filter(
    (entry) => entry.kind === "commit" && !entry.you && !entry.routine,
  );

  if (others.length > 0) {
    sentences.push(
      `Others pushed to ${listed([...new Set(others.flatMap(reposOf))].slice(0, 4))}.`,
    );
  }

  const changed = fresh.filter(
    (entry) =>
      (entry.kind === "update" || entry.kind === "drift") && !entry.routine,
  );

  if (changed.length > 0) {
    sentences.push(
      `${plural(changed.length, "update")} needed a code or config change.`,
    );
  }

  const fixes = fresh.filter((entry) => entry.kind === "fix");

  if (fixes.length > 0) {
    sentences.push(`Upkeep fixed ${listed(fixes.flatMap(reposOf))}.`);
  }

  const routine = fresh.filter((entry) => entry.routine);

  if (routine.length > 0) {
    sentences.push(
      `${plural(routine.length, "routine update")} across ${plural(new Set(routine.flatMap(reposOf)).size, "repository", "repositories")} needed nothing.`,
    );
  }

  sentences.push(
    needs === 0
      ? "Nothing needs you."
      : `${needs === 1 ? "One thing needs" : `${needs} things need`} you.`,
  );

  return sentences.join(" ");
};

export class UpkeepInbox extends LitElement {
  static override styles = [
    shared,
    css`
      :host {
        max-width: 56rem;
        margin: 0 auto;
      }

      .title {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: var(--gw-space-3);
        margin: var(--gw-space-2) 0 var(--gw-space-4);
      }

      h1 {
        margin: 0;
        font-size: 1.6rem;
      }

      .title gw-button {
        margin-left: auto;
      }

      .tldr {
        padding: var(--gw-space-4) var(--gw-space-5);
        border: 1px solid var(--gw-color-border-quiet);
        border-radius: var(--gw-space-3);
        background: var(--gw-color-surface-low);
      }

      .tldr p {
        margin: 0;
        font-size: 1.1rem;
        line-height: 1.6;
      }

      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: var(--gw-space-2);
        margin-top: var(--gw-space-3);
      }

      .chip {
        padding: 0 var(--gw-space-3);
        border: 1px solid var(--gw-color-border-quiet);
        border-radius: 999px;
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
      }

      .chip b {
        color: var(--gw-color-text-primary);
      }

      section {
        margin-top: var(--gw-space-6);
      }

      h2 {
        margin: 0 0 var(--gw-space-3);
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .needs {
        display: flex;
        gap: var(--gw-space-4);
        margin-bottom: var(--gw-space-3);
        padding: var(--gw-space-4);
        border: 1px solid
          color-mix(in srgb, var(--gw-color-warning) 40%, transparent);
        border-radius: var(--gw-space-3);
        background: color-mix(in srgb, var(--gw-color-warning) 8%, transparent);
      }

      .needs > .icon {
        flex: none;
        width: 1.75rem;
        height: 1.75rem;
        color: var(--gw-color-warning);
      }

      .needs h3 {
        margin: 0 0 var(--gw-space-1);
        font-size: 1rem;
      }

      .needs p {
        margin: 0;
        color: var(--gw-color-text-secondary);
        white-space: pre-line;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--gw-space-2);
        margin-top: var(--gw-space-3);
      }

      .day {
        margin: var(--gw-space-5) 0 var(--gw-space-2);
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
        font-weight: var(--gw-font-weight-strong);
      }

      .list {
        border: 1px solid var(--gw-color-border-quiet);
        border-radius: var(--gw-space-3);
        background: var(--gw-color-surface-low);
        overflow: hidden;
      }

      .entry {
        display: grid;
        grid-template-columns: 0.5rem 1fr auto;
        gap: var(--gw-space-3);
        padding: var(--gw-space-3) var(--gw-space-4);
        border-top: 1px solid var(--gw-color-border-quiet);
      }

      .entry:first-child {
        border-top: 0;
      }

      .dot {
        width: 0.5rem;
        height: 0.5rem;
        margin-top: 0.5rem;
        border-radius: 50%;
        background: var(--gw-color-link);
      }

      .read .dot {
        background: transparent;
      }

      .read summary .name {
        color: var(--gw-color-text-secondary);
        font-weight: normal;
      }

      details summary {
        cursor: pointer;
        list-style: none;
      }

      details summary::-webkit-details-marker {
        display: none;
      }

      .name {
        font-weight: var(--gw-font-weight-strong);
      }

      .meta {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--gw-space-1) var(--gw-space-2);
        margin-top: var(--gw-space-1);
      }

      .tag {
        padding: 0 var(--gw-space-2);
        border-radius: var(--gw-space-1);
        font-size: var(--gw-font-size-s);
        font-weight: var(--gw-font-weight-strong);
        background: color-mix(in srgb, var(--gw-color-link) 14%, transparent);
        color: var(--gw-color-link);
      }

      .tag.you {
        background: color-mix(in srgb, #b98cff 16%, transparent);
        color: #b98cff;
      }

      .tag.fix,
      .tag.fixed {
        background: color-mix(
          in srgb,
          var(--gw-color-success, #5fcf8f) 14%,
          transparent
        );
        color: var(--gw-color-success, #5fcf8f);
      }

      .tag.drift,
      .tag.update {
        background: color-mix(
          in srgb,
          var(--gw-color-warning) 14%,
          transparent
        );
        color: var(--gw-color-warning);
      }

      .repo {
        padding: 0 var(--gw-space-2);
        border-radius: var(--gw-space-1);
        background: var(--gw-color-surface-lower);
        color: var(--gw-color-text-secondary);
        font-family: var(--gw-font-mono);
        font-size: var(--gw-font-size-s);
      }

      .when {
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
        white-space: nowrap;
      }

      .items {
        margin: var(--gw-space-2) 0 0;
        padding: 0;
        list-style: none;
        font-size: var(--gw-font-size-s);
      }

      .items li {
        display: flex;
        gap: var(--gw-space-2);
        padding: var(--gw-space-1) 0;
        border-top: 1px dashed var(--gw-color-border-quiet);
      }

      .items li:first-child {
        border-top: 0;
      }

      .routine {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--gw-space-3);
        padding: var(--gw-space-3) var(--gw-space-4);
        border: 1px dashed var(--gw-color-border-quiet);
        border-radius: var(--gw-space-3);
        color: var(--gw-color-text-secondary);
      }

      .routine .icon {
        color: var(--gw-color-success, #5fcf8f);
      }

      .routine gw-button {
        margin-left: auto;
      }

      .routine-list {
        margin-top: var(--gw-space-2);
      }
    `,
  ];

  readonly #inbox = new AtomController(this, () => inbox, always);

  readonly #jobs = new AtomController(this, () => jobs);

  #showRoutine = false;

  /** The jobs that are parked, so a parked job's entry offers to unpark it. */
  #parked() {
    const result = this.#jobs.value;

    return new Set(
      AsyncResult.isSuccess(result)
        ? result.value.filter((job) => job.parked !== null).map((job) => job.id)
        : [],
    );
  }

  #needs(entry: Domain.Entry, parked: ReadonlySet<string>) {
    const job = entry.job;

    return html`<div class="needs">
      ${icon(mdiAlertCircleOutline)}
      <div>
        <h3>${entry.title}</h3>
        ${entry.detail === null ? nothing : html`<p>${entry.detail}</p>`}
        <div class="when">
          ${entry.count > 1 ? `${entry.count} times, last ` : ""}${time(entry.lastAt)}
        </div>
        <div class="actions">
          ${
            job !== null && parked.has(job)
              ? html`<gw-button
                  size="small"
                  appearance="filled"
                  icon=${mdiPlayPause}
                  @click=${() => registry.set(unparkJob, job)}
                  >Unpark ${job}</gw-button
                >`
              : nothing
          }
          ${
            entry.run === null
              ? job === null
                ? nothing
                : html`<a href=${jobHref(job)}>See ${job}'s runs</a>`
              : html`<a href=${runHref(entry.run)}>Open the run</a>`
          }
          <gw-button
            size="small"
            appearance="outlined"
            variant="neutral"
            icon=${mdiClose}
            @click=${() => registry.set(dismissEntry, entry.id)}
            >Dismiss</gw-button
          >
        </div>
      </div>
    </div>`;
  }

  #entry(entry: Domain.Entry) {
    const repos = reposOf(entry);
    const fixed = entry.items.filter((item) => item.text.startsWith("Fixed:"));

    const open = (event: Event) => {
      if (
        event.target instanceof HTMLDetailsElement &&
        event.target.open &&
        entry.readAt === null
      ) {
        registry.set(markRead, [entry.id]);
      }
    };

    return html`<div class="entry ${entry.readAt === null ? "" : "read"}">
      <span
        class="dot"
        aria-label=${entry.readAt === null ? "Unread" : "Read"}
      ></span>
      <details @toggle=${open}>
        <summary>
          <span class="name">${entry.title}</span>
          <div class="meta">
            <span class="tag ${entry.you ? "you" : entry.kind}"
              >${entry.you ? "You" : kindLabels[entry.kind]}</span
            >
            ${
              fixed.length > 0
                ? html`<span class="tag fixed"
                    >${plural(fixed.length, "fix", "fixes")} by Upkeep</span
                  >`
                : nothing
            }
            ${
              repos.length > 4
                ? html`<span class="repo"
                    >${plural(repos.length, "repository", "repositories")}</span
                  >`
                : repos.map((repo) => html`<span class="repo">${repo}</span>`)
            }
          </div>
        </summary>
        <ul class="items">
          ${
            entry.url === null
              ? nothing
              : html`<li>${externalLink(entry.url, "The release")}</li>`
          }
          ${entry.items.map(
            (item) =>
              html`<li>
                <span class="repo">${short(item.repo)}</span>
                ${
                  item.url === null
                    ? item.text
                    : externalLink(item.url, item.text)
                }
              </li>`,
          )}
        </ul>
      </details>
      <span class="when">${time(entry.lastAt)}</span>
    </div>`;
  }

  #render(box: Domain.Inbox) {
    const parked = this.#parked();
    const needs = box.entries.filter((entry) => entry.kind === "needs");
    const others = box.entries.filter((entry) => entry.kind !== "needs");
    const worth = others.filter((entry) => !entry.routine);
    const routine = others.filter((entry) => entry.routine);
    const fresh = others.filter((entry) => entry.readAt === null);
    const unread = box.entries.filter((entry) => entry.readAt === null);

    const days = new Map<string, Array<Domain.Entry>>();

    for (const entry of worth) {
      const day = dayOf(entry.lastAt);

      days.set(day, [...(days.get(day) ?? []), entry]);
    }

    const routineRepos = new Set(routine.flatMap(reposOf)).size;

    return html`
      <div class="title">
        <h1>Inbox</h1>
        <span class="muted"
          >${
            unread.length === 0
              ? "You're up to date"
              : `${plural(unread.length, "new entry", "new entries")}`
          }</span
        >
        ${
          unread.length === 0
            ? nothing
            : html`<gw-button
                size="small"
                appearance="outlined"
                variant="neutral"
                icon=${mdiCheckAll}
                @click=${() => registry.set(markRead, undefined)}
                >Mark all read</gw-button
              >`
        }
      </div>

      <div class="tldr">
        <p>
          ${
            fresh.length === 0 && needs.length === 0
              ? "Nothing new since you last looked."
              : summarise(fresh, needs.length)
          }
        </p>
        <div class="chips">
          <span class="chip"
            ><b>${worth.length}</b> ${worth.length === 1 ? "change" : "changes"}
            worth reading</span
          >
          <span class="chip"
            ><b>${routine.length}</b> routine, no code changed</span
          >
          <span class="chip"
            ><b>${new Set(others.flatMap(reposOf)).size}</b> repositories
            touched</span
          >
        </div>
      </div>

      ${
        needs.length === 0
          ? nothing
          : html`<section>
              <h2>Needs you</h2>
              ${needs.map((entry) => this.#needs(entry, parked))}
            </section>`
      }

      <section>
        <h2>What changed</h2>
        ${
          worth.length === 0
            ? empty(mdiCheckCircleOutline, "Nothing worth reading lately.")
            : [...days].map(
                ([day, entries]) =>
                  html`<div class="day">${day}</div>
                    <div class="list">
                      ${entries.map((entry) => this.#entry(entry))}
                    </div>`,
              )
        }
        ${
          routine.length === 0
            ? nothing
            : html`<div class="day">Routine</div>
                <div class="routine">
                  ${icon(mdiCheckCircleOutline)}
                  <span
                    >${plural(routine.length, "routine update")} across
                    ${plural(routineRepos, "repository", "repositories")}. None
                    needed a code change.</span
                  >
                  <gw-button
                    size="small"
                    appearance="outlined"
                    variant="neutral"
                    @click=${this.#toggleRoutine}
                    >${this.#showRoutine ? "Hide" : "Show"}</gw-button
                  >
                </div>
                ${
                  this.#showRoutine
                    ? html`<div class="list routine-list">
                        ${routine.map((entry) => this.#entry(entry))}
                      </div>`
                    : nothing
                }`
        }
      </section>
    `;
  }

  readonly #toggleRoutine = () => {
    this.#showRoutine = !this.#showRoutine;
    this.requestUpdate();
  };

  override render() {
    return view(this.#inbox.value, (box) => this.#render(box));
  }
}

customElements.define("upkeep-inbox", UpkeepInbox);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-inbox": UpkeepInbox;
  }
}
