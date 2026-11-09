/**
 * `upkeep-releases`: each repository tracked for the unreleased job against
 * its last stable release, with the release its changes suggest; and one
 * repository's comparison, where you choose impacts for its changes, publish
 * the release or hand it to an agent to prepare.
 */
import type { Domain } from "@upkeep/api";
import "@timmo001/groundwork-ui/define/gw-input.ts";
import { GwInput } from "@timmo001/groundwork-ui/gw-input.ts";
import "@timmo001/groundwork-ui/define/gw-popover.ts";
import { GwPopover } from "@timmo001/groundwork-ui/gw-popover.ts";
import "@timmo001/groundwork-ui/define/gw-segmented.ts";
import { GwSegmented } from "@timmo001/groundwork-ui/gw-segmented.ts";
import type {
  TableColumn,
  TableRow,
} from "@timmo001/groundwork-ui/gw-table.ts";
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { always, AtomController, registry } from "./AtomController.ts";
import { plural } from "./entries.ts";
import {
  phArrowClockwise,
  phArrowLeft,
  phCheckCircle,
  phRobot,
  phRocketLaunch,
  phTag,
} from "./icons.ts";
import {
  chosen,
  drawn,
  empty,
  externalLink,
  shared,
  time,
  view,
} from "./ui.ts";
import { cell } from "./upkeep-cell.ts";
import {
  publishRelease,
  refreshRelease,
  releaseAgent,
  releaseHref,
  releasesHref,
  releasesPage,
  reviewRelease,
} from "./upkeep.ts";
import "@timmo001/groundwork-ui/define/gw-alert.ts";
import "@timmo001/groundwork-ui/define/gw-button.ts";
import "@timmo001/groundwork-ui/define/gw-chip.ts";
import "@timmo001/groundwork-ui/define/gw-expansion.ts";
import "@timmo001/groundwork-ui/define/gw-menu-button.ts";
import "@timmo001/groundwork-ui/define/gw-page-header.ts";
import "@timmo001/groundwork-ui/define/gw-section-title.ts";
import "@timmo001/groundwork-ui/define/gw-table.ts";
import "@timmo001/groundwork-ui/define/layout.ts";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

const impactTone: Record<Domain.Impact, Tone> = {
  none: "neutral",
  patch: "accent",
  minor: "warning",
  major: "danger",
};

const impacts: ReadonlyArray<Domain.Impact> = [
  "none",
  "patch",
  "minor",
  "major",
];

const isImpact = (value: string): value is Domain.Impact | "auto" =>
  value === "auto" || impacts.some((impact) => impact === value);

/** A worker seen in the last ten minutes is taken to be up. */
const upFor = 10 * 60 * 1000;

const fact = (label: string, value: string | TemplateResult) =>
  html`<dt>${label}</dt>
    <dd>${value}</dd>`;

const short = (sha: string) => html`<code>${sha.slice(0, 7)}</code>`;

/** What a repository's comparison suggests, or why it can't say. */
const suggestion = (entry: Domain.ReleaseEntry) => {
  const snapshot = entry.snapshot;

  if (snapshot === null)
    return html`<gw-chip size="xs" tone="danger">not read</gw-chip>`;

  return html`<gw-chip size="xs" tone=${impactTone[snapshot.suggestion]}
      >${snapshot.suggestion === "none" ? "no release" : snapshot.suggestion}</gw-chip
    >${
      entry.stale
        ? html` <gw-chip size="xs" tone="warning">stale</gw-chip>`
        : !snapshot.complete
          ? html` <gw-chip size="xs" tone="warning">incomplete</gw-chip>`
          : nothing
    }`;
};

/** A finding is release-relevant when a policy or you gave it an impact. */
const relevant = (finding: Domain.ReleaseFinding) =>
  finding.impact !== "none" ||
  finding.automaticImpact !== "none" ||
  finding.reviewed;

export class UpkeepReleases extends LitElement {
  static override properties = { repo: { attribute: false } };

