/**
 * `upkeep-inbox`: the home page. A summary of what's new since the inbox was
 * last read, what needs a person with the button that settles it, then what
 * changed by day, each entry saying what it did, with routine updates folded
 * into one panel. Built from groundwork's components.
 */
import {
  mdiCheckAll,
  mdiCheckCircleOutline,
  mdiClose,
  mdiPlayPause,
} from "@mdi/js";
import type { Domain } from "@upkeep/api";
import { AsyncResult } from "effect/reactivity";
import { css, html, LitElement, nothing } from "lit";
import { always, AtomController, registry } from "./AtomController.ts";
import { empty, externalLink, shared, time, view } from "./ui.ts";
import {
  dismissEntry,
  inbox,
  jobHref,
  jobs,
  markRead,
  runHref,
  unparkJob,
} from "./upkeep.ts";
import "@timmo001/groundwork-ui/gw-alert.ts";
import "@timmo001/groundwork-ui/gw-button.ts";
import "@timmo001/groundwork-ui/gw-card.ts";
import "@timmo001/groundwork-ui/gw-chip.ts";
import "@timmo001/groundwork-ui/gw-dot.ts";
import "@timmo001/groundwork-ui/gw-expansion.ts";
import "@timmo001/groundwork-ui/gw-page-header.ts";
import "@timmo001/groundwork-ui/gw-section-title.ts";
import "@timmo001/groundwork-ui/layout.ts";

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

/** Commits that say little on their own, left out of a summary. */
const filler =
  /^(Release |Merge |Bump version|Update (dependency |lockfile|\S+ (digest|action))|Format|Lint|wip$)/i;

const fixes = (entry: Domain.Entry) =>
  entry.items.filter((item) => item.text.startsWith("Fixed:"));

/**
 * What an entry did, as a heading and a line under it. Commits lead with
 * their newest change worth reading and list the next few; a release says
 * where it went; an update or drift move, which repositories it reached.
 */
const describe = (entry: Domain.Entry) => {
  const repos = reposOf(entry);

  switch (entry.kind) {
    case "commit": {
      const newest = entry.items.toReversed();
      const worth = newest.filter((item) => !filler.test(item.text));
      const shown = worth.length > 0 ? worth : newest;
      const [lead, ...rest] = shown.map((item) => item.text);
      const more = entry.items.length - 1 - Math.min(rest.length, 3);

      return {
        heading: `${repos[0] ?? "?"}: ${lead ?? entry.title}`,
        description: [
          ...rest.slice(0, 3),
          ...(more > 0 ? [`${plural(more, "more commit")}`] : []),
        ].join(" · "),
      };
    }

    case "release": {
      const fixed = fixes(entry);

      return {
        heading:
          repos.length === 0
            ? `${entry.title} released`
            : `${entry.title} reached ${plural(repos.length, "repository", "repositories")}`,
        description: [
          listed(repos),
          ...(fixed.length > 0
            ? [`${plural(fixed.length, "fix", "fixes")} by Upkeep`]
            : []),
        ]
          .filter((part) => part !== "")
          .join(" · "),
      };
    }

    default:
      return {
        heading: entry.title,
        description:
          repos.length > 4
            ? plural(repos.length, "repository", "repositories")
            : listed(repos),
      };
  }
};

const kinds: Record<
  Domain.EntryKind,
  { readonly label: string; readonly tone: string }
