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

/** Contributions per calendar week (Sunday first), oldest first. */
function byWeek(days) {
  const first = new Date(`${days[0].date}T00:00:00Z`).getUTCDay()
  const weeks = []
  days.forEach((d, index) => {
    const week = Math.floor((first + index) / 7)
    weeks[week] ??= { start: d.date, count: 0 }
    weeks[week].count += d.count
  })
  return weeks
}

/** Contributions per day of the week, Sunday first. */
function byWeekday(days) {
  const totals = [0, 0, 0, 0, 0, 0, 0]
  for (const d of days) totals[new Date(`${d.date}T00:00:00Z`).getUTCDay()] += d.count
  return totals
}

/**
 * A smooth path through the points that never overshoots them (monotone
 * cubic), so the line cannot dip below zero between two quiet weeks.
 */
function smoothPath(points) {
  const n = points.length
  const dx = []
  const slope = []
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1][0] - points[i][0]
    slope[i] = (points[i + 1][1] - points[i][1]) / dx[i]
  }

  const tangent = [slope[0]]
  for (let i = 1; i < n - 1; i++) {
    tangent[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2
  }
  tangent[n - 1] = slope[n - 2]

  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      tangent[i] = 0
      tangent[i + 1] = 0
      continue
    }
    const a = tangent[i] / slope[i]
    const b = tangent[i + 1] / slope[i]
    const h = Math.hypot(a, b)
    if (h > 3) {
      tangent[i] = (3 / h) * a * slope[i]
      tangent[i + 1] = (3 / h) * b * slope[i]
    }
  }

  const f = (v) => v.toFixed(1)
  let d = `M${f(points[0][0])} ${f(points[0][1])}`
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]
    const [x1, y1] = points[i + 1]
    d += `C${f(x0 + dx[i] / 3)} ${f(y0 + (tangent[i] * dx[i]) / 3)} ${f(x1 - dx[i] / 3)} ${f(y1 - (tangent[i + 1] * dx[i]) / 3)} ${f(x1)} ${f(y1)}`
  }
  return d
}

/** Rounds a maximum up to a tidy axis value. */
function niceMax(value) {
  const step = 10 ** Math.floor(Math.log10(Math.max(value, 1)))
  return Math.ceil(value / (step / 2)) * (step / 2)
}