  static override styles = [
    shared,
    css`
      dl {
        display: grid;
        grid-template-columns: max-content 1fr;
        align-items: baseline;
        gap: var(--gw-space-2) var(--gw-space-4);
        margin: 0;
      }

      dt {
        color: var(--gw-color-text-secondary);
      }

      dd {
        min-width: 0;
        margin: 0;
      }

      dd ul,
      .steps {
        margin: 0;
        padding-left: 1.25em;
      }

      gw-table {
        --gw-table-max-height: 32rem;
      }

      .muted {
        color: var(--gw-color-text-secondary);
        font-size: var(--gw-font-size-s);
      }
    `,
  ];

  /** The repository to show, as `owner/name`, or none for the list. */
  declare repo: string | undefined;

  readonly #page = new AtomController(this, () => releasesPage, always);

  #publishing: Domain.ReleaseEntry | undefined;

  #popover: GwPopover | undefined;

  #notes: GwInput | undefined;

  #mode: "prepend" | "replace" = "prepend";

  constructor() {
    super();
    this.repo = undefined;
  }

  #review(
    entry: Domain.ReleaseEntry,
    snapshot: Domain.ReleaseSnapshot,
    targets: ReadonlyArray<string>,
    value: string,
  ) {
    if (!isImpact(value)) return;

    registry.set(reviewRelease, {
      repo: entry.repo,
      snapshot: snapshot.id,
      targets,
      impact: value,
    });
  }

  /** A menu choosing an impact, or `auto` to go back to the policy's. */
  #impactMenu(
    label: string,
    entry: Domain.ReleaseEntry,
    snapshot: Domain.ReleaseSnapshot,
    targets: ReadonlyArray<string>,
    current: Domain.Impact,
    chosenHere: boolean,
  ) {
    const reviewable = !entry.stale && snapshot.complete;

    return html`<gw-menu-button
      size="xs"
      appearance="plain"
      label=${label}
      heading=${label}
      ?disabled=${!reviewable}
      .items=${[
        ...impacts.map((impact) => ({
          value: impact,
          label: impact === current ? `${impact} (now)` : impact,
        })),
        ...(chosenHere
          ? [{ value: "auto", label: "Back to the policy's" }]
          : []),
      ]}
      @select=${(event: Event) =>
        this.#review(entry, snapshot, targets, chosen(event))}
    ></gw-menu-button>`;
  }

  #list(page: Domain.ReleasesPage) {
    const byRepo = new Map(page.repos.map((entry) => [entry.repo, entry]));

    const draw =
      (
        content: (entry: Domain.ReleaseEntry) => TemplateResult | string,
        width: string | undefined,
      ) =>
      (row: TableRow) => {
        const entry = byRepo.get(String(row.id));

        return cell(
          entry === undefined ? "" : content(entry),
          width === undefined ? "fill" : { width },
        );
      };

    const columns: TableColumn[] = [
      {
        id: "name",
        header: "Repository",
        wide: true,
        cell: draw(
          (entry) =>
            html`<a class="row-link" href=${releaseHref(entry.repo)}
              >${entry.name}</a
            >`,
          undefined,
        ),
      },
      {
        id: "release",
        header: "Last release",
        cell: draw((entry) => entry.snapshot?.releaseTag ?? "none yet", "9rem"),
      },
      {
        id: "suggestion",
        header: "Suggests",
        searchable: false,
        cell: draw(suggestion, "11rem"),
      },
      {
        id: "next",
        header: "Next",
        cell: draw((entry) => entry.nextVersion ?? "", "9rem"),
      },
      {
        id: "commits",
        header: "Commits",
        searchable: false,
        cell: draw(
          (entry) => String(entry.snapshot?.commits.length ?? ""),
          "5rem",
        ),
      },
      {
        id: "checked",
        header: "Checked",
        searchable: false,
        cell: draw((entry) => time(entry.attemptedAt), "8rem"),
      },
    ];

    const needs = page.repos.filter((entry) => entry.needsRelease).length;

    return html`<gw-stack gap="l">
      <gw-page-header
        heading="Releases"
        description=${
          page.repos.length === 0
            ? "What changed since each repository's last stable release"
            : `${needs === 0 ? "No repository has" : `${plural(needs, "repository")} ${needs === 1 ? "has" : "have"}`} changes worth a release`
        }
      ></gw-page-header>
      ${
        page.repos.length === 0
          ? empty(
              phTag,
              "No comparisons yet: track repositories for the unreleased job, and they show once it has run.",
            )
          : html`<gw-table
              label="Repositories"
              row-key="id"
              sort="suggestion"
              descending
              search-label="Search repositories"
              .columns=${columns}
              .rows=${page.repos.map((entry) => ({
                id: entry.repo,
                name: entry.name,
                release: entry.snapshot?.releaseTag ?? "",
                suggestion:
                  (entry.needsRelease ? 10 : 0) +
                  impacts.indexOf(entry.snapshot?.suggestion ?? "none"),
                next: entry.nextVersion ?? "",
                commits: entry.snapshot?.commits.length ?? 0,
                checked: entry.attemptedAt,
              }))}
            ></gw-table>`
      }
    </gw-stack>`;
  }

  #findings(
    entry: Domain.ReleaseEntry,
    snapshot: Domain.ReleaseSnapshot,
    findings: ReadonlyArray<Domain.ReleaseFinding>,
    label: string,
  ) {
    const byId = new Map(findings.map((finding) => [finding.id, finding]));

    const draw =
      (
        content: (finding: Domain.ReleaseFinding) => TemplateResult | string,
        width: string | undefined,
      ) =>
      (row: TableRow) => {
        const finding = byId.get(String(row.id));

        return cell(
          finding === undefined ? "" : content(finding),
          width === undefined ? "fill" : { width, wrap: true },
        );
      };

    const columns: TableColumn[] = [
      {
        id: "detail",
        header: "Change",
        wide: true,
        cell: draw(
          (finding) =>
            finding.evidenceUrl === undefined
              ? finding.detail
              : externalLink(finding.evidenceUrl, finding.detail),
          undefined,
        ),
      },
      {
        id: "impact",
        header: "Impact",
        searchable: false,
        cell: draw(
          (finding) =>
            html`<gw-chip size="xs" tone=${impactTone[finding.impact]}
                >${finding.impact}</gw-chip
              >${
                finding.reviewed
                  ? html` <span class="muted"
                      >chosen, was ${finding.automaticImpact}</span
                    >`
                  : nothing
              }${finding.complete ? nothing : html` <gw-chip size="xs" tone="warning">incomplete</gw-chip>`}
              ${this.#impactMenu(
                "Choose",
                entry,
                snapshot,
                [finding.id],
                finding.impact,
                finding.reviewed,
              )}`,
          "14rem",
        ),
      },
      {
        id: "reason",
        header: "Why",
        cell: draw(
          (finding) =>
            finding.subjects === undefined || finding.subjects.length === 0
              ? finding.reason
              : `${finding.reason} (${finding.subjects.join("; ")})`,
          undefined,
        ),
      },
    ];

    return html`<gw-table
      label=${label}
      contained
      row-key="id"
      sort="impact"
      descending
      search-label=${`Search ${label.toLowerCase()}`}
      .columns=${columns}
      .rows=${findings.map((finding) => ({
        id: finding.id,
        detail: finding.detail,
        impact: impacts.indexOf(finding.impact),
        reason: finding.reason,
      }))}
    ></gw-table>`;
  }

  #commits(entry: Domain.ReleaseEntry, snapshot: Domain.ReleaseSnapshot) {
    const byId = new Map(snapshot.commits.map((commit) => [commit.id, commit]));

    const draw =
      (
        content: (commit: Domain.ReleaseCommit) => TemplateResult | string,
        width: string | undefined,
      ) =>
      (row: TableRow) => {
        const commit = byId.get(String(row.id));

        return cell(
          commit === undefined ? "" : content(commit),
          width === undefined ? "fill" : { width },
        );
      };

    const columns: TableColumn[] = [
      {
        id: "sha",
        header: "Commit",
        cell: draw(
          (commit) =>
            externalLink(
              commit.url ??
                `https://github.com/${entry.repo}/commit/${commit.id}`,
              short(commit.id),
            ),
          "6rem",
        ),
      },
      {
        id: "subject",
        header: "Subject",
        wide: true,
        cell: draw(
          (commit) =>
            commit.submodule === null
              ? commit.subject
              : `${commit.submodule}: ${commit.subject}`,
          undefined,
        ),
      },
      {
        id: "date",
        header: "When",
        searchable: false,
        cell: draw((commit) => time(Date.parse(commit.date)), "7rem"),
      },
    ];

    return html`<gw-table
      label="Commits"
      contained
      row-key="id"
      sort="date"
      descending
      search-label="Search commits"
      .columns=${columns}
      .rows=${snapshot.commits.map((commit) => ({
        id: commit.id,
        sha: commit.id,
        subject: commit.subject,
        date: Date.parse(commit.date),
      }))}
    ></gw-table>`;
  }

  /** The steps publishing takes, as the worker will take them. */
  #steps(entry: Domain.ReleaseEntry, snapshot: Domain.ReleaseSnapshot) {
    const recipe = entry.recipe;
    const tag = entry.nextVersion ?? "";
    const version = tag.replace(/^v/, "");

    if (recipe === null) return [];

    const changed = recipe.versionFiles.filter(
      (file) => file.before !== version,
    );

    return [
      `Start from ${entry.branch} at ${snapshot.head.slice(0, 7)}, in a worktree on the worker.`,
      ...recipe.versionFiles.map((file) =>
        file.error !== null
          ? `${file.path}: ${file.error}`
          : `${file.path}: ${file.before ?? "?"} → ${version}${file.before === version ? " (already set)" : ""}`,
      ),
      ...recipe.commands.map((command) => `Run ${command.join(" ")}`),
      ...(changed.length > 0
        ? [
            `Commit ${changed.map((file) => file.path).join(", ")}${recipe.generatedFiles.length > 0 ? `, with ${recipe.generatedFiles.join(", ")} where the commands regenerate them,` : ""} as "Release ${tag}".`,
            `Push that commit to ${entry.branch} and tag ${tag}, in one atomic push.`,
          ]
        : [`Tag ${tag} at ${snapshot.head.slice(0, 7)}; nothing to commit.`]),
      `Create the GitHub release ${tag}, with notes GitHub generates ${snapshot.releaseTag === null ? "from the whole history" : `since ${snapshot.releaseTag}`}, and any notes you add.`,
      "The release starts the repository's workflows; follow them on GitHub.",
    ];
  }

  #publishPopover() {
    const entry = this.#publishing;
    const snapshot = entry?.snapshot ?? null;

    return html`<gw-popover
      heading=${entry === undefined ? "Publish" : `Publish ${entry.name} ${entry.nextVersion ?? ""}`}
      ${ref((element) => {
        this.#popover = element instanceof GwPopover ? element : undefined;
      })}
      @close=${() => this.#published()}
    >
      ${
        entry === undefined || snapshot === null
          ? nothing
          : html`<gw-stack gap="s">
              <ol class="steps">
                ${this.#steps(entry, snapshot).map((step) => html`<li>${step}</li>`)}
              </ol>
              <gw-input
                multiline
                rows="5"
                label="Release notes, optional"
                ${ref((element) => {
                  this.#notes =
                    element instanceof GwInput ? element : undefined;
                })}
              ></gw-input>
              <gw-segmented
                size="small"
                label="Your notes"
                value=${this.#mode}
                .options=${[
                  { value: "prepend", label: "Before GitHub's" },
                  { value: "replace", label: "Instead of GitHub's" },
                ]}
                @change=${(event: Event) => {
                  const value =
                    event.currentTarget instanceof GwSegmented
                      ? event.currentTarget.value
                      : "";

                  this.#mode = value === "replace" ? "replace" : "prepend";
                }}
              ></gw-segmented>
            </gw-stack>`
      }
      <gw-button
        slot="actions"
        size="small"
        appearance="plain"
        variant="neutral"
        value="cancel"
        >Cancel</gw-button
      >
      <gw-button
        slot="actions"
        size="small"
        value="publish"
        icon=${phRocketLaunch}
        >Publish</gw-button
      >
    </gw-popover>`;
  }

  #publish(event: Event, entry: Domain.ReleaseEntry) {
    this.#publishing = entry;
    this.#mode = "prepend";

    if (this.#notes !== undefined) this.#notes.value = "";

    this.requestUpdate();
    this.#popover?.show(
      event.currentTarget instanceof Element ? event.currentTarget : undefined,
    );
  }

  #published() {
    const entry = this.#publishing;
    const notes = this.#notes?.value.trim() ?? "";

    this.#publishing = undefined;

    if (
      this.#popover?.returnValue !== "publish" ||
      entry?.snapshot === null ||
      entry === undefined ||
      entry.nextVersion === null
    )
      return;

    registry.set(publishRelease, {
      repo: entry.repo,
      snapshot: entry.snapshot.id,
      tag: entry.nextVersion,
      notes: notes === "" ? null : notes,
      notesMode: this.#mode,
    });
  }

  /** The actions on a comparison: read it again, publish it, or hand it on. */
  #actions(
    entry: Domain.ReleaseEntry,
    snapshot: Domain.ReleaseSnapshot | null,
    workers: Domain.ReleasesPage["workers"],
  ) {
    const now = Date.now();

    const launchers = workers.filter(
      (worker) => worker.launch && now - worker.at < upFor,
    );

    const ready =
      snapshot !== null &&
      !entry.stale &&
      snapshot.complete &&
      entry.nextVersion !== null;

    return html`<gw-row gap="s">
      <gw-button
        size="small"
        appearance="outlined"
        variant="neutral"
        icon=${phArrowClockwise}
        @click=${() => registry.set(refreshRelease, entry.repo)}
        >Compare again</gw-button
      >
      ${
        snapshot === null
          ? nothing
          : this.#impactMenu(
              snapshot.reviewed
                ? `Overall: ${snapshot.suggestion}, chosen`
                : "Choose the overall impact",
              entry,
              snapshot,
              ["overall"],
              snapshot.suggestion,
              snapshot.reviewed,
            )
      }
      ${
        entry.recipe !== null && ready
          ? html`<gw-button
              size="small"
              icon=${phRocketLaunch}
              @click=${(event: Event) => this.#publish(event, entry)}
              >Publish ${entry.nextVersion}</gw-button
            >`
          : nothing
      }
      ${
        snapshot !== null && launchers.length > 0
          ? html`<gw-menu-button
              size="small"
              appearance="outlined"
              icon=${phRobot}
              label="Prepare in an agent"
              heading="Prepare on"
              .items=${launchers.map((worker) => ({
                value: worker.worker,
                label: worker.worker,
              }))}
              @select=${(event: Event) =>
                registry.set(releaseAgent, {
                  repo: entry.repo,
                  snapshot: snapshot.id,
                  worker: chosen(event),
                })}
            ></gw-menu-button>`
          : nothing
      }
    </gw-row>`;
  }

  #detail(page: Domain.ReleasesPage, repo: string) {
    const entry = page.repos.find(
      (each) => each.repo.toLowerCase() === repo.toLowerCase(),
    );

    const back = html`<a href=${releasesHref}
      ><gw-button
        size="small"
        appearance="plain"
        variant="neutral"
        icon=${phArrowLeft}
        >Every repository</gw-button
      ></a
    >`;

    if (entry === undefined)
      return html`<gw-stack gap="l">
        ${back}
        ${empty(phTag, `${repo} isn't tracked for the unreleased job, or hasn't been compared yet.`)}
      </gw-stack>`;

    const snapshot = entry.snapshot;
    const shown = snapshot?.findings.filter(relevant) ?? [];

    const quiet =
      snapshot?.findings.filter((finding) => !relevant(finding)) ?? [];

    return html`<gw-stack gap="l">
      ${back}
      <gw-page-header
        heading=${entry.name}
        description=${`${entry.repo}, comparing ${entry.branch} with its last stable release`}
      ></gw-page-header>
      ${
        entry.error === null
          ? nothing
          : html`<gw-alert tone="warning"
              >${entry.stale ? "Stale: " : ""}${entry.error}</gw-alert
            >`
      }
      <dl>
        ${fact(
          "Last release",
          snapshot?.releaseTag == null
            ? "none yet"
            : externalLink(
                `https://github.com/${entry.repo}/releases/tag/${encodeURIComponent(snapshot.releaseTag)}`,
                snapshot.releaseTag,
              ),
        )}
        ${
          snapshot === null
            ? nothing
            : fact(
                "Compared",
                html`${short(snapshot.head)} on ${entry.branch},
                ${externalLink(snapshot.url, "the comparison")}`,
              )
        }
        ${
          snapshot === null
            ? nothing
            : fact(
                "Suggests",
                html`${suggestion(entry)}
                  <span class="muted"
                    >${snapshot.reviewed ? "your overall choice" : `the policy says ${snapshot.automaticSuggestion}`}</span
                  >`,
              )
        }
        ${fact(
          "Next version",
          entry.nextVersion ??
            html`<span class="muted">${entry.versionError ?? ""}</span>`,
        )}
        ${fact("Numbered by", entry.versioning)}
        ${
          snapshot === null
            ? nothing
            : fact(
                "Checked",
                html`${time(snapshot.checkedAt)}${
                  entry.attemptedAt > snapshot.checkedAt
                    ? html`, tried again ${time(entry.attemptedAt)}`
                    : nothing
                }`,
              )
        }
        ${
          snapshot === null || snapshot.errors.length === 0
            ? nothing
            : fact(
                "Missing",
                html`<ul>
                  ${snapshot.errors.map((error) => html`<li>${error}</li>`)}
                </ul>`,
              )
        }
        ${
          entry.recipe === null
            ? fact(
                "Publishing",
                html`<span class="muted"
                  >not set up; add a publish recipe to the worker's settings, or
                  prepare it in an agent</span
                >`,
              )
            : nothing
        }
      </dl>
      ${this.#actions(entry, snapshot, page.workers)}
      ${
        snapshot === null
          ? nothing
          : html`<gw-section-title
                >Changes worth a release
                <span class="muted">${shown.length}</span></gw-section-title
              >
              ${
                shown.length === 0
                  ? empty(
                      phCheckCircle,
                      "Nothing since the last release needs one.",
                    )
                  : this.#findings(entry, snapshot, shown, "Changes")
              }
              ${
                quiet.length === 0
                  ? nothing
                  : html`<gw-expansion
                      heading=${`Quiet changes (${quiet.length})`}
                      description="Changes the policy says ship nothing, such as docs and tooling"
                      storage-key="upkeep.releases.quiet"
                      .draw=${drawn(() =>
                        this.#findings(entry, snapshot, quiet, "Quiet changes"),
                      )}
                    ></gw-expansion>`
              }
              <gw-section-title
                >Commits
                <span class="muted"
                  >${snapshot.commits.length}</span
                ></gw-section-title
              >
              ${this.#commits(entry, snapshot)}`
      }
    </gw-stack>`;
  }

  #render(page: Domain.ReleasesPage) {
    return html`${
      this.repo === undefined ? this.#list(page) : this.#detail(page, this.repo)
    }
    ${this.#publishPopover()}`;
  }

  override render() {
    return view(this.#page.value, (page) => this.#render(page));
  }
}

customElements.define("upkeep-releases", UpkeepReleases);

declare global {
  interface HTMLElementTagNameMap {
    "upkeep-releases": UpkeepReleases;
  }
}
