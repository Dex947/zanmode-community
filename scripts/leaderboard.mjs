import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'

const REPO = process.env.GITHUB_REPOSITORY ?? 'Dex947/zanmode-community'
const TOKEN = process.env.GITHUB_TOKEN
const API = 'https://api.github.com'

const POINTS = { S: 5, M: 15, L: 40, shortlisted: 10, winner: 25, first: 5, review: 2, answer: 2, confirmed: 3, event: 5 }
const WEEKLY_CAP = 10
const STUDIOS = ['design', 'hardware', 'software', 'test', 'stories']

const headers = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
}

async function getAll(path) {
  const out = []
  let url = `${API}${path}${path.includes('?') ? '&' : '?'}per_page=100`
  while (url) {
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`${res.status} ${url}: ${await res.text()}`)
    const body = await res.json()
    out.push(...(Array.isArray(body) ? body : body.items))
    url = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1]
  }
  return out
}

async function graphql(query, variables) {
  const res = await fetch(`${API}/graphql`, { method: 'POST', headers, body: JSON.stringify({ query, variables }) })
  const body = await res.json()
  if (body.errors) throw new Error(JSON.stringify(body.errors))
  return body.data
}

function seasonOf(date) {
  const year = date.getUTCFullYear()
  const q = Math.floor(date.getUTCMonth() / 3)
  return { id: `${year}-Q${q + 1}`, start: new Date(Date.UTC(year, q * 3, 1)), end: new Date(Date.UTC(year, q * 3 + 3, 1)) }
}

const season = seasonOf(new Date(process.env.LEADERBOARD_DATE ?? Date.now()))
const inSeason = (iso) => iso && new Date(iso) >= season.start && new Date(iso) < season.end