function draw(theme, days, stats, languages) {
  const t = THEMES[theme]
  const out = []
  const rules = []

  const label = (x, y, text, anchor = "start") =>
    `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="10" letter-spacing=".08em" fill="${t.muted}">${esc(text.toUpperCase())}</text>`
  const value = (x, y, text) => `<text x="${x}" y="${y}" font-size="14" fill="${t.ink}">${esc(text)}</text>`
  const note = (x, y, text) => `<text x="${x}" y="${y}" font-size="12" fill="${t.muted}">${esc(text)}</text>`
  const tick = (x, y, text, anchor = "start") =>
    `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="10" fill="${t.muted}">${esc(text)}</text>`

  out.push(
    label(PAD, 34, `Contributions per week · ${day(days[0].date)} – ${day(days[days.length - 1].date)}`),
    label(WIDTH - PAD, 34, `github.com/${USER}`, "end")
  )

  // 1. Weekly line chart. GitHub already draws the day-by-day grid under a
  //    profile README, so this shows the shape of the year instead.
  const weeks = byWeek(days)
  const top = niceMax(Math.max(...weeks.map((w) => w.count)))
  const cx = PAD + 30
  const cy = 58
  const cw = WIDTH - PAD - cx
  const ch = 116
  const px = (i) => cx + (i / (weeks.length - 1)) * cw
  const py = (count) => cy + ch - (count / top) * ch

  for (const fraction of [0, 0.5, 1]) {
    const y = Math.round(cy + ch - fraction * ch) + 0.5
    out.push(
      `<path d="M${cx} ${y}H${cx + cw}" stroke="${t.line}" ${fraction === 0 ? "" : 'stroke-dasharray="4 4"'}/>`,
      tick(cx - 8, y + 3.5, String(Math.round(top * fraction)), "end")
    )
  }

  let lastMonth = -1
  weeks.forEach((week, index) => {
    const month = Number(week.start.slice(5, 7)) - 1
    if (month !== lastMonth) {
      lastMonth = month
      if (index > 0 && index < weeks.length - 2) out.push(tick(px(index), cy + ch + 18, MONTHS[month]))
    }
  })

  const points = weeks.map((week, index) => [px(index), py(week.count)])
  const line = smoothPath(points)
  const peak = weeks.reduce((best, week, index) => (week.count > weeks[best].count ? index : best), 0)
  const last = weeks.length - 1

  out.push(
    `<path class="area" d="${line}L${px(last).toFixed(1)} ${cy + ch}L${cx} ${cy + ch}Z" fill="url(#fade-${theme})"/>`,
    `<path class="line" d="${line}" pathLength="1" fill="none" stroke="${t.accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
  )

  const dot = (index) =>
    `<circle class="dot" cx="${px(index).toFixed(1)}" cy="${py(weeks[index].count).toFixed(1)}" r="4" fill="${t.accent}" stroke="${t.ground}" stroke-width="2"/>`
  const peakAnchor = px(peak) > WIDTH - 140 ? "end" : px(peak) < 140 ? "start" : "middle"
  out.push(
    dot(peak),
    `<text class="dot" x="${px(peak).toFixed(1)}" y="${(py(weeks[peak].count) - 10).toFixed(1)}" text-anchor="${peakAnchor}" font-size="10" fill="${t.ink}">${weeks[peak].count} in the week of ${esc(day(weeks[peak].start))}</text>`
  )
  if (last !== peak) out.push(dot(last))

  // 2. The table, in the cells of a drawing's title block.
  const tableY = cy + ch + 36
  const rowH = 66
  const colW = WIDTH / 3
  const cells = [
    ["Contributions", stats.total.toLocaleString("en-US"), "in the last year"],
    ["Active days", String(stats.active), `of ${stats.totalDays} days`],
    ["Busiest day", stats.busiest ? plural(stats.busiest.count, "contribution") : "None yet", stats.busiest ? day(stats.busiest.date) : ""],
    ["Current streak", stats.current ? plural(stats.current.days, "day") : "None right now", stats.current ? `since ${day(stats.current.start)}` : ""],
    ["Longest streak", stats.longest ? plural(stats.longest.days, "day") : "None yet", stats.longest ? `${day(stats.longest.start)} – ${day(stats.longest.end)}` : ""],
    ["Best week", plural(weeks[peak].count, "contribution"), `week of ${day(weeks[peak].start)}`],
  ]

  rules.push(`M0 ${tableY}.5H${WIDTH}`, `M0 ${tableY + rowH}.5H${WIDTH}`, `M${colW}.5 ${tableY}V${tableY + rowH * 2}`, `M${colW * 2}.5 ${tableY}V${tableY + rowH * 2}`)

  cells.forEach(([name, main, sub], index) => {
    const x = (index % 3) * colW + PAD
    const y = tableY + Math.floor(index / 3) * rowH
    out.push(label(x, y + 22, name), value(x, y + 42, main), note(x, y + 58, sub))
  })

  // 3. Rhythm of the week on the left, languages on the right.
  const by = tableY + rowH * 2
  const bottomH = 112
  rules.push(`M0 ${by}.5H${WIDTH}`)

  const weekdays = byWeekday(days)
  const busiest = weekdays.indexOf(Math.max(...weekdays))
  const barW = 22
  const barGap = 11
  const barMax = 44
  const barBase = by + 86
  out.push(label(PAD, by + 22, "By weekday"))
  weekdays.forEach((count, index) => {
    const h = Math.max(2, Math.round((count / weekdays[busiest]) * barMax))
    const x = PAD + index * (barW + barGap)
    out.push(
      `<rect class="bar" x="${x}" y="${barBase - h}" width="${barW}" height="${h}" fill="${t.accent}" fill-opacity="${index === busiest ? 1 : 0.4}"/>`,
      tick(x + barW / 2, barBase + 14, "SMTWTFS"[index], "middle")
    )
  })
  out.push(tick(PAD + busiest * (barW + barGap) + barW / 2, barBase - barMax - 5, String(weekdays[busiest]), "middle"))

  if (languages.length) {
    const lx = colW + PAD
    const lw = WIDTH - PAD - lx
    rules.push(`M${colW}.5 ${by}V${by + bottomH}`)
    out.push(label(lx, by + 22, "Languages"))

    let x = lx
    languages.forEach((lang, index) => {
      const w = Math.max(2, Math.round(lang.share * lw))
      const opacity = lang.name === "Other" ? 0.18 : Math.max(0.3, 1 - index * 0.17)
      out.push(`<rect x="${x}" y="${by + 38}" width="${Math.min(w, lx + lw - x)}" height="8" fill="${lang.name === "Other" ? t.ink : t.accent}" fill-opacity="${opacity}"/>`)
      x += w
    })

    // Two rows of three, so long names never run into each other.
    languages.forEach((lang, index) => {
      const col = index % 3
      const row = Math.floor(index / 3)
      out.push(note(lx + col * (lw / 3), by + 70 + row * 20, `${lang.name} ${Math.round(lang.share * 100)}%`))
    })
  }

  const height = by + bottomH

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${esc(`${stats.total} GitHub contributions in the last year, charted by week`)}" font-family="${MONO}">
<style>
  @keyframes draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
  @keyframes appear { from { opacity: 0; } to { opacity: 1; } }
  @keyframes grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }
  .line { stroke-dasharray: 1; animation: draw 1.8s cubic-bezier(.2, .7, .2, 1) both; }
  .area { animation: appear 1s ease-out 1s both; }
  .dot { animation: appear .4s ease-out 1.7s both; }
  .bar { transform-box: fill-box; transform-origin: 50% 100%; animation: grow .7s cubic-bezier(.2, .7, .2, 1) .3s both; }
  @media (prefers-reduced-motion: reduce) { .line, .area, .dot, .bar { animation: none; } }
</style>
<defs>
  <clipPath id="frame-${theme}"><rect width="${WIDTH}" height="${height}" rx="12"/></clipPath>
  <linearGradient id="fade-${theme}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${t.accent}" stop-opacity=".3"/>
    <stop offset="1" stop-color="${t.accent}" stop-opacity="0"/>
  </linearGradient>
</defs>
<g clip-path="url(#frame-${theme})">
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
