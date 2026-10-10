// Draws assets/activity-{light,dark}.svg from live GitHub data.
// No dependencies: run with `node scripts/build-activity.mjs` (Node 20+).

import { mkdirSync, writeFileSync } from "node:fs"

const USER = process.env.GITHUB_USER || "kenawak"
const TOKEN = process.env.GITHUB_TOKEN

const THEMES = {
  light: { ground: "#f8f2e9", ink: "#3a3028", muted: "#6e6155", line: "#e2d3c1", accent: "#c97e62" },
  dark: { ground: "#241d18", ink: "#f1e7da", muted: "#b7a593", line: "#4b3c31", accent: "#c97e62" },
}

const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

const WIDTH = 840
const PAD = 24
const CELL = 11
const GAP = 3

/** Daily counts for the last year, oldest first. */
async function getContributions() {
  const res = await fetch(`https://github-contributions-api.jogruber.de/v4/${USER}?y=last`)
  if (!res.ok) throw new Error(`contributions request failed: ${res.status}`)
  const data = await res.json()
  return data.contributions
}

/** Bytes of code per language across the user's own repositories. */
async function getLanguages() {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": USER }
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`

  const res = await fetch(`https://api.github.com/users/${USER}/repos?per_page=100&type=owner`, { headers })
  if (!res.ok) throw new Error(`repos request failed: ${res.status}`)
  const repos = (await res.json()).filter((repo) => !repo.fork)

  const totals = new Map()
  for (const repo of repos) {
    const langs = await fetch(repo.languages_url, { headers })
    if (!langs.ok) continue
    for (const [name, bytes] of Object.entries(await langs.json())) {
      totals.set(name, (totals.get(name) ?? 0) + bytes)
    }
  }

  const sum = [...totals.values()].reduce((a, b) => a + b, 0)
  if (!sum) return []

  const sorted = [...totals].sort((a, b) => b[1] - a[1])
  const top = sorted.slice(0, 5).map(([name, bytes]) => ({ name, share: bytes / sum }))
  const rest = sorted.slice(5).reduce((a, [, bytes]) => a + bytes, 0)
  if (rest) top.push({ name: "Other", share: rest / sum })
  return top
}

/** Totals and streaks. Today may still be empty, so it cannot break a streak. */
function summarise(days) {
  let total = 0
  let active = 0
  let busiest = null
  let longest = null
  let run = null

  for (const day of days) {
    total += day.count
    if (day.count === 0) {
      run = null
      continue
    }
    active += 1
    if (!busiest || day.count > busiest.count) busiest = day
    run = run ? { days: run.days + 1, start: run.start, end: day.date } : { days: 1, start: day.date, end: day.date }
    if (!longest || run.days > longest.days) longest = run
  }

  let i = days.length - 1
  if (i >= 0 && days[i].count === 0) i -= 1
  let current = null
  if (i >= 0 && days[i].count > 0) {
    let n = 0
    while (i >= 0 && days[i].count > 0) {
      n += 1
      i -= 1
    }
    current = { days: n, start: days[i + 1].date }
  }

  return { total, active, totalDays: days.length, busiest, longest, current }
}