function weekOf(iso) {
  const d = new Date(iso)
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

const labelNames = (item) => item.labels.map((l) => (typeof l === 'string' ? l : l.name).toLowerCase())
const sizeOf = (item) => labelNames(item).find((l) => /^size: ?[sml]$/.test(l))?.slice(-1).toUpperCase()
const studioOf = (item) => labelNames(item).find((l) => l.startsWith('studio:'))?.split(':')[1].trim()
const isBot = (user) => !user || user.type === 'Bot' || user.login.endsWith('[bot]')
const creditedTo = (item) => (item.assignees?.length ? item.assignees : [item.user]).filter((u) => !isBot(u)).map((u) => u.login)

async function labelledAt(item, label) {
  const events = await getAll(`/repos/${REPO}/issues/${item.number}/events`)
  const hits = events.filter((e) => e.event === 'labeled' && e.label?.name.toLowerCase() === label)
  return hits.at(-1)?.created_at
}

const people = new Map()
function person(login) {
  if (!people.has(login)) people.set(login, { login, total: 0, accepted: 0, studios: {}, entries: [], first: false })
  return people.get(login)
}
function award(login, points, reason, url, studio) {
  const p = person(login)
  p.total += points
  if (studio) p.studios[studio] = (p.studios[studio] ?? 0) + points
  p.entries.push({ points, reason, url })
}

const weekly = new Map()
function capped(login, kind, iso, points) {
  const key = `${login}|${kind}|${weekOf(iso)}`
  const used = weekly.get(key) ?? 0
  const allowed = Math.max(0, Math.min(points, WEEKLY_CAP - used))
  weekly.set(key, used + allowed)
  return allowed
}

async function scoreLabelled() {
  const accepted = (await getAll(`/repos/${REPO}/issues?state=all&labels=accepted`)).filter((i) => !labelNames(i).includes('no-points'))
  const firstAccepted = new Map()

  for (const item of accepted) {
    const at = await labelledAt(item, 'accepted')
    if (!at) continue
    for (const login of creditedTo(item)) {
      if (!firstAccepted.has(login) || at < firstAccepted.get(login)) firstAccepted.set(login, at)
    }
    if (!inSeason(at)) continue

    const studio = studioOf(item)
    const names = labelNames(item)
    for (const login of creditedTo(item)) {
      if (names.includes('event')) {
        award(login, POINTS.event, 'Event held', item.html_url)
        continue
      }
      const size = sizeOf(item) ?? 'S'
      award(login, POINTS[size], `Accepted work (${size})`, item.html_url, studio)
      person(login).accepted += 1
      if (names.includes('shortlisted')) award(login, POINTS.shortlisted, 'Shortlisted', item.html_url, studio)
      if (names.includes('winner')) award(login, POINTS.winner, 'Challenge winner', item.html_url, studio)
    }
  }

  for (const [login, at] of firstAccepted) {
    if (!inSeason(at)) continue
    award(login, POINTS.first, 'First accepted work', null)
    person(login).first = true
  }

  const confirmed = (await getAll(`/repos/${REPO}/issues?state=all&labels=confirmed`)).filter((i) => !labelNames(i).includes('no-points'))
  for (const item of confirmed) {
    const at = await labelledAt(item, 'confirmed')
    if (!inSeason(at) || isBot(item.user)) continue
    award(item.user.login, POINTS.confirmed, 'Confirmed report', item.html_url, studioOf(item) ?? 'test')
  }
}

async function scoreReviews() {
  const day = (d) => d.toISOString().slice(0, 10)
  const last = new Date(season.end.getTime() - 86400000)
  const q = encodeURIComponent(`repo:${REPO} is:pr is:merged merged:${day(season.start)}..${day(last)}`)
  const prs = await getAll(`/search/issues?q=${q}`)
  for (const pr of prs) {
    if (labelNames(pr).includes('no-points')) continue
    const reviews = await getAll(`/repos/${REPO}/pulls/${pr.number}/reviews`)
    const reviewers = new Map()
    for (const r of reviews) {
      if (isBot(r.user) || r.user.login === pr.user.login || r.state === 'PENDING') continue
      if (!reviewers.has(r.user.login)) reviewers.set(r.user.login, r.submitted_at)
    }
    for (const [login, at] of reviewers) {
      const points = capped(login, 'review', at, POINTS.review)
      if (points) award(login, points, 'Review', pr.html_url)
    }
  }
}

async function scoreAnswers() {
  const [owner, name] = REPO.split('/')
  let after = null
  do {
    const data = await graphql(
      `query($owner: String!, $name: String!, $after: String) {
        repository(owner: $owner, name: $name) {
          discussions(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { url answerChosenAt author { login } answer { url author { login } } }
          }
        }
      }`,
      { owner, name, after },
    )
    const page = data.repository.discussions
    for (const d of page.nodes) {
      const login = d.answer?.author?.login
      if (!login || !inSeason(d.answerChosenAt) || login === d.author?.login || login.endsWith('[bot]')) continue
      const points = capped(login, 'answer', d.answerChosenAt, POINTS.answer)
      if (points) award(login, points, 'Accepted answer', d.answer.url)
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (after)
}

function scoreManual() {
  const entries = JSON.parse(readFileSync('leaderboard/manual.json', 'utf8'))
  for (const e of entries) {
    if (e.season !== season.id) continue
    award(e.login, e.points, e.reason, e.link ?? null, e.studio)
  }
}

const rank = (list, key) => {
  const sorted = list.filter((p) => key(p) > 0).sort((a, b) => key(b) - key(a) || b.accepted - a.accepted || a.login.localeCompare(b.login))
  let place = 0
  let prev = null
  return sorted.map((p, i) => {
    if (key(p) !== prev) place = i + 1
    prev = key(p)
    return { place, ...p, score: key(p) }
  })
}

function table(rows, limit) {
  if (!rows.length) return '_Nothing yet._\n'
  const lines = ['| | Maker | Points | Accepted |', '|---|---|---|---|']
  for (const r of rows.slice(0, limit)) lines.push(`| ${r.place} | [@${r.login}](https://github.com/${r.login}) | ${r.score} | ${r.accepted} |`)
  return lines.join('\n') + '\n'
}

function markdown(all) {
  const past = readdirSync('leaderboard')
    .filter((f) => /^\d{4}-Q\d\.md$/.test(f) && f !== `${season.id}.md`)
    .map((f) => f.replace('.md', ''))
    .sort()
    .reverse()
  const parts = [
    `# Leaderboard, ${season.id}`,
    '',
    `Updated ${new Date().toISOString().slice(0, 10)}. Points only count once work is accepted. [How it works](RECOGNITION.md).`,
    '',
    '## Overall',
    '',
    table(rank(all, (p) => p.total), 20),
    '## First season',
    '',
    'People whose first accepted work came this season.',
    '',
    table(rank(all.filter((p) => p.first), (p) => p.total), 10),
  ]
  for (const studio of STUDIOS) {
    parts.push(`## ${studio[0].toUpperCase()}${studio.slice(1)}`, '', table(rank(all, (p) => p.studios[studio] ?? 0), 10))
  }
  if (past.length) parts.push('## Past seasons', '', past.map((id) => `- [${id}](leaderboard/${id}.md)`).join('\n'), '')
  return parts.join('\n')
}

async function postToDiscord(all) {
  const url = process.env.DISCORD_WEBHOOK_URL
  if (!url) return
  const top = rank(all, (p) => p.total).slice(0, 5)
  const lines = top.length ? top.map((r) => `${r.place}. ${r.login}: ${r.score} points`).join('\n') : 'Nothing scored yet this season. Pick up a brief.'
  const content = `Leaderboard for ${season.id}\n${lines}\nFull board: https://github.com/${REPO}/blob/main/LEADERBOARD.md`
  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) })
}

await scoreLabelled()
await scoreReviews()
await scoreAnswers()
scoreManual()

const all = [...people.values()]
mkdirSync('leaderboard', { recursive: true })
writeFileSync(
  `leaderboard/${season.id}.json`,
  JSON.stringify({ season: season.id, start: season.start, end: season.end, people: rank(all, (p) => p.total) }, null, 2) + '\n',
)
const md = markdown(all)
writeFileSync(`leaderboard/${season.id}.md`, md.replace('(RECOGNITION.md)', '(../RECOGNITION.md)').replace(/\(leaderboard\//g, '('))
writeFileSync('LEADERBOARD.md', md)
await postToDiscord(all)
console.log(`${season.id}: ${all.length} people scored`)
