import { ExternalLink, GitFork, Star } from "lucide-react"

import { formatCompact, formatDate } from "@/components/audience/format"
import { ShareBars } from "@/components/audience/share-bars"
import { StatTile } from "@/components/audience/stat-tile"
import type { PublicGitHub } from "@/lib/public-profiles/load"

/** A builder's public GitHub stats (§7.1 GitHub row): reach, repositories, languages, activity. */
export function GitHubStatsSection({ github }: { github: PublicGitHub }) {
  const { stats } = github
  return (
    <section aria-labelledby="github-heading" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="github-heading" className="text-lg font-semibold">
          GitHub
        </h2>
        <p className="text-xs text-muted-foreground">
          {github.current ? "Updated " : "Last updated "}
          {formatDate(github.updatedAt)}
          {github.profileUrl ? (
            <>
              {" · "}
              <a
                href={github.profileUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex items-center gap-1 underline-offset-4 hover:text-foreground hover:underline"
              >
                {github.login ? `@${github.login}` : "Profile"} on GitHub
                <ExternalLink className="size-3" aria-hidden="true" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </>
          ) : null}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Followers" value={formatCompact(github.followers)} />
        <StatTile label="Public repositories" value={formatCompact(stats?.publicRepos)} />
        <StatTile label="Stars earned" value={formatCompact(stats?.totalStars)} />
        <StatTile
          label="Contributions"
          value={formatCompact(stats?.contributions.total)}
          note="Last 12 months"
        />
      </dl>

      {stats && stats.topLanguages.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Top languages</h3>
          <ShareBars
            rows={stats.topLanguages.map((language) => ({
              key: language.name,
              label: language.name,
              share: language.share,
            }))}
            caption="Top languages by share of code in public repositories"
            labelHeader="Language"
            valueHeader="Share of code"
          />
        </div>
      ) : null}

      {stats && stats.topRepos.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Popular repositories</h3>
          <ul className="divide-y rounded-xl border bg-card">
            {stats.topRepos.slice(0, 6).map((repo) => (
              <li
                key={repo.url}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-sm"
              >
                <a
                  href={repo.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {repo.name}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
                {repo.language ? (
                  <span className="text-muted-foreground">{repo.language}</span>
                ) : null}
                <span className="ml-auto flex items-center gap-3 text-muted-foreground tabular-nums">
                  <span className="inline-flex items-center gap-1">
                    <Star className="size-3.5" aria-hidden="true" />
                    <span className="sr-only">Stars: </span>
                    {formatCompact(repo.stars)}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <GitFork className="size-3.5" aria-hidden="true" />
                    <span className="sr-only">Forks: </span>
                    {formatCompact(repo.forks)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