> = {
  needs: { label: "Needs you", tone: "warning" },
  release: { label: "Release", tone: "accent" },
  update: { label: "Update", tone: "info" },
  drift: { label: "Drift", tone: "info" },
  fix: { label: "Fixed by Upkeep", tone: "success" },
  commit: { label: "Commits", tone: "neutral" },
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
 * A few sentences on what's new: releases and where they went, what you
 * changed and where, updates that needed a change, the routine count, and
 * whether anything needs you.
 */
const summarise = (fresh: ReadonlyArray<Domain.Entry>, needs: number) => {
  const sentences: Array<string> = [];
  const releases = fresh.filter((entry) => entry.kind === "release");

  for (const release of releases.slice(0, 3)) {
    sentences.push(`${describe(release).heading}.`);
  }

  if (releases.length > 3) {
    sentences.push(`${plural(releases.length - 3, "more release")} went out.`);
  }

  const yours = fresh.filter((entry) => entry.you && !entry.routine);

  if (yours.length > 0) {
    const byRepo = new Map<string, number>();

    for (const entry of yours) {
      for (const repo of reposOf(entry)) {
        byRepo.set(repo, (byRepo.get(repo) ?? 0) + entry.items.length);
      }
    }

    const busiest = [...byRepo]
      .toSorted(([, a], [, b]) => b - a)
      .slice(0, 4)
      .map(([repo, count]) => `${repo} (${count})`);

    sentences.push(
      `You pushed to ${listed(busiest)}${byRepo.size > 4 ? ` and ${byRepo.size - 4} more` : ""}.`,
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

  const fixed = fresh.filter((entry) => entry.kind === "fix");

  if (fixed.length > 0) {
    sentences.push(`Upkeep fixed ${listed(fixed.flatMap(reposOf))}.`);
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
      .tldr p {
        margin: 0;
        font-size: var(--gw-font-size-l);
        line-height: 1.6;
      }

      .tldr gw-row {
        margin-top: var(--gw-space-3);
      }

      gw-expansion + gw-expansion {
        margin-top: var(--gw-space-2);
      }

      gw-button a {
        color: inherit;
        text-decoration: none;
      }

      .items {
        margin: 0;
        padding: 0;
        list-style: none;
        font-size: var(--gw-font-size-s);
      }

      .items li {
        display: flex;
        flex-wrap: wrap;
        gap: var(--gw-space-2);
        align-items: baseline;
        padding: var(--gw-space-1) 0;
      }

      .items li + li {
        border-top: 1px dashed var(--gw-color-border-quiet);
      }

      .when {
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
      }

      .read::part(heading) {
        font-weight: normal;
        color: var(--gw-color-text-secondary);
      }
    `,
  ];

  readonly #inbox = new AtomController(this, () => inbox, always);

  readonly #jobs = new AtomController(this, () => jobs);

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

    return html`<gw-alert tone="warning" heading=${entry.title}>
      ${entry.detail ?? ""}
      <div class="when">
        ${entry.count > 1 ? `${entry.count} times, last ` : ""}${time(entry.lastAt)}
      </div>
      ${
        job !== null && parked.has(job)
          ? html`<gw-button
              slot="actions"
              size="small"
              appearance="filled"
              variant="warning"
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
            : html`<gw-button
                slot="actions"
                size="small"
                appearance="outlined"
                variant="neutral"
                ><a href=${jobHref(job)}>Runs</a></gw-button
              >`
          : html`<gw-button
              slot="actions"
              size="small"
              appearance="outlined"
              variant="neutral"
              ><a href=${runHref(entry.run)}>Open the run</a></gw-button
            >`
      }
      <gw-button
        slot="actions"
        size="small"
        appearance="plain"
        variant="neutral"
        icon=${mdiClose}
        @click=${() => registry.set(dismissEntry, entry.id)}
        >Dismiss</gw-button
      >
    </gw-alert>`;
  }

  #entry(entry: Domain.Entry) {
    const { heading, description } = describe(entry);
    const kind = kinds[entry.you ? "commit" : entry.kind];
    const unread = entry.readAt === null;

    const opened = (event: Event) => {
      const target = event.currentTarget;

      if (
        target instanceof HTMLElement &&
        target.hasAttribute("open") &&
        unread
      ) {
        registry.set(markRead, [entry.id]);
      }
    };

    return html`<gw-expansion
      class=${unread ? "" : "read"}
      heading=${heading}
      description=${description}
      @toggle=${opened}
    >
      <gw-dot
        slot="icon"
        tone=${unread ? "accent" : "neutral"}
        label=${unread ? "Unread" : "Read"}
      ></gw-dot>
      <gw-row gap="s">
        <gw-chip size="xs" tone=${entry.you ? "accent" : kind.tone}
          >${entry.you ? "You" : kind.label}</gw-chip
        >
        ${
          fixes(entry).length > 0
            ? html`<gw-chip size="xs" tone="success"
                >${plural(fixes(entry).length, "fix", "fixes")} by
                Upkeep</gw-chip
              >`
            : nothing
        }
        ${entry.routine ? html`<gw-chip size="xs">Routine</gw-chip>` : nothing}
        <span class="when">${time(entry.lastAt)}</span>
        ${entry.url === null ? nothing : externalLink(entry.url, "The release")}
      </gw-row>
      <ul class="items">
        ${entry.items.toReversed().map(
          (item) =>
            html`<li>
              <gw-chip size="xs">${short(item.repo)}</gw-chip>
              ${item.url === null ? item.text : externalLink(item.url, item.text)}
              <span class="when">${time(item.at)}</span>
            </li>`,
        )}
      </ul>
    </gw-expansion>`;
  }

  #render(box: Domain.Inbox) {
    const parked = this.#parked();
    const needs = box.entries.filter((entry) => entry.kind === "needs");
    const others = box.entries.filter((entry) => entry.kind !== "needs");
    const worth = others.filter((entry) => !entry.routine);
    const routine = others.filter((entry) => entry.routine);
    const fresh = others.filter((entry) => entry.readAt === null);
    const unread = worth.filter((entry) => entry.readAt === null).length;

    const days = new Map<string, Array<Domain.Entry>>();

    for (const entry of worth) {
      const day = dayOf(entry.lastAt);

      days.set(day, [...(days.get(day) ?? []), entry]);
    }

    const routineRepos = new Set(routine.flatMap(reposOf)).size;

    return html`
      <gw-stack gap="l">
        <gw-page-header
          heading="Inbox"
          description=${
            unread === 0
              ? "You're up to date"
              : `${plural(unread, "change")} to read since you last looked`
          }
        >
          ${
            fresh.length === 0
              ? nothing
              : html`<gw-button
                  slot="actions"
                  appearance="outlined"
                  variant="neutral"
                  icon=${mdiCheckAll}
                  @click=${() => registry.set(markRead, undefined)}
                  >Mark all read</gw-button
                >`
          }
        </gw-page-header>

        <gw-card class="tldr">
          <p>
            ${
              fresh.length === 0 && needs.length === 0
                ? "Nothing new since you last looked."
                : summarise(fresh, needs.length)
            }
          </p>
          <gw-row gap="s">
            <gw-chip size="small" tone="accent"
              >${plural(worth.length, "change")} worth reading</gw-chip
            >
            <gw-chip size="small" tone="success"
              >${routine.length} routine, no code changed</gw-chip
            >
            <gw-chip size="small"
              >${plural(new Set(others.flatMap(reposOf)).size, "repository", "repositories")}</gw-chip
            >
          </gw-row>
        </gw-card>

        ${
          needs.length === 0
            ? nothing
            : html`<gw-stack>
                <gw-section-title>Needs you</gw-section-title>
                ${needs.map((entry) => this.#needs(entry, parked))}
              </gw-stack>`
        }

        <gw-stack>
          <gw-section-title>What changed</gw-section-title>
          ${
            worth.length === 0
              ? empty(mdiCheckCircleOutline, "Nothing worth reading lately.")
              : [...days].map(
                  ([day, entries]) =>
                    html`<gw-card heading=${day} level="3">
                      ${entries.map((entry) => this.#entry(entry))}
                    </gw-card>`,
                )
          }
        </gw-stack>

        ${
          routine.length === 0
            ? nothing
            : html`<gw-card>
                <gw-expansion
                  heading=${`${plural(routine.length, "routine update")} across ${plural(routineRepos, "repository", "repositories")}`}
                  description="Versions, lockfiles, pins and tool versions only. None needed a code change."
                >
                  ${routine.map((entry) => this.#entry(entry))}
                </gw-expansion>
              </gw-card>`
        }
      </gw-stack>
    `;
  }

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