const day = (iso) => {
  const [y, m, d] = iso.split("-").map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")

function draw(theme, days, stats, languages) {
  const t = THEMES[theme]
  const out = []

  // Weeks run left to right, Sunday at the top.
  const first = new Date(`${days[0].date}T00:00:00Z`).getUTCDay()
  const weeks = Math.ceil((first + days.length) / 7)
  const graphWidth = weeks * (CELL + GAP) - GAP
  const gx = Math.round((WIDTH - graphWidth) / 2)
  const gy = 78

  const label = (x, y, text, anchor = "start") =>
    `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="10" letter-spacing=".08em" fill="${t.muted}">${esc(text.toUpperCase())}</text>`
  const value = (x, y, text) => `<text x="${x}" y="${y}" font-size="14" fill="${t.ink}">${esc(text)}</text>`
  const note = (x, y, text) => `<text x="${x}" y="${y}" font-size="12" fill="${t.muted}">${esc(text)}</text>`

  out.push(label(PAD, 34, "Activity"), label(WIDTH - PAD, 34, `github.com/${USER}`, "end"))

  let lastMonth = -1
  days.forEach((d, index) => {
    const slot = first + index
    const week = Math.floor(slot / 7)
    const x = gx + week * (CELL + GAP)
    const y = gy + (slot % 7) * (CELL + GAP)
    const month = Number(d.date.slice(5, 7)) - 1

    if (month !== lastMonth && slot % 7 === 0) {
      lastMonth = month
      if (week < weeks - 2) out.push(`<text x="${x}" y="${gy - 10}" font-size="10" fill="${t.muted}">${MONTHS[month]}</text>`)
    }

    const fill = d.level === 0 ? t.ink : t.accent
    const opacity = [0.07, 0.3, 0.55, 0.8, 1][d.level] ?? 1
    out.push(`<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" fill="${fill}" fill-opacity="${opacity}"/>`)
  })

  // The table, in the cells of a drawing's title block.
  const tableY = gy + 7 * (CELL + GAP) + 18
  const rowH = 66
  const colW = WIDTH / 3
  const cells = [
    ["Contributions", stats.total.toLocaleString("en-US"), "in the last year"],
    ["Active days", String(stats.active), `of ${stats.totalDays} days`],
    ["Busiest day", stats.busiest ? plural(stats.busiest.count, "contribution") : "None yet", stats.busiest ? day(stats.busiest.date) : ""],
    ["Current streak", stats.current ? plural(stats.current.days, "day") : "None right now", stats.current ? `since ${day(stats.current.start)}` : ""],
    ["Longest streak", stats.longest ? plural(stats.longest.days, "day") : "None yet", stats.longest ? `${day(stats.longest.start)} – ${day(stats.longest.end)}` : ""],
    ["Range", day(days[0].date), `to ${day(days[days.length - 1].date)}`],
  ]

  const rules = [`M0 ${tableY}.5H${WIDTH}`, `M0 ${tableY + rowH}.5H${WIDTH}`, `M${colW}.5 ${tableY}V${tableY + rowH * 2}`, `M${colW * 2}.5 ${tableY}V${tableY + rowH * 2}`]

  cells.forEach(([name, main, sub], index) => {
    const x = (index % 3) * colW + PAD
    const y = tableY + Math.floor(index / 3) * rowH
    out.push(label(x, y + 22, name), value(x, y + 42, main), note(x, y + 58, sub))
  })

  let height = tableY + rowH * 2

  if (languages.length) {
    const ly = height
    rules.push(`M0 ${ly}.5H${WIDTH}`)
    out.push(label(PAD, ly + 22, "Languages"))

    const barW = WIDTH - PAD * 2
    let x = PAD
    languages.forEach((lang, index) => {
      const w = Math.max(2, Math.round(lang.share * barW))
      const opacity = lang.name === "Other" ? 0.18 : Math.max(0.3, 1 - index * 0.17)
      out.push(`<rect x="${x}" y="${ly + 32}" width="${Math.min(w, PAD + barW - x)}" height="8" fill="${lang.name === "Other" ? t.ink : t.accent}" fill-opacity="${opacity}"/>`)
      x += w
    })

    const text = languages.map((lang) => `${lang.name} ${Math.round(lang.share * 100)}%`).join("  ·  ")
    out.push(note(PAD, ly + 60, text))
    height = ly + 76
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${esc(`${stats.total} GitHub contributions in the last year`)}" font-family="${MONO}">
<clipPath id="frame"><rect width="${WIDTH}" height="${height}" rx="12"/></clipPath>
<g clip-path="url(#frame)">
<rect width="${WIDTH}" height="${height}" fill="${t.ground}"/>
<path d="${rules.join("")}" stroke="${t.line}" fill="none"/>
${out.join("\n")}
</g>
</svg>
`
}

const days = await getContributions()
const stats = summarise(days)

// The card is still worth drawing if the language lookup fails.
let languages = []
try {
  languages = await getLanguages()
} catch (error) {
  console.warn(String(error))
}

mkdirSync("assets", { recursive: true })
for (const theme of Object.keys(THEMES)) {
  writeFileSync(`assets/activity-${theme}.svg`, draw(theme, days, stats, languages))
}

console.log(`${stats.total} contributions, ${languages.length} language rows`)
