/**
 * Hermes Command Center — desktop plugin.
 *
 * Read-only health + activity dashboard for your Hermes instance. Six tabs:
 *   - Overview  : processes, today's tokens, cron health, errors, memory fill
 *   - Cron      : job definitions + recent executions
 *   - Plugins   : installed backend + desktop plugins
 *   - Models    : per-model token/cost breakdown + 15-day trend
 *   - Skills    : skill usage stats
 *   - Memory    : always-on memory + fact store health
 *
 * Backed by the command-center dashboard plugin API (mounted at
 * /api/plugins/command-center/). Plain ESM loaded uncompiled: UI is jsx()
 * calls, NOT JSX syntax; only @hermes/plugin-sdk, react, react/jsx-runtime
 * resolve. Read-only — never writes state.
 */

import {
  Badge,
  Button,
  cn,
  Codicon,
  EmptyState,
  ErrorState,
  haptic,
  host,
  relativeTime,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  PALETTE_AREA,
  Skeleton,
  useQuery
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useState } from 'react'

const ID = 'command-center'
const TABS = ['overview', 'activity', 'usage', 'tools', 'cron', 'plugins', 'models', 'skills', 'memory', 'system']

// Fixed accent palette (deliberately NOT theme accent so each section stays
// distinguishable, same approach as the achievements sections).
const ACCENTS = {
  green: { key: 'green', text: '#2f9e63', bg: 'rgba(47,158,99,0.12)' },
  blue: { key: 'blue', text: '#2f7fd4', bg: 'rgba(47,127,212,0.12)' },
  teal: { key: 'teal', text: '#0f9a9a', bg: 'rgba(15,154,154,0.12)' },
  gold: { key: 'gold', text: '#b7791f', bg: 'rgba(183,121,31,0.12)' },
  purple: { key: 'purple', text: '#7b5fd9', bg: 'rgba(123,95,217,0.12)' },
  rose: { key: 'rose', text: '#d4578f', bg: 'rgba(212,87,143,0.12)' },
  red: { key: 'red', text: '#d64545', bg: 'rgba(214,69,69,0.12)' },
  idle: { key: 'idle', text: '#8a8f98', bg: 'rgba(138,143,152,0.12)' }
}

const TAB_META = {
  overview: { icon: 'dashboard', accent: ACCENTS.blue },
  activity: { icon: 'history', accent: ACCENTS.rose },
  usage: { icon: 'graph-line', accent: ACCENTS.gold },
  tools: { icon: 'tools', accent: ACCENTS.teal },
  cron: { icon: 'clock', accent: ACCENTS.teal },
  plugins: { icon: 'plug', accent: ACCENTS.purple },
  models: { icon: 'graph', accent: ACCENTS.gold },
  skills: { icon: 'book', accent: ACCENTS.green },
  memory: { icon: 'database', accent: ACCENTS.rose },
  system: { icon: 'server', accent: ACCENTS.blue }
}

// ── helpers ────────────────────────────────────────────────────────────────

function fmtNum(n) {
  if (n == null) return '0'
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(Math.round(n))
}

function fmtDate(ts) {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function fmtTime(ms) {
  if (!ms) return '—'
  const d = new Date(ms > 1e11 ? ms : ms * 1000)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ── injected polish CSS (fade-up, shimmer, glow) ──────────────────────────

const POLISH_CSS = `
.hc-fade-up { animation: hcFadeUp .45s cubic-bezier(.22,.9,.35,1) both; }
@keyframes hcFadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.hc-shimmer { position: relative; overflow: hidden; }
.hc-shimmer::after { content: ''; position: absolute; inset: 0; transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, rgba(255,255,255,.35), transparent); animation: hcShimmer 1.6s infinite; }
@keyframes hcShimmer { 100% { transform: translateX(100%); } }
.hc-glow { transition: box-shadow .25s ease; }
.hc-glow:hover { box-shadow: 0 0 0 1px rgba(123,95,217,.15), 0 12px 40px -8px rgba(123,95,217,.25); }
.hc-ring-track { stroke: var(--hc-track, rgba(127,127,127,.14)); }
.hc-ring-value { transition: stroke-dashoffset 1s cubic-bezier(.22,.9,.35,1); }
.hc-bar-gradient { transition: height 1s cubic-bezier(.22,.9,.35,1); }
`

// Injected once per mount; idempotent.
function usePolishCss() {
  useEffect(() => {
    let el = document.getElementById('hermes-center-polish')
    if (!el) {
      el = document.createElement('style')
      el.id = 'hermes-center-polish'
      el.textContent = POLISH_CSS
      document.head.appendChild(el)
    }
    return () => {
      // Leave the style in place across tab switches; remove on unmount is
      // fine to skip — the page component lives for the whole session.
    }
  }, [])
}

// ── health ring ────────────────────────────────────────────────────────────

// Circular ring with a gradient stroke and a centered value.
function RingGauge({ value, max, label, sub, from, to, size }) {
  const s = size || 64
  const stroke = 6
  const r = (s - stroke) / 2
  const c = 2 * Math.PI * r
  const pct = Math.min(100, Math.round((value / max) * 100))
  const off = c * (1 - pct / 100)
  const gid = 'hc-ring-' + Math.abs(hashCode(label))
  return jsxs('div', {
    className: 'relative inline-flex items-center justify-center',
    style: { width: s, height: s },
    children: [
      jsxs('svg', {
        width: s,
        height: s,
        className: '-rotate-90',
        children: [
          jsx('defs', {
            children: jsx('linearGradient', {
              id: gid,
              x1: '0%',
              y1: '0%',
              x2: '100%',
              y2: '100%',
              children: [
                jsx('stop', { offset: '0%', stopColor: from }),
                jsx('stop', { offset: '100%', stopColor: to })
              ]
            })
          }),
          jsx('circle', { cx: s / 2, cy: s / 2, r, fill: 'none', strokeWidth: stroke, className: 'hc-ring-track' }),
          jsx('circle', {
            cx: s / 2,
            cy: s / 2,
            r,
            fill: 'none',
            strokeWidth: stroke,
            strokeLinecap: 'round',
            stroke: `url(#${gid})`,
            strokeDasharray: c,
            strokeDashoffset: off,
            className: 'hc-ring-value'
          })
        ]
      }),
      jsxs('div', {
        className: 'absolute inset-0 flex flex-col items-center justify-center',
        children: [
          jsx('span', { className: 'text-sm font-bold tabular-nums text-(--ui-text-primary)', children: `${pct}%` }),
          label ? jsx('span', { className: 'text-[0.5rem] uppercase tracking-wide text-(--ui-text-quaternary)', children: label }) : null
        ]
      })
    ]
  })
}

function hashCode(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0
  return Math.abs(h)
}

// ── area chart (SVG) ───────────────────────────────────────────────────────

// Smooth gradient area chart for the daily token trend.
function AreaChart({ daily, height, from, to }) {
  const h = height || 120
  const w = 640
  const pad = 4
  const max = Math.max(...daily.map(d => d.tokens), 1)
  const n = daily.length
  const step = n > 1 ? (w - pad * 2) / (n - 1) : w / 2
  const pts = daily.map((d, i) => ({
    x: pad + i * step,
    y: h - pad - (d.tokens / max) * (h - pad * 2)
  }))
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${h} L${pts[0].x.toFixed(1)},${h} Z`
  const gid = 'hc-area-' + Math.abs(hashCode(String(daily.length) + from))
  const last = pts[pts.length - 1]

  return jsxs('svg', {
    viewBox: `0 0 ${w} ${h}`,
    className: 'w-full',
    preserveAspectRatio: 'none',
    style: { height },
    children: [
      jsx('defs', {
        children: jsx('linearGradient', {
          id: gid,
          x1: '0%',
          y1: '0%',
          x2: '0%',
          y2: '100%',
          children: [
            jsx('stop', { offset: '0%', stopColor: from, stopOpacity: 0.35 }),
            jsx('stop', { offset: '100%', stopColor: to, stopOpacity: 0.02 })
          ]
        })
      }),
      jsx('path', { d: area, fill: `url(#${gid})` }),
      jsx('path', { d: line, fill: 'none', stroke: from, strokeWidth: 2, strokeLinecap: 'round' }),
      last ? jsx('circle', { cx: last.x, cy: last.y, r: 4, fill: from, className: 'hc-glow' }) : null
    ]
  })
}

// ── shared visual atoms ────────────────────────────────────────────────────

// Icon chip: rounded square with a gradient background + white icon.
// Gradient + white glyph reads clearly at small sizes (the tinted bg +
// colored glyph approach washed out the icon on some accents).
function IconChip({ codicon, accent, size }) {
  const s = size || 'h-8 w-8'
  const grad = {
    green: 'linear-gradient(135deg, #2f9e63 0%, #3ecf8e 100%)',
    blue: 'linear-gradient(135deg, #2f7fd4 0%, #5aa7f0 100%)',
    teal: 'linear-gradient(135deg, #0f9a9a 0%, #2fc4c4 100%)',
    gold: 'linear-gradient(135deg, #b7791f 0%, #e0a63d 100%)',
    purple: 'linear-gradient(135deg, #7b5fd9 0%, #a48cf0 100%)',
    rose: 'linear-gradient(135deg, #d4578f 0%, #f07ab0 100%)',
    red: 'linear-gradient(135deg, #d64545 0%, #f07070 100%)',
    idle: 'linear-gradient(135deg, #8a8f98 0%, #b0b5bd 100%)'
  }
  return jsx('div', {
    className: cn('flex shrink-0 items-center justify-center rounded-lg text-white', s),
    style: {
      background: grad[accent.key] || 'linear-gradient(135deg, #7b5fd9 0%, #a48cf0 100%)',
      boxShadow: '0 4px 10px rgba(0,0,0,0.18)'
    },
    children: jsx(Codicon, { name: codicon, className: 'text-base leading-none' })
  })
}

// Status pill with a glowing dot.
function StatusPill({ tone, children }) {
  const toneMeta = {
    ok: { color: '#2f9e63', bg: 'rgba(47,158,99,0.12)' },
    warn: { color: '#b7791f', bg: 'rgba(183,121,31,0.12)' },
    err: { color: '#d64545', bg: 'rgba(214,69,69,0.12)' },
    idle: { color: '#8a8f98', bg: 'rgba(138,143,152,0.12)' }
  }[tone] || { color: '#8a8f98', bg: 'rgba(138,143,152,0.12)' }

  return jsxs('span', {
    className: 'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.625rem] font-medium',
    style: { backgroundColor: toneMeta.bg, color: toneMeta.color },
    children: [
      jsx('span', {
        className: 'h-1.5 w-1.5 rounded-full',
        style: {
          backgroundColor: toneMeta.color,
          boxShadow: `0 0 6px 1px ${toneMeta.color}55`
        }
      }),
      children
    ]
  })
}

// ── health hover card ──────────────────────────────────────────────────────

// Floating card that explains what the health score means. Appears on hover
// of the health ring; uses the opaque elevated surface so text stays readable
// over any background.
function HealthBreakdown({ health, factors }) {
  const [open, setOpen] = useState(false)
  const totalPenalty = factors.reduce((acc, f) => acc + (f.ok ? 0 : f.penalty), 0)
  return jsxs('div', {
    className: 'relative',
    onMouseEnter: () => setOpen(true),
    onMouseLeave: () => setOpen(false),
    children: [
      jsx('button', {
        type: 'button',
        className: 'flex items-center gap-1.5 rounded-lg px-2 py-1 text-[0.625rem] font-medium text-(--ui-text-quaternary) transition-colors hover:bg-(--ui-bg-quaternary) hover:text-(--ui-text-secondary)',
        children: [
          jsx(Codicon, { name: 'info', className: 'text-xs' }),
          'What is this?'
        ]
      }),
      open
        ? jsxs('div', {
            className: 'absolute right-0 top-full z-30 mt-2 w-80 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) p-4 shadow-xl',
            children: [
              jsxs('div', {
                className: 'mb-3 flex items-baseline justify-between gap-2',
                children: [
                  jsx('span', { className: 'text-sm font-bold text-(--ui-text-primary)', children: 'Health score' }),
                  jsx('span', { className: 'text-xs font-semibold tabular-nums text-(--ui-text-secondary)', children: `${health}%` })
                ]
              }),
              jsx('p', {
                className: 'mb-3 text-[0.6875rem] leading-relaxed text-(--ui-text-tertiary)',
                children: 'A composite of your instance, starting at 100 and deducting points for issues. Anything above 80 means everything important is working.'
              }),
              jsxs('div', {
                className: 'flex flex-col gap-1.5',
                children: factors.map(f =>
                  jsxs('div', {
                    key: f.label,
                    className: 'flex items-start gap-2',
                    children: [
                      jsx('span', {
                        className: cn(
                          'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[0.5rem] font-bold text-white',
                          f.ok ? 'bg-(--ui-ok)' : 'bg-(--ui-error)'
                        ),
                        children: f.ok ? '✓' : '−'
                      }),
                      jsxs('div', {
                        className: 'min-w-0 flex-1',
                        children: [
                          jsxs('div', {
                            className: 'flex items-center justify-between gap-2',
                            children: [
                              jsx('span', { className: 'text-[0.6875rem] font-medium text-(--ui-text-primary)', children: f.label }),
                              f.penalty > 0
                                ? jsx('span', { className: 'text-[0.625rem] font-semibold tabular-nums text-(--ui-error)', children: `−${f.penalty}` })
                                : jsx('span', { className: 'text-[0.625rem] text-(--ui-text-quaternary)', children: 'ok' })
                            ]
                          }),
                          jsx('span', { className: 'text-[0.625rem] leading-snug text-(--ui-text-tertiary)', children: f.desc })
                        ]
                      })
                    ]
                  })
                )
              }),
              totalPenalty > 0
                ? jsx('div', {
                    className: 'mt-3 border-t border-(--ui-stroke-secondary) pt-2 text-[0.625rem] text-(--ui-text-quaternary)',
                    children: `Total deductions: −${totalPenalty}`
                  })
                : null
            ]
          })
        : null
    ]
  })
}

// ── hero header ────────────────────────────────────────────────────────────

function HeroHeader({ processes, onRefresh, health, healthColor, factors }) {
  const live = processes && processes.length > 0
  return jsxs('div', {
    className: 'relative rounded-2xl border border-(--ui-stroke-secondary) p-6',
    style: {
      background:
        'linear-gradient(135deg, rgba(123,95,217,0.14) 0%, rgba(212,87,143,0.10) 45%, rgba(47,127,212,0.10) 100%)'
    },
    children: [
      // soft decorative blobs — clipped by an inner rounded layer so the
      // hero keeps its border radius WITHOUT overflow-hidden (which would
      // clip the HealthBreakdown dropdown below).
      jsx('div', {
        className: 'pointer-events-none absolute inset-0 overflow-hidden rounded-2xl',
        children: [
          jsx('div', {
            className: 'absolute -right-8 -top-10 h-40 w-40 rounded-full',
            style: { background: 'radial-gradient(circle, rgba(212,87,143,0.18) 0%, transparent 70%)' }
          }),
          jsx('div', {
            className: 'absolute -bottom-12 right-24 h-36 w-36 rounded-full',
            style: { background: 'radial-gradient(circle, rgba(47,127,212,0.16) 0%, transparent 70%)' }
          })
        ]
      }),
      jsxs('div', {
        className: 'relative flex items-center gap-4',
        children: [
          jsx('div', {
            className: 'flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-white',
            style: { background: 'linear-gradient(135deg, #7b5fd9 0%, #d4578f 100%)', boxShadow: '0 8px 24px rgba(123,95,217,0.35)' },
            children: jsx(Codicon, { name: 'dashboard', className: 'text-2xl' })
          }),
          jsxs('div', {
            className: 'min-w-0 flex-1',
            children: [
              jsx('div', { className: 'text-lg font-bold tracking-tight text-(--ui-text-primary)', children: 'Hermes Center' }),
              jsx('div', { className: 'truncate text-xs text-(--ui-text-tertiary)', children: 'Your Hermes instance at a glance, refreshed every 30 seconds.' })
            ]
          }),
          health != null && healthColor
            ? jsxs('div', {
                className: 'flex shrink-0 items-center gap-2',
                children: [
                  jsx(RingGauge, {
                    value: health,
                    max: 100,
                    label: 'health',
                    from: healthColor[0],
                    to: healthColor[1],
                    size: 56
                  }),
                  jsxs('div', {
                    className: 'flex flex-col gap-1',
                    children: [
                      live
                        ? jsx(StatusPill, { tone: 'ok', children: 'Live' })
                        : jsx(StatusPill, { tone: 'idle', children: 'Offline' }),
                      jsx(HealthBreakdown, { health, factors: factors || [] })
                    ]
                  })
                ]
              })
            : null
        ]
      })
    ]
  })
}

// ── stat card ──────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, icon, accent, pulse, index }) {
  return jsxs('div', {
    className: cn(
      'hc-glow group relative flex flex-col gap-2 overflow-hidden rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) p-4 transition-all hover:-translate-y-0.5 hover:shadow-lg',
      'hc-fade-up'
    ),
    style: index != null ? { animationDelay: `${index * 40}ms` } : null,
    children: [
      jsxs('div', {
        className: 'flex items-start justify-between gap-2',
        children: [
          jsx('span', { className: 'text-[0.625rem] font-medium uppercase tracking-wider text-(--ui-text-quaternary)', children: label }),
          icon && accent ? jsx(IconChip, { codicon: icon, accent, size: 'h-7 w-7' }) : null
        ]
      }),
      jsx('span', {
        className: cn('truncate text-xl font-bold tabular-nums', pulse && 'animate-pulse'),
        style: { color: accent ? accent.text : undefined },
        title: typeof value === 'string' && value.length > 20 ? value : undefined,
        children: value
      }),
      sub ? jsx('span', { className: 'truncate text-[0.625rem] text-(--ui-text-tertiary)', children: sub }) : null
    ]
  })
}

// ── section wrapper ────────────────────────────────────────────────────────

function Section({ title, icon, accent, children, extra }) {
  return jsxs('div', {
    className: 'mb-4 overflow-hidden rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-chrome)',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2.5 border-b border-(--ui-stroke-secondary) px-4 py-2.5',
        children: [
          icon && accent ? jsx(IconChip, { codicon: icon, accent, size: 'h-6 w-6' }) : null,
          jsx('span', { className: 'text-xs font-semibold text-(--ui-text-primary)', children: title }),
          extra ? jsx('span', { className: 'ml-auto text-[0.625rem] font-medium text-(--ui-text-quaternary)', children: extra }) : null
        ]
      }),
      jsx('div', { className: 'p-4', children })
    ]
  })
}

// ── gateway strip ──────────────────────────────────────────────────────────

// Compact gateway status bar under the hero: phase, pid, heartbeat age.
function GatewayStrip({ gateway }) {
  const phase = gateway.phase || 'unknown'
  const live = phase === 'running' || phase === 'starting'
  const heartbeat = gateway.heartbeat_age != null ? gateway.heartbeat_age : null
  const hbFresh = heartbeat != null && heartbeat < 120
  const tone = live && hbFresh ? 'ok' : phase === 'starting' ? 'warn' : 'idle'

  return jsxs('div', {
    className: 'flex items-center gap-3 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) px-4 py-2.5',
    children: [
      jsx(StatusPill, { tone, children: `gateway ${phase}` }),
      gateway.pid ? jsx('span', { className: 'font-mono text-[0.625rem] text-(--ui-text-quaternary)', children: `pid ${gateway.pid}` }) : null,
      heartbeat != null
        ? jsx('span', { className: 'text-[0.625rem] text-(--ui-text-tertiary)', children: heartbeat < 120 ? 'heartbeat: fresh' : `heartbeat: ${Math.round(heartbeat / 60)}m ago` })
        : jsx('span', { className: 'text-[0.625rem] text-(--ui-text-tertiary)', children: 'no heartbeat file' }),
      jsx('span', { className: 'ml-auto text-[0.625rem] text-(--ui-text-quaternary)', children: gateway.exited_at ? `last exit ${fmtRelTime(new Date(gateway.exited_at))}` : '' })
    ]
  })
}

// ── error log viewer ───────────────────────────────────────────────────────

// Parse a log line into {ts, time, level, msg}. Log lines look like
// "2026-08-09 18:46:23,651 WARNING tools.registry: ...".
function parseLogLine(ln) {
  const m = ln.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})[,\s](\d+)?\s+([A-Z]+)\s+(.*)$/)
  if (m) {
    return { ts: m[1], time: m[1].slice(11), level: m[2] ? m[3] : m[3], msg: (m[2] ? m[4] : m[3] + ' ' + m[4]) }
  }
  // Fallback: no timestamp prefix.
  return { ts: '', time: '', level: '', msg: ln }
}

const LOG_LEVEL_STYLE = {
  ERROR: { text: '#d64545', bg: 'rgba(214,69,69,0.12)' },
  WARNING: { text: '#b7791f', bg: 'rgba(183,121,31,0.12)' },
  INFO: { text: '#2f7fd4', bg: 'rgba(47,127,212,0.12)' },
  DEBUG: { text: '#8a8f98', bg: 'rgba(138,143,152,0.12)' }
}

// Compact log viewer: level pill + time + truncated message per row.
function ErrorLogViewer({ lines }) {
  const parsed = lines.map(parseLogLine)
  const errorCount = parsed.filter(l => l.level === 'ERROR').length
  const warnCount = parsed.filter(l => l.level === 'WARNING').length

  return jsx(Section, {
    title: 'Recent errors',
    icon: 'error',
    accent: ACCENTS.red,
    extra: errorCount ? `${errorCount} errors · ${warnCount} warnings` : `${warnCount} warnings`,
    children: jsxs('div', {
      className: 'flex flex-col overflow-hidden rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-chrome)',
      children: parsed.map((l, i) => {
        const style = LOG_LEVEL_STYLE[l.level] || LOG_LEVEL_STYLE.INFO
        return jsxs('div', {
          key: i,
          className: cn(
            'flex items-center gap-2 px-3 py-1.5 text-[0.625rem] leading-snug transition-colors hover:bg-(--ui-bg-quaternary)',
            i > 0 && 'border-t border-(--ui-stroke-secondary)'
          ),
          children: [
            l.level
              ? jsx('span', {
                  className: 'w-16 shrink-0 rounded px-1.5 py-0.5 text-center text-[0.5625rem] font-bold',
                  style: { backgroundColor: style.bg, color: style.text },
                  children: l.level
                })
              : null,
            l.time
              ? jsx('span', { className: 'shrink-0 font-mono tabular-nums text-(--ui-text-quaternary)', title: l.ts, children: l.time })
              : null,
            jsx('span', {
              className: 'min-w-0 flex-1 truncate font-mono text-(--ui-text-secondary)',
              title: `${l.ts} ${l.level} ${l.msg}`,
              children: l.msg
            })
          ]
        })
      })
    })
  })
}

// ── Overview tab ───────────────────────────────────────────────────────────

function OverviewTab({ data, onRefresh }) {
  const t = data.tokens_24h || {}
  const c = data.cron_24h || {}
  const e = data.errors_24h || {}
  const m = data.memory || {}
  const cachePct = t.input + t.output > 0 ? Math.round((t.cache_read / (t.input + t.output + t.cache_read)) * 100) : 0
  const live = data.processes && data.processes.length > 0

  // Composite health score: 100 minus penalties, with a structured breakdown
  // for the hover card.
  let health = 100
  const factors = []
  const addFactor = (label, penalty, ok, desc) => {
    if (!ok) health -= penalty
    factors.push({ label, penalty, ok, desc })
  }
  addFactor('Backends running', 35, !!live, live ? 'Hermes backends are up.' : 'No backend processes detected — nothing is serving requests.')
  addFactor('Errors (24h)', Math.min(30, (e.count_24h || 0) * 5), !e.count_24h, e.count_24h ? `${e.count_24h} errors in the last 24h (5 points each, capped at 30).` : 'No errors in the last 24h.')
  addFactor('Cron failures', 20, !c.failed, c.failed ? `${c.failed} cron job(s) failed recently.` : 'No recent cron failures.')
  addFactor('Cache efficiency', cachePct < 50 ? 10 : 0, cachePct >= 50, cachePct < 50 ? `Only ${cachePct}% of token traffic came from cache (want ≥50%).` : `${cachePct}% of token traffic came from cache.`)
  addFactor('Memory headroom', m.always_on_limit && m.always_on_chars / m.always_on_limit > 0.9 ? 10 : 0, !(m.always_on_limit && m.always_on_chars / m.always_on_limit > 0.9), m.always_on_limit && m.always_on_chars / m.always_on_limit > 0.9 ? 'Always-on memory is over 90% full — needs consolidation.' : 'Always-on memory has headroom.')
  health = Math.max(0, health)
  const healthColor = health >= 80 ? ['#2f9e63', '#0f9a9a'] : health >= 50 ? ['#b7791f', '#d4578f'] : ['#d64545', '#d4578f']

  return jsxs('div', {
    className: 'flex flex-col gap-4 p-6',
    children: [
      jsx(HeroHeader, { processes: data.processes, onRefresh, health, healthColor, factors }),
      jsx(GatewayStrip, { gateway: data.gateway || {} }),
      jsxs('div', {
        className: 'grid gap-3',
        style: { gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' },
        children: [
          jsx(StatCard, {
            label: 'Backends running',
            value: data.processes ? data.processes.length : '0',
            sub: live && data.processes[0] ? data.processes[0].cmd.slice(0, 40) : 'no active backends',
            icon: 'pulse',
            accent: live ? ACCENTS.green : ACCENTS.red,
            pulse: live,
            index: 0
          }),
          jsx(StatCard, {
            label: 'Tokens (24h)',
            value: fmtNum(t.input + t.output),
            sub: `${fmtNum(t.cache_read)} cache · $${(t.cost || 0).toFixed(2)}`,
            icon: 'zap',
            accent: ACCENTS.blue,
            index: 1
          }),
          jsx(StatCard, {
            label: 'Cache efficiency',
            value: `${cachePct}%`,
            sub: 'served from cache',
            icon: 'graph',
            accent: ACCENTS.teal,
            index: 2
          }),
          jsx(StatCard, {
            label: 'Cron (24h)',
            value: `${c.completed || 0} ok`,
            sub: c.failed ? `${c.failed} failed` : 'no failures',
            icon: 'clock',
            accent: c.failed ? ACCENTS.red : ACCENTS.gold,
            index: 3
          }),
          jsx(StatCard, {
            label: 'Errors (24h)',
            value: String(e.count_24h || 0),
            sub: e.latest && e.latest.length ? e.latest[0].slice(0, 52) : 'clean',
            icon: 'error',
            accent: e.count_24h ? ACCENTS.red : ACCENTS.green,
            index: 4
          }),
          jsx(StatCard, {
            label: 'Facts in memory',
            value: String(m.facts || 0),
            sub: 'deep memory entries',
            icon: 'database',
            accent: ACCENTS.purple,
            index: 5
          }),
          jsx(StatCard, {
            label: 'Process groups',
            value: String((data.processes || []).length),
            sub: 'desktop + backends',
            icon: 'plug',
            accent: ACCENTS.rose,
            index: 6
          }),
          jsx(StatCard, {
            label: 'Last refresh',
            value: data.generated_at ? relativeTime(data.generated_at * 1000) : '—',
            sub: 'auto-refresh 30s',
            icon: 'history',
            accent: ACCENTS.gold,
            index: 7
          })
        ]
      }),
      // Recent error lines — only when there are errors to show
      e.count_24h && e.latest && e.latest.length
        ? jsx(ErrorLogViewer, { lines: e.latest })
        : null,
      jsx(Section, {
        title: 'Active processes',
        icon: 'pulse',
        accent: ACCENTS.green,
        extra: `${(data.processes || []).length} running`,
        children: jsxs('div', {
          className: 'flex flex-col gap-1',
          children: (data.processes || []).length
            ? data.processes.map((p, i) =>
                jsxs('div', {
                  key: i,
                  className: 'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors hover:bg-(--ui-bg-quaternary)',
                  children: [
                    jsx('span', { className: 'shrink-0 rounded-md bg-(--ui-bg-quaternary) px-1.5 py-0.5 font-mono text-[0.625rem] tabular-nums text-(--ui-text-tertiary)', children: p.pid }),
                    jsx('span', { className: 'truncate text-(--ui-text-secondary)', children: p.cmd })
                  ]
                })
              )
            : jsx(EmptyState, { title: 'No backends', description: 'No Hermes backend processes detected.' })
        })
      })
    ]
  })
}

// ── Cron tab ───────────────────────────────────────────────────────────────

function fmtSchedule(s) {
  if (!s) return '—'
  if (typeof s === 'string') return s
  return s.display || s.expr || '—'
}

function fmtDuration(ms) {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60000)}m`
}

function fmtNextRun(iso) {
  if (!iso) return 'not scheduled'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const diff = d.getTime() - Date.now()
  if (diff < 0) return 'due'
  if (diff < 3600000) return `in ${Math.max(1, Math.round(diff / 60000))}m`
  if (diff < 86400000) return `in ${Math.round(diff / 3600000)}h`
  return `in ${Math.round(diff / 86400000)}d`
}

// Execution timestamps arrive as ISO strings (started_at). Parse defensively.
function execDate(ex) {
  if (ex.at_iso) {
    const d = new Date(ex.at_iso)
    if (!isNaN(d.getTime())) return d
  }
  const ms = ex.at_ms
  if (ms != null) {
    const d = new Date(ms > 1e12 ? ms : ms * 1000)
    if (!isNaN(d.getTime())) return d
  }
  return null
}

function fmtRelTime(date) {
  if (!date) return '—'
  const diff = Date.now() - date.getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.max(1, Math.round(diff / 60000))}m ago`
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`
  return `${Math.round(diff / 86400000)}d ago`
}

// Group executions into ordered day buckets with labels.
function groupByDay(executions) {
  const groups = []
  const seen = new Map()
  for (const ex of executions) {
    const d = execDate(ex)
    const key = d ? d.toDateString() : 'unknown'
    let label
    if (d) {
      const today = new Date()
      const yest = new Date(today.getTime() - 86400000)
      if (d.toDateString() === today.toDateString()) label = 'Today'
      else if (d.toDateString() === yest.toDateString()) label = 'Yesterday'
      else label = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    } else {
      label = 'Unknown'
    }
    if (!seen.has(key)) {
      seen.set(key, groups.length)
      groups.push({ key, label, items: [] })
    }
    groups[seen.get(key)].items.push(ex)
  }
  return groups
}

function CronTab({ data }) {
  const jobs = data.jobs || []
  const executions = data.executions || []
  const enabledCount = jobs.filter(j => j.enabled !== false && !j.paused).length
  const failedCount = jobs.filter(j => j.last_status === 'failed').length

  return jsxs('div', {
    className: 'flex flex-col gap-4 p-6',
    children: [
      // Summary strip
      jsxs('div', {
        className: 'grid gap-3',
        style: { gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' },
        children: [
          jsx(StatCard, { label: 'Total jobs', value: String(jobs.length), sub: 'scheduled', icon: 'clock', accent: ACCENTS.teal, index: 0 }),
          jsx(StatCard, { label: 'Active', value: String(enabledCount), sub: 'enabled + not paused', icon: 'play', accent: ACCENTS.green, index: 1 }),
          jsx(StatCard, { label: 'Last status', value: failedCount ? `${failedCount} failed` : 'all ok', sub: failedCount ? 'needs attention' : 'last runs clean', icon: 'check', accent: failedCount ? ACCENTS.red : ACCENTS.green, index: 2 }),
          jsx(StatCard, { label: 'Recent runs', value: String(executions.length), sub: 'last 40 executions', icon: 'history', accent: ACCENTS.blue, index: 3 })
        ]
      }),
      // Job cards
      jsx(Section, {
        title: 'Scheduled jobs',
        icon: 'clock',
        accent: ACCENTS.teal,
        extra: `${jobs.length} jobs · ${enabledCount} active`,
        children: jobs.length
          ? jsxs('div', {
              className: 'grid gap-2.5',
              // Inline grid template — the host Tailwind build purges plugin
              // grid-cols-* classes beyond 1/2/4/6, so auto-fill keeps the
              // job cards 2-up on wide panes and 1-up on narrow ones.
              style: { gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' },
              children: jobs.map((job, i) => {
                const paused = job.paused || job.state === 'paused'
                const disabled = job.enabled === false
                const inactive = paused || disabled
                const statusTone = job.last_status === 'failed' ? 'err' : job.last_status === 'ok' ? 'ok' : 'idle'
                const accent = inactive ? ACCENTS.idle : job.last_status === 'failed' ? ACCENTS.red : ACCENTS.green
                return jsxs('div', {
                  key: job.id,
                  className: cn(
                    'hc-glow hc-fade-up flex flex-col gap-2 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) p-3.5 transition-all hover:-translate-y-0.5 hover:shadow-lg',
                    inactive && 'opacity-70'
                  ),
                  style: { animationDelay: `${i * 40}ms` },
                  children: [
                    jsxs('div', {
                      className: 'flex items-start gap-2.5',
                      children: [
                        jsx(IconChip, { codicon: inactive ? 'circle-slash' : 'clock', accent, size: 'h-8 w-8' }),
                        jsxs('div', {
                          className: 'min-w-0 flex-1',
                          children: [
                            jsxs('div', {
                              className: 'flex items-center gap-1.5',
                              children: [
                                jsx('span', { className: 'truncate text-xs font-semibold text-(--ui-text-primary)', children: job.name }),
                                job.no_agent ? jsx(Badge, { children: 'script' }) : null
                              ]
                            }),
                            jsxs('div', {
                              className: 'mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.625rem] text-(--ui-text-tertiary)',
                              children: [
                                jsx('span', { className: 'font-mono', children: fmtSchedule(job.schedule) }),
                                job.model ? jsx('span', { children: job.model }) : null,
                                job.deliver && job.deliver !== 'origin' ? jsx('span', { children: `→ ${job.deliver}` }) : null
                              ]
                            })
                          ]
                        }),
                        jsx('div', {
                          className: 'flex shrink-0 flex-col items-end gap-1',
                          children: jsx(StatusPill, { tone: statusTone, children: job.last_status || '—' })
                        })
                      ]
                    }),
                    jsxs('div', {
                      className: 'flex items-center justify-between border-t border-(--ui-stroke-secondary) pt-2 text-[0.625rem]',
                      children: [
                        jsx('span', { className: 'text-(--ui-text-tertiary)', children: job.next_run_at ? `Next: ${fmtNextRun(job.next_run_at)}` : (inactive ? 'Paused' : 'No next run') }),
                        job.last_error
                          ? jsx('span', { className: 'max-w-[45%] truncate text-(--ui-error)', title: job.last_error, children: job.last_error })
                          : null
                      ]
                    })
                  ]
                })
              })
            })
          : jsx(EmptyState, { title: 'No cron jobs', description: 'Nothing scheduled yet.' })
      }),
      // Executions table — grouped by day, compact aligned rows
      jsx(Section, {
        title: 'Recent executions',
        icon: 'history',
        accent: ACCENTS.blue,
        extra: `${executions.length} shown`,
        children: executions.length
          ? jsxs('div', {
              className: 'grid gap-1',
              // Inline grid template: day groups flow side-by-side on wide
              // panes instead of one full-width column of sparse rows.
              style: { gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', alignItems: 'start' },
              children: groupByDay(executions).map(group =>
                jsxs('div', {
                  key: group.key,
                  className: 'mb-0',
                  children: [
                    jsxs('div', {
                      className: 'flex items-center gap-2 px-1 pb-1.5 pt-2 text-[0.625rem] font-semibold uppercase tracking-wider text-(--ui-text-quaternary)',
                      children: [
                        jsx('span', { children: group.label }),
                        jsx('span', { className: 'rounded-full bg-(--ui-bg-quaternary) px-1.5 text-[0.5625rem] tabular-nums', children: String(group.items.length) })
                      ]
                    }),
                    jsxs('div', {
                      className: 'flex flex-col overflow-hidden rounded-lg border border-(--ui-stroke-secondary)',
                      children: group.items.map((ex, i) => {
                        const tone = ex.status === 'completed' ? ACCENTS.green : ex.status === 'failed' ? ACCENTS.red : ACCENTS.gold
                        const d = execDate(ex)
                        return jsxs('div', {
                          key: i,
                          className: cn(
                            'flex items-center gap-2.5 px-2.5 py-1.5 text-xs transition-colors hover:bg-(--ui-bg-quaternary)',
                            i > 0 && 'border-t border-(--ui-stroke-secondary)'
                          ),
                          children: [
                            jsx('span', {
                              className: 'w-[4.5rem] shrink-0 rounded-md px-1.5 py-0.5 text-center text-[0.625rem] font-semibold',
                              style: { backgroundColor: tone.bg, color: tone.text },
                              children: ex.status || 'unknown'
                            }),
                            jsx('span', { className: 'min-w-0 flex-1 truncate font-medium text-(--ui-text-primary)', children: ex.job_name }),
                            jsx('span', { className: 'w-14 shrink-0 text-right text-[0.625rem] tabular-nums text-(--ui-text-quaternary)', children: ex.duration_ms != null ? fmtDuration(ex.duration_ms) : '' }),
                            ex.error
                              ? jsx('span', { className: 'max-w-[12rem] truncate text-[0.625rem] text-(--ui-error)', title: ex.error, children: ex.error })
                              : null,
                            jsx('span', { className: 'w-16 shrink-0 text-right text-[0.625rem] tabular-nums text-(--ui-text-quaternary)', title: d ? d.toLocaleString() : '', children: fmtRelTime(d) })
                          ]
                        })
                      })
                    })
                  ]
                })
              )
            })
          : jsx(EmptyState, { title: 'No executions', description: 'No recent cron runs recorded.' })
      })
    ]
  })
}

// ── Plugins tab ────────────────────────────────────────────────────────────

// Icon + accent per backend plugin, keyed by name; falls back to a neutral
// plug icon. NOTE: icons must exist in the host's bundled codicon set — the
// build subsets the font, so `trophy`/`paint-bucket` are stripped at build
// time and render as blank squares. Verified-present: sparkle, symbol-color,
// dashboard, pulse, plug, globe, extensions, milestone, star.
const PLUGIN_META = {
  'command-center': { icon: 'dashboard', accent: ACCENTS.purple },
  'hermes-achievements': { icon: 'sparkle', accent: ACCENTS.gold },
  'status-cost': { icon: 'pulse', accent: ACCENTS.green },
  'theme-switcher': { icon: 'symbol-color', accent: ACCENTS.rose }
}

// Some repo-mounted plugins have no description in their manifest; give them
// a short human line so cards never show a bare "No description."
const PLUGIN_FALLBACK_DESC = {
  'hermes-achievements': 'Gamified achievement tracking: badges, XP, tiers, quests, and rewards for your Hermes usage.'
}

function fmtMtime(mt) {
  if (!mt) return '—'
  const d = new Date(mt * 1000)
  const diff = Date.now() - d.getTime()
  if (diff < 3600000) return `${Math.max(1, Math.round(diff / 60000))}m ago`
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function PluginsTab({ data }) {
  const backend = data.backend || []
  const desktop = data.desktop || []
  const apiCount = backend.filter(p => p.has_api).length
  return jsxs('div', {
    className: 'flex flex-col gap-4 p-6',
    children: [
      jsxs('div', {
        className: 'grid gap-3',
        style: { gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' },
        children: [
          jsx(StatCard, { label: 'Backend plugins', value: String(backend.length), sub: 'installed', icon: 'plug', accent: ACCENTS.purple, index: 0 }),
          jsx(StatCard, { label: 'With API routes', value: String(apiCount), sub: 'serve dashboard data', icon: 'globe', accent: ACCENTS.blue, index: 1 }),
          jsx(StatCard, { label: 'Desktop plugins', value: String(desktop.length), sub: 'UI extensions', icon: 'screen-normal', accent: ACCENTS.gold, index: 2 })
        ]
      }),
      // Backend plugins — rich cards
      jsx(Section, {
        title: 'Backend plugins',
        icon: 'plug',
        accent: ACCENTS.purple,
        extra: `${backend.length} installed`,
        children: backend.length
          ? jsxs('div', {
              className: 'grid gap-2.5',
              style: { gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' },
              children: backend.map((p, i) => {
                const meta = PLUGIN_META[p.name] || { icon: 'plug', accent: ACCENTS.idle }
                return jsxs('div', {
                  key: p.name,
                  className: cn(
                    'hc-glow hc-fade-up flex flex-col gap-2.5 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) p-3.5 transition-all hover:-translate-y-0.5 hover:shadow-lg'
                  ),
                  style: { animationDelay: `${i * 40}ms` },
                  children: [
                    jsxs('div', {
                      className: 'flex items-start gap-2.5',
                      children: [
                        jsx(IconChip, { codicon: meta.icon, accent: meta.accent, size: 'h-8 w-8' }),
                        jsxs('div', {
                          className: 'min-w-0 flex-1',
                          children: [
                            jsxs('div', {
                              className: 'flex items-center gap-1.5',
                              children: [
                                jsx('span', { className: 'truncate text-xs font-semibold text-(--ui-text-primary)', children: p.name }),
                                jsx('span', { className: 'shrink-0 font-mono text-[0.625rem] text-(--ui-text-quaternary)', children: 'v' + (p.version || '?') })
                              ]
                            }),
                            jsx('span', {
                              className: 'mt-1 block line-clamp-2 text-[0.625rem] leading-snug text-(--ui-text-tertiary)',
                              children: p.description || PLUGIN_FALLBACK_DESC[p.name] || 'No description.'
                            })
                          ]
                        })
                      ]
                    }),
                    jsxs('div', {
                      className: 'flex items-center justify-between border-t border-(--ui-stroke-secondary) pt-2 text-[0.625rem]',
                      children: [
                        jsxs('div', {
                          className: 'flex items-center gap-1.5',
                          children: [
                            p.has_api
                              ? jsx('span', {
                                  className: 'rounded-full px-2 py-0.5 text-[0.625rem] font-semibold',
                                  style: p.mounted_from === 'repo'
                                    ? { backgroundColor: 'rgba(123,95,217,0.12)', color: '#7b5fd9' }
                                    : { backgroundColor: 'rgba(47,127,212,0.12)', color: '#2f7fd4' },
                                  children: p.mounted_from === 'repo' ? 'repo-mounted' : 'api'
                                })
                              : jsx('span', {
                                  className: 'rounded-full px-2 py-0.5 text-[0.625rem] font-semibold',
                                  style: { backgroundColor: 'rgba(138,143,152,0.12)', color: '#8a8f98' },
                                  children: 'no api'
                                }),
                            jsx('span', { className: 'text-(--ui-text-quaternary)', children: fmtMtime(p.mtime) })
                          ]
                        }),
                        jsx('span', {
                          className: 'shrink-0 font-mono text-[0.625rem] text-(--ui-text-quaternary)',
                          children: p.mounted_from === 'repo' ? 'repo' : 'user'
                        })
                      ]
                    })
                  ]
                })
              })
            })
          : jsx(EmptyState, { title: 'No backend plugins', description: 'Nothing installed yet.' })
      }),
      // Desktop plugins — compact cards
      jsx(Section, {
        title: 'Desktop plugins',
        icon: 'screen-normal',
        accent: ACCENTS.gold,
        extra: `${desktop.length} installed`,
        children: desktop.length
          ? jsxs('div', {
              className: 'grid gap-2',
              style: { gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' },
              children: desktop.map((p, i) => {
                const meta = PLUGIN_META[p.name] || { icon: 'extensions', accent: ACCENTS.idle }
                return jsxs('div', {
                  key: p.name,
                  className: cn(
                    'hc-fade-up flex items-center gap-2.5 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) px-3 py-2.5 transition-all hover:-translate-y-0.5 hover:shadow-md'
                  ),
                  style: { animationDelay: `${i * 30}ms` },
                  children: [
                    jsx(IconChip, { codicon: meta.icon, accent: meta.accent, size: 'h-7 w-7' }),
                    jsx('span', { className: 'min-w-0 flex-1 truncate text-xs font-medium text-(--ui-text-primary)', title: p.name, children: p.name }),
                    jsx('span', { className: 'shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[0.625rem] tabular-nums', style: { backgroundColor: 'rgba(47,127,212,0.10)', color: '#2f7fd4' }, children: `${(p.size / 1024).toFixed(1)} KB` }),
                    jsx('span', { className: 'shrink-0 text-[0.625rem] text-(--ui-text-quaternary)', children: fmtMtime(p.mtime) })
                  ]
                })
              })
            })
          : jsx(EmptyState, { title: 'No desktop plugins', description: 'Nothing installed yet.' })
      })
    ]
  })
}

// ── Models tab ─────────────────────────────────────────────────────────────

// Fixed color identity per model, assigned round-robin so each model has a
// distinct, consistent tile + bar color. All in the bundled-codicon-safe
// world (no glyphs needed — these drive gradient tiles and bars).
const MODEL_COLORS = [
  { key: 'purple', from: '#7b5fd9', to: '#a48cf0', bar: 'linear-gradient(90deg, #7b5fd9 0%, #a48cf0 100%)' },
  { key: 'blue', from: '#2f7fd4', to: '#5aa7f0', bar: 'linear-gradient(90deg, #2f7fd4 0%, #5aa7f0 100%)' },
  { key: 'teal', from: '#0f9a9a', to: '#2fc4c4', bar: 'linear-gradient(90deg, #0f9a9a 0%, #2fc4c4 100%)' },
  { key: 'green', from: '#2f9e63', to: '#3ecf8e', bar: 'linear-gradient(90deg, #2f9e63 0%, #3ecf8e 100%)' },
  { key: 'gold', from: '#b7791f', to: '#e0a63d', bar: 'linear-gradient(90deg, #b7791f 0%, #e0a63d 100%)' },
  { key: 'rose', from: '#d4578f', to: '#f07ab0', bar: 'linear-gradient(90deg, #d4578f 0%, #f07ab0 100%)' }
]

function modelColor(i) {
  return MODEL_COLORS[i % MODEL_COLORS.length]
}

// Initials for the model tile: first two letters of the model family
// (e.g. "de" for deepseek, "mi" for minimax), uppercase.
function modelInitials(name) {
  const fam = (name || '').split('-')[0] || name || '?'
  return fam.slice(0, 2).toUpperCase()
}

function ModelsTab({ data }) {
  const byModel = data.by_model || []
  const daily = data.daily || []
  const maxModel = Math.max(...byModel.map(m => m.input + m.output), 1)
  const totalTokens = byModel.reduce((acc, m) => acc + (m.input || 0) + (m.output || 0), 0)
  const totalCache = byModel.reduce((acc, m) => acc + (m.cache_read || 0), 0)
  const topModel = byModel[0] ? byModel[0].model : '—'

  return jsxs('div', {
    className: 'flex flex-col gap-4 p-6',
    children: [
      // Summary strip
      jsxs('div', {
        className: 'grid gap-3',
        style: { gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' },
        children: [
          jsx(StatCard, { label: 'Models used', value: String(byModel.length), sub: 'in the last 30 days', icon: 'graph', accent: ACCENTS.blue, index: 0 }),
          jsx(StatCard, { label: 'Tokens (30d)', value: fmtNum(totalTokens), sub: 'input + output', icon: 'zap', accent: ACCENTS.gold, index: 1 }),
          jsx(StatCard, { label: 'Cache reads', value: fmtNum(totalCache), sub: 'served from cache', icon: 'pulse', accent: ACCENTS.teal, index: 2 }),
          jsx(StatCard, { label: 'Top model', value: topModel, sub: 'most tokens burned', icon: 'milestone', accent: ACCENTS.purple, index: 3 })
        ]
      }),
      // Token burn by model — rich cards
      jsx(Section, {
        title: 'Token burn by model (30d)',
        icon: 'graph',
        accent: ACCENTS.blue,
        extra: `${byModel.length} models`,
        children: byModel.length
          ? jsxs('div', {
              className: 'grid gap-2.5',
              style: { gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' },
              children: byModel.map((m, i) => {
                const c = modelColor(i)
                const total = (m.input || 0) + (m.output || 0)
                const share = totalTokens ? Math.round((total / totalTokens) * 100) : 0
                const cachePct = total + (m.cache_read || 0) > 0 ? Math.round(((m.cache_read || 0) / (total + (m.cache_read || 0))) * 100) : 0
                return jsxs('div', {
                  key: m.model,
                  className: cn(
                    'hc-glow hc-fade-up flex flex-col gap-3 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) p-3.5 transition-all hover:-translate-y-0.5 hover:shadow-lg'
                  ),
                  style: { animationDelay: `${i * 40}ms` },
                  children: [
                    jsxs('div', {
                      className: 'flex items-start gap-2.5',
                      children: [
                        jsx('div', {
                          className: 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[0.625rem] font-bold text-white',
                          style: { background: `linear-gradient(135deg, ${c.from} 0%, ${c.to} 100%)`, boxShadow: '0 4px 10px rgba(0,0,0,0.18)' },
                          children: modelInitials(m.model)
                        }),
                        jsxs('div', {
                          className: 'min-w-0 flex-1',
                          children: [
                            jsx('span', { className: 'block truncate text-xs font-semibold text-(--ui-text-primary)', children: m.model }),
                            jsxs('div', {
                              className: 'mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.625rem] text-(--ui-text-tertiary)',
                              children: [
                                jsx('span', { children: `${fmtNum(m.input)} in` }),
                                jsx('span', { children: `${fmtNum(m.output)} out` }),
                                jsx('span', { children: `${fmtNum(m.cache_read)} cache` }),
                                m.reasoning_tokens ? jsx('span', { children: `${fmtNum(m.reasoning_tokens)} think` }) : null
                              ]
                            })
                          ]
                        }),
                        jsx('span', {
                          className: 'shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-semibold tabular-nums',
                          style: { backgroundColor: c.to + '22', color: c.from },
                          children: `${share}%`
                        })
                      ]
                    }),
                    jsxs('div', {
                      className: 'flex flex-col gap-1.5',
                      children: [
                        jsx('div', {
                          className: 'h-2 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)',
                          children: jsx('div', {
                            className: 'h-full rounded-full transition-all',
                            style: { width: `${Math.max(2, (total / maxModel) * 100)}%`, background: c.bar }
                          })
                        }),
                        jsxs('div', {
                          className: 'flex items-center justify-between text-[0.625rem] text-(--ui-text-quaternary)',
                          children: [
                            jsx('span', { children: `${fmtNum(total)} total` }),
                            jsx('span', { children: `${cachePct}% cache` })
                          ]
                        })
                      ]
                    })
                  ]
                })
              })
            })
          : jsx(EmptyState, { title: 'No model usage', description: 'No token data recorded yet.' })
      }),
      // Daily trend
      jsx(Section, {
        title: 'Daily token trend (15d)',
        icon: 'pulse',
        accent: ACCENTS.teal,
        extra: `${daily.length} days`,
        children: daily.length
          ? jsx(AreaChart, { daily, height: 140, from: '#2f7fd4', to: '#0f9a9a' })
          : jsx(EmptyState, { title: 'No trend', description: 'No daily token data yet.' })
      }),
      // Per-task breakdown + top sessions side by side
      jsxs('div', {
        className: 'grid gap-4',
        style: { gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' },
        children: [
          jsx(Section, {
            title: 'Tokens by task (30d)',
            icon: 'list-unordered',
            accent: ACCENTS.gold,
            extra: `${(data.by_task || []).length} tasks`,
            children: (data.by_task || []).length
              ? jsxs('div', {
                  className: 'flex flex-col gap-2',
                  children: (data.by_task || []).map((t, i) => {
                    const maxTask = Math.max(...(data.by_task || []).map(x => x.tokens), 1)
                    const c = modelColor(i)
                    return jsxs('div', {
                      key: t.task,
                      className: 'flex flex-col gap-1',
                      children: [
                        jsxs('div', {
                          className: 'flex items-center gap-2 text-xs',
                          children: [
                            jsx('span', { className: 'w-28 shrink-0 truncate font-medium text-(--ui-text-primary)', children: t.task }),
                            jsx('span', { className: 'ml-auto shrink-0 tabular-nums text-(--ui-text-secondary)', children: fmtNum(t.tokens) })
                          ]
                        }),
                        jsx('div', {
                          className: 'h-1.5 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)',
                          children: jsx('div', {
                            className: 'h-full rounded-full transition-all',
                            style: { width: `${Math.max(2, (t.tokens / maxTask) * 100)}%`, background: c.bar }
                          })
                        })
                      ]
                    })
                  })
                })
              : jsx(EmptyState, { title: 'No task data', description: 'No per-task token data yet.' })
          }),
          jsx(Section, {
            title: 'Top sessions (30d)',
            icon: 'history',
            accent: ACCENTS.blue,
            extra: `${(data.top_sessions || []).length} shown`,
            children: (data.top_sessions || []).length
              ? jsxs('div', {
                  className: 'flex flex-col overflow-hidden rounded-lg border border-(--ui-stroke-secondary)',
                  children: (data.top_sessions || []).map((s, i) => (
                    jsxs('div', {
                      key: s.session_id,
                      className: cn('flex items-center gap-2.5 px-3 py-1.5 text-xs transition-colors hover:bg-(--ui-bg-quaternary)', i > 0 && 'border-t border-(--ui-stroke-secondary)'),
                      children: [
                        jsx('span', { className: 'w-4 shrink-0 text-right font-mono text-[0.625rem] text-(--ui-text-quaternary)', children: String(i + 1) }),
                        jsx('span', { className: 'min-w-0 flex-1 truncate text-[0.6875rem] font-medium text-(--ui-text-primary)', title: s.session_id, children: s.label || sessionShort(s.session_id) }),
                        jsx('span', { className: 'max-w-[8rem] shrink-0 truncate text-[0.625rem] text-(--ui-text-quaternary)', children: s.model }),
                        jsx('span', { className: 'shrink-0 rounded-md px-1.5 py-0.5 text-[0.625rem] font-semibold tabular-nums', style: { backgroundColor: 'rgba(183,121,31,0.10)', color: '#b7791f' }, children: fmtNum(s.tokens) })
                      ]
                    })
                  ))
                })
              : jsx(EmptyState, { title: 'No session data', description: 'No per-session token data yet.' })
          })
        ]
      })
    ]
  })
}

// ── Skills tab ─────────────────────────────────────────────────────────────

// Rank tier colors: top 3 get medal accents, the rest a green→teal ladder.
function skillColor(i) {
  if (i === 0) return { from: '#b7791f', to: '#e0a63d', bar: 'linear-gradient(90deg, #b7791f 0%, #e0a63d 100%)', medal: '1' }
  if (i === 1) return { from: '#8a8f98', to: '#c3c8cf', bar: 'linear-gradient(90deg, #8a8f98 0%, #c3c8cf 100%)', medal: '2' }
  if (i === 2) return { from: '#c77a3e', to: '#e8a06b', bar: 'linear-gradient(90deg, #c77a3e 0%, #e8a06b 100%)', medal: '3' }
  const shift = (i - 3) % 6
  const ladder = [
    { from: '#2f9e63', to: '#3ecf8e' },
    { from: '#0f9a9a', to: '#2fc4c4' },
    { from: '#2f7fd4', to: '#5aa7f0' },
    { from: '#7b5fd9', to: '#a48cf0' },
    { from: '#d4578f', to: '#f07ab0' },
    { from: '#b7791f', to: '#e0a63d' }
  ]
  const c = ladder[shift]
  return { from: c.from, to: c.to, bar: `linear-gradient(90deg, ${c.from} 0%, ${c.to} 100%)`, medal: null }
}

function SkillsTab({ data }) {
  const skills = data.skills || []
  const top = skills.slice(0, 25)
  const maxUse = Math.max(...top.map(s => s.use_count), 1)
  const totalUse = top.reduce((acc, s) => acc + (s.use_count || 0), 0)
  const activeCount = skills.filter(s => !s.state || s.state === 'active').length

  return jsxs('div', {
    className: 'flex flex-col gap-4 p-6',
    children: [
      // Summary strip
      jsxs('div', {
        className: 'grid gap-3',
        style: { gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' },
        children: [
          jsx(StatCard, { label: 'Skills tracked', value: String(skills.length), sub: 'usage recorded', icon: 'book', accent: ACCENTS.green, index: 0 }),
          jsx(StatCard, { label: 'Active', value: String(activeCount), sub: 'not archived/stale', icon: 'check', accent: ACCENTS.teal, index: 1 }),
          jsx(StatCard, { label: 'Top 25 uses', value: fmtNum(totalUse), sub: 'total invocations', icon: 'milestone', accent: ACCENTS.purple, index: 2 }),
          jsx(StatCard, { label: 'Most used', value: top[0] ? top[0].name : '—', sub: top[0] ? `${top[0].use_count} uses` : 'no usage yet', icon: 'star', accent: ACCENTS.gold, index: 3 })
        ]
      }),
      // Ranked skill cards
      jsx(Section, {
        title: 'Most-used skills',
        icon: 'book',
        accent: ACCENTS.green,
        extra: `top ${top.length} of ${skills.length}`,
        children: top.length
          ? jsxs('div', {
              className: 'grid gap-2.5',
              style: { gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' },
              children: top.map((s, i) => {
                const c = skillColor(i)
                const pct = maxUse ? Math.round((s.use_count / maxUse) * 100) : 0
                return jsxs('div', {
                  key: s.name,
                  className: cn(
                    'hc-glow hc-fade-up flex flex-col gap-2.5 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) p-3 transition-all hover:-translate-y-0.5 hover:shadow-lg'
                  ),
                  style: { animationDelay: `${i * 30}ms` },
                  children: [
                    jsxs('div', {
                      className: 'flex items-center gap-2.5',
                      children: [
                        jsx('div', {
                          className: 'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[0.5625rem] font-bold text-white',
                          style: { background: `linear-gradient(135deg, ${c.from} 0%, ${c.to} 100%)`, boxShadow: '0 3px 8px rgba(0,0,0,0.15)' },
                          children: c.medal || String(i + 1)
                        }),
                        jsx('span', { className: 'min-w-0 flex-1 truncate text-xs font-semibold text-(--ui-text-primary)', title: s.name, children: s.name }),
                        jsx('span', {
                          className: 'shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-semibold tabular-nums',
                          style: { backgroundColor: c.to + '22', color: c.from },
                          children: String(s.use_count)
                        })
                      ]
                    }),
                    jsxs('div', {
                      className: 'flex flex-col gap-1',
                      children: [
                        jsx('div', {
                          className: 'h-1.5 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)',
                          children: jsx('div', {
                            className: 'h-full rounded-full transition-all',
                            style: { width: `${Math.max(2, (s.use_count / maxUse) * 100)}%`, background: c.bar }
                          })
                        }),
                        jsxs('div', {
                          className: 'flex items-center justify-between text-[0.625rem] text-(--ui-text-quaternary)',
                          children: [
                            jsx('span', { children: `${pct}% of top usage` }),
                            s.state && s.state !== 'active'
                              ? jsx('span', { className: 'rounded-full px-1.5 py-0.5 text-[0.5625rem] font-semibold', style: { backgroundColor: 'rgba(183,121,31,0.12)', color: '#b7791f' }, children: s.state })
                              : jsx('span', { children: 'active' })
                          ]
                        })
                      ]
                    })
                  ]
                })
              })
            })
          : jsx(EmptyState, { title: 'No skill data', description: 'No usage tracked yet.' })
      })
    ]
  })
}

// ── Memory tab ─────────────────────────────────────────────────────────────

function MemoryTab({ data }) {
  const mem = (data && data.memory) || {}
  const facts = mem.facts || 0
  const chars = mem.always_on_chars || 0
  const limit = mem.always_on_limit || 4000
  const pct = Math.min(100, Math.round((chars / limit) * 100))
  const danger = pct > 90
  const accent = danger ? ACCENTS.red : ACCENTS.green

  const memMd = { chars: mem.memory_md_chars || 0, limit: mem.memory_md_limit || 4000 }
  const userMd = { chars: mem.user_md_chars || 0, limit: mem.user_md_limit || 2500 }
  const memMdPct = Math.min(100, Math.round((memMd.chars / memMd.limit) * 100))
  const userMdPct = Math.min(100, Math.round((userMd.chars / userMd.limit) * 100))

  return jsxs('div', {
    className: 'flex flex-col gap-4 p-6',
    children: [
      // Summary strip
      jsxs('div', {
        className: 'grid gap-3',
        style: { gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' },
        children: [
          jsx(StatCard, { label: 'Always-on memory', value: `${fmtNum(chars)} chars`, sub: 'combined, across 2 files', icon: 'database', accent: danger ? ACCENTS.red : ACCENTS.blue, index: 0 }),
          jsx(StatCard, { label: 'Fill', value: `${pct}%`, sub: danger ? 'needs consolidation' : 'healthy', icon: 'graph', accent, pulse: danger, index: 1 }),
          jsx(StatCard, { label: 'Deep memory facts', value: String(facts), sub: 'fact store entries', icon: 'book', accent: ACCENTS.purple, index: 2 }),
          jsx(StatCard, { label: 'Status', value: danger ? 'Full' : 'OK', sub: danger ? 'over 90% used' : 'headroom available', icon: 'check', accent: danger ? ACCENTS.red : ACCENTS.green, index: 3 })
        ]
      }),
      // Memory file cards — MEMORY.md + USER.md
      jsx(Section, {
        title: 'Always-on memory files',
        icon: 'database',
        accent: ACCENTS.blue,
        extra: 'injected every turn',
        children: jsxs('div', {
          className: 'grid gap-2.5',
          style: { gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' },
          children: [
            jsx(MemoryFileCard, { name: 'MEMORY.md', kind: 'agent notes', chars: memMd.chars, limit: memMd.limit, pct: memMdPct, from: '#2f7fd4', to: '#5aa7f0', bar: 'linear-gradient(90deg, #2f7fd4 0%, #5aa7f0 100%)', index: 0 }),
            jsx(MemoryFileCard, { name: 'USER.md', kind: 'about you', chars: userMd.chars, limit: userMd.limit, pct: userMdPct, from: '#7b5fd9', to: '#a48cf0', bar: 'linear-gradient(90deg, #7b5fd9 0%, #a48cf0 100%)', index: 1 })
          ]
        })
      }),
      // Memory health — ring + guidance
      jsx(Section, {
        title: 'Memory health',
        icon: 'heart',
        accent,
        children: jsxs('div', {
          className: 'flex items-center gap-4',
          children: [
            jsx(RingGauge, {
              value: pct,
              max: 100,
              label: 'fill',
              from: danger ? '#d64545' : '#2f9e63',
              to: danger ? '#d4578f' : '#0f9a9a',
              size: 72
            }),
            jsxs('div', {
              className: 'flex flex-1 flex-col gap-2',
              children: [
                jsx('div', {
                  className: 'h-2.5 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)',
                  children: jsx('div', {
                    className: 'h-full rounded-full transition-all',
                    style: {
                      width: `${pct}%`,
                      background: danger
                        ? 'linear-gradient(90deg, #d64545 0%, #d4578f 100%)'
                        : 'linear-gradient(90deg, #2f9e63 0%, #0f9a9a 100%)'
                    }
                  })
                }),
                jsx('span', {
                  className: 'text-[0.625rem] text-(--ui-text-tertiary)',
                  children: danger
                    ? 'Always-on memory is nearly full. Consolidate overlapping entries or move detail to the fact store.'
                    : 'Always-on memory has room. Save high-value facts freely, prefer consolidation for the rest.'
                })
              ]
            })
          ]
        })
      })
    ]
  })
}

// Memory file card: name, kind, gradient tile, fill bar, chars/limit.
function MemoryFileCard({ name, kind, chars, limit, pct, from, to, bar, index }) {
  const over = pct >= 100
  const warn = pct > 90
  const accent = over ? '#d64545' : warn ? '#b7791f' : from
  return jsxs('div', {
    className: cn(
      'hc-glow hc-fade-up flex flex-col gap-2.5 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) p-3.5 transition-all hover:-translate-y-0.5 hover:shadow-lg'
    ),
    style: { animationDelay: `${index * 40}ms` },
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2.5',
        children: [
          jsx('div', {
            className: 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[0.625rem] font-bold text-white',
            style: { background: `linear-gradient(135deg, ${from} 0%, ${to} 100%)`, boxShadow: '0 4px 10px rgba(0,0,0,0.18)' },
            children: name.slice(0, 1)
          }),
          jsxs('div', {
            className: 'min-w-0 flex-1',
            children: [
              jsx('span', { className: 'block truncate font-mono text-xs font-semibold text-(--ui-text-primary)', children: name }),
              jsx('span', { className: 'block text-[0.625rem] text-(--ui-text-tertiary)', children: kind })
            ]
          }),
          jsx('span', {
            className: 'shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-semibold tabular-nums',
            style: { backgroundColor: (over ? '#d64545' : warn ? '#b7791f' : from) + '22', color: accent },
            children: `${pct}%`
          })
        ]
      }),
      jsxs('div', {
        className: 'flex flex-col gap-1',
        children: [
          jsx('div', {
            className: 'h-1.5 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)',
            children: jsx('div', {
              className: 'h-full rounded-full transition-all',
              style: { width: `${Math.max(2, pct)}%`, background: bar }
            })
          }),
          jsx('span', {
            className: 'text-[0.625rem] tabular-nums text-(--ui-text-quaternary)',
            children: `${fmtNum(chars)} / ${fmtNum(limit)} chars`
          })
        ]
      })
    ]
  })
}

// ── Activity tab ───────────────────────────────────────────────────────────

// Session source categories: what each means, its icon, and accent colors.
// Order controls column layout; desc shows in the column header.
const CATEGORY_ORDER = ['desktop', 'tui', 'cli', 'cron']
const CATEGORY_META = {
  desktop: {
    icon: 'screen-normal',
    desc: 'Hermes desktop app',
    accent: { from: '#2f7fd4', to: '#5aa7f0', text: '#2f7fd4', bg: 'rgba(47,127,212,0.12)' }
  },
  tui: {
    icon: 'terminal',
    desc: 'Terminal UI',
    accent: { from: '#7b5fd9', to: '#a48cf0', text: '#7b5fd9', bg: 'rgba(123,95,217,0.12)' }
  },
  cli: {
    icon: 'terminal',
    desc: 'Command line',
    accent: { from: '#0f9a9a', to: '#2fc4c4', text: '#0f9a9a', bg: 'rgba(15,154,154,0.12)' }
  },
  cron: {
    icon: 'clock',
    desc: 'Scheduled jobs',
    accent: { from: '#b7791f', to: '#e0a63d', text: '#b7791f', bg: 'rgba(183,121,31,0.12)' }
  }
}

function sessionShort(id) {
  if (!id) return '—'
  // Session ids look like 20260731_095257_378ad5 — keep the readable prefix.
  return id.length > 18 ? id.slice(0, 18) + '…' : id
}

function ActivityTab({ data }) {
  const sessions = data.sessions || []
  const delegations = data.delegations || []
  const deliveries = data.deliveries || []
  const totalMsgs = sessions.reduce((acc, s) => acc + (s.msg_count || 0), 0)
  // Only show the model column when the sessions actually use different
  // models — a uniform column is pure noise.
  const models = new Set(sessions.map(s => s.model).filter(Boolean))
  const showModel = models.size > 1
  const withModel = sessions.map(s => ({ ...s, showModel }))

  const sourceTone = {
    desktop: ACCENTS.blue,
    tui: ACCENTS.purple,
    cli: ACCENTS.teal,
    cron: ACCENTS.gold
  }

  return jsxs('div', {
    className: 'flex flex-col gap-4 p-6',
    children: [
      // Summary strip
      jsxs('div', {
        className: 'grid gap-3',
        style: { gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' },
        children: [
          jsx(StatCard, { label: 'Sessions', value: String(sessions.length), sub: 'most recent', icon: 'history', accent: ACCENTS.rose, index: 0 }),
          jsx(StatCard, { label: 'Messages', value: fmtNum(totalMsgs), sub: 'across these sessions', icon: 'comment', accent: ACCENTS.blue, index: 1 }),
          jsx(StatCard, { label: 'Delegations', value: String(delegations.length), sub: 'background tasks', icon: 'organization', accent: ACCENTS.teal, index: 2 }),
          jsx(StatCard, { label: 'Deliveries', value: String(deliveries.length), sub: 'queued messages', icon: 'send', accent: ACCENTS.gold, index: 3 })
        ]
      }),
      // Recent sessions — grouped by source category in columns
      jsx(Section, {
        title: 'Recent sessions',
        icon: 'history',
        accent: ACCENTS.rose,
        extra: `${sessions.length} shown`,
        children: sessions.length
          ? jsxs('div', {
              className: 'grid gap-3',
              style: { gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' },
              children: CATEGORY_ORDER.map(cat => {
                const meta = CATEGORY_META[cat]
                const group = withModel.filter(s => (s.source || 'other') === cat)
                if (!group.length) return null
                return jsxs('div', {
                  key: cat,
                  className: 'flex flex-col gap-2',
                  children: [
                    // Column header: category name + what it means
                    jsxs('div', {
                      className: 'flex items-center gap-2',
                      children: [
                        jsx('div', {
                          className: 'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white',
                          style: { background: `linear-gradient(135deg, ${meta.accent.from} 0%, ${meta.accent.to} 100%)` },
                          children: jsx(Codicon, { name: meta.icon, className: 'text-[0.6875rem]' })
                        }),
                        jsx('span', { className: 'text-xs font-semibold capitalize text-(--ui-text-primary)', children: cat }),
                        jsx('span', { className: 'rounded-full px-1.5 py-0.5 text-[0.5625rem] font-semibold tabular-nums', style: { backgroundColor: meta.accent.bg, color: meta.accent.text }, children: String(group.length) }),
                        jsx('span', { className: 'ml-auto max-w-[9rem] truncate text-[0.5625rem] text-(--ui-text-quaternary)', title: meta.desc, children: meta.desc })
                      ]
                    }),
                    // Session cards in this category
                    jsxs('div', {
                      className: 'flex flex-col gap-1.5',
                      children: group.map((s, i) => {
                        const tone = sourceTone[s.source] || ACCENTS.idle
                        return jsxs('div', {
                          key: s.id,
                          className: cn(
                            'hc-fade-up flex items-center gap-2 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) px-2.5 py-1.5 transition-colors hover:bg-(--ui-bg-quaternary)'
                          ),
                          style: { animationDelay: `${i * 20}ms` },
                          children: [
                            jsx('span', {
                              className: 'min-w-0 flex-1 truncate text-[0.6875rem] font-medium text-(--ui-text-primary)',
                              title: s.id,
                              children: s.label || sessionShort(s.id)
                            }),
                            s.showModel
                              ? jsx('span', { className: 'max-w-[5rem] shrink-0 truncate text-[0.625rem] text-(--ui-text-quaternary)', children: s.model })
                              : null,
                            jsx('span', {
                              className: 'shrink-0 rounded-md px-1.5 py-0.5 text-[0.625rem] font-semibold tabular-nums',
                              style: { backgroundColor: 'rgba(47,127,212,0.10)', color: '#2f7fd4' },
                              children: `${s.msg_count} msgs`
                            }),
                            jsx('span', { className: 'w-14 shrink-0 text-right text-[0.625rem] tabular-nums text-(--ui-text-quaternary)', title: s.last_msg ? new Date(s.last_msg * 1000).toLocaleString() : '', children: s.last_msg ? fmtRelTime(new Date(s.last_msg * 1000)) : '—' })
                          ]
                        })
                      })
                    })
                  ]
                })
              })
            })
          : jsx(EmptyState, { title: 'No sessions', description: 'No session activity recorded yet.' })
      }),
      // Background tasks — delegations + deliveries in one compact section
      jsx(Section, {
        title: 'Background tasks',
        icon: 'organization',
        accent: ACCENTS.teal,
        extra: `${delegations.length + deliveries.length} total`,
        children: (delegations.length || deliveries.length)
          ? jsxs('div', {
              className: 'grid gap-2',
              style: { gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' },
              children: [
                // Delegations — only render when non-empty
                delegations.length
                  ? jsxs('div', {
                      className: 'flex flex-col gap-2',
                      children: delegations.map((d, i) => (
                        jsxs('div', {
                          key: d.id,
                          className: cn('hc-fade-up flex items-center gap-2 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) px-3 py-2 transition-colors hover:bg-(--ui-bg-quaternary)'),
                          style: { animationDelay: `${i * 20}ms` },
                          children: [
                            jsx('span', {
                              className: 'shrink-0 rounded-full px-2 py-0.5 text-[0.5625rem] font-semibold',
                              style: d.state === 'completed'
                                ? { backgroundColor: 'rgba(47,158,99,0.12)', color: '#2f9e63' }
                                : { backgroundColor: 'rgba(183,121,31,0.12)', color: '#b7791f' },
                              children: d.state || '?'
                            }),
                            jsx('span', { className: 'min-w-0 flex-1 truncate text-[0.6875rem] font-medium text-(--ui-text-primary)', title: d.origin_session, children: d.label || sessionShort(d.origin_session) }),
                            jsx('span', { className: 'shrink-0 text-[0.625rem] tabular-nums text-(--ui-text-quaternary)', children: d.dispatched_at ? fmtRelTime(new Date(d.dispatched_at * 1000)) : '—' })
                          ]
                        })
                      ))
                    })
                  : null,
                // Deliveries — only render when non-empty
                deliveries.length
                  ? jsxs('div', {
                      className: 'flex flex-col gap-2',
                      children: deliveries.map((d, i) => (
                        jsxs('div', {
                          key: d.id,
                          className: cn('hc-fade-up flex items-center gap-2 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) px-3 py-2 transition-colors hover:bg-(--ui-bg-quaternary)'),
                          style: { animationDelay: `${i * 20}ms` },
                          children: [
                            jsx('span', {
                              className: 'shrink-0 rounded-full px-2 py-0.5 text-[0.5625rem] font-semibold',
                              style: { backgroundColor: 'rgba(47,127,212,0.12)', color: '#2f7fd4' },
                              children: d.platform || '?'
                            }),
                            jsx('span', { className: 'min-w-0 flex-1 truncate text-[0.6875rem] font-medium text-(--ui-text-primary)', title: d.session_key, children: sessionShort(d.session_key) }),
                            jsx('span', { className: 'shrink-0 text-[0.625rem] tabular-nums text-(--ui-text-quaternary)', children: d.created_at ? fmtRelTime(new Date(d.created_at * 1000)) : '—' })
                          ]
                        })
                      ))
                    })
                  : null
              ]
            })
          : jsx(EmptyState, { title: 'No background tasks', description: 'No delegations or queued deliveries yet.' })
      })
    ]
  })
}

// ── Usage & credits tab ────────────────────────────────────────────────────

// Provider display names + icons + accents for the usage cards.
// Any provider with rows in state.db appears automatically (the backend
// groups by billing_provider) — these maps only give known providers a
// friendly label + icon; unknown ones fall back to a neutral card.
const PROVIDER_META = {
  'opencode-go': { label: 'OpenCode GO', icon: 'code', accent: { from: '#2f7fd4', to: '#5aa7f0', text: '#2f7fd4', bg: 'rgba(47,127,212,0.12)' } },
  'openai-codex': { label: 'OpenAI Codex', icon: 'sparkle', accent: { from: '#7b5fd9', to: '#a48cf0', text: '#7b5fd9', bg: 'rgba(123,95,217,0.12)' } },
  openrouter: { label: 'OpenRouter', icon: 'globe', accent: { from: '#b7791f', to: '#e0a63d', text: '#b7791f', bg: 'rgba(183,121,31,0.12)' } },
  fal: { label: 'FAL.ai', icon: 'device-camera', accent: { from: '#d4578f', to: '#f07ab0', text: '#d4578f', bg: 'rgba(212,87,143,0.12)' } },
  anthropic: { label: 'Anthropic', icon: 'comment', accent: { from: '#d4578f', to: '#f07ab0', text: '#d4578f', bg: 'rgba(212,87,143,0.12)' } },
  openai: { label: 'OpenAI', icon: 'sparkle', accent: { from: '#7b5fd9', to: '#a48cf0', text: '#7b5fd9', bg: 'rgba(123,95,217,0.12)' } },
  gemini: { label: 'Google Gemini', icon: 'sparkle', accent: { from: '#2f7fd4', to: '#5aa7f0', text: '#2f7fd4', bg: 'rgba(47,127,212,0.12)' } },
  xai: { label: 'xAI (Grok)', icon: 'comment', accent: { from: '#d64545', to: '#f07ab0', text: '#d64545', bg: 'rgba(214,69,69,0.12)' } },
  grok: { label: 'xAI (Grok)', icon: 'comment', accent: { from: '#d64545', to: '#f07ab0', text: '#d64545', bg: 'rgba(214,69,69,0.12)' } },
  deepseek: { label: 'DeepSeek', icon: 'graph', accent: { from: '#2f7fd4', to: '#5aa7f0', text: '#2f7fd4', bg: 'rgba(47,127,212,0.12)' } },
  mistral: { label: 'Mistral', icon: 'sparkle', accent: { from: '#0f9a9a', to: '#2fc4c4', text: '#0f9a9a', bg: 'rgba(15,154,154,0.12)' } },
  groq: { label: 'Groq', icon: 'zap', accent: { from: '#b7791f', to: '#e0a63d', text: '#b7791f', bg: 'rgba(183,121,31,0.12)' } },
  together: { label: 'Together AI', icon: 'graph', accent: { from: '#7b5fd9', to: '#a48cf0', text: '#7b5fd9', bg: 'rgba(123,95,217,0.12)' } },
  fireworks: { label: 'Fireworks', icon: 'zap', accent: { from: '#d4578f', to: '#f07ab0', text: '#d4578f', bg: 'rgba(212,87,143,0.12)' } },
  auto: { label: 'Auto (routing)', icon: 'arrow-swap', accent: { from: '#0f9a9a', to: '#2fc4c4', text: '#0f9a9a', bg: 'rgba(15,154,154,0.12)' } }
}

function providerMeta(provider) {
  if (PROVIDER_META[provider]) return PROVIDER_META[provider]
  // Any provider Hermes has billed but we don't have a canned label for:
  // give it a readable name + a neutral card so it never renders as a
  // raw DB slug. Title-cases words, keeps common acronyms uppercase.
  const words = String(provider || 'unknown')
    .split(/[_-]+/)
    .filter(Boolean)
    .map(w => {
      const lower = w.toLowerCase()
      if (['ai', 'api', 'mcp', 'lm', 'llm', 'go', 'gpt', 'url'].includes(lower)) return lower.toUpperCase()
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
  return {
    label: words.length ? words.join(' ') : 'Unknown',
    icon: 'plug',
    accent: { from: '#8a8f98', to: '#c3c8cf', text: '#8a8f98', bg: 'rgba(138,143,152,0.12)' }
  }
}

function UsageTab({ data }) {
  const credits = data.credits || []
  const providers = (data.providers || [])
    // Pin 'unknown'/empty providers to the end; known providers keep the
    // backend's token-descending order (stable sort preserves it).
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const au = a.p.provider === 'unknown' || !a.p.provider
      const bu = b.p.provider === 'unknown' || !b.p.provider
      if (au !== bu) return au ? 1 : -1
      return a.i - b.i
    })
    .map(x => x.p)
  const totalTokens = providers.reduce((acc, p) => acc + (p.input || 0) + (p.output || 0), 0)
  const totalCalls = providers.reduce((acc, p) => acc + (p.api_calls || 0), 0)
  const totalCost = providers.reduce((acc, p) => acc + (p.cost || 0), 0)

  return jsxs('div', {
    className: 'flex flex-col gap-4 p-6',
    children: [
      // Summary strip
      jsxs('div', {
        className: 'grid gap-3',
        style: { gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' },
        children: [
          jsx(StatCard, { label: 'Providers', value: String(providers.length), sub: 'with recorded usage', icon: 'globe', accent: ACCENTS.blue, index: 0 }),
          jsx(StatCard, { label: 'Tokens (all-time)', value: fmtNum(totalTokens), sub: 'input + output', icon: 'graph-line', accent: ACCENTS.gold, index: 1 }),
          jsx(StatCard, { label: 'API calls', value: fmtNum(totalCalls), sub: 'across providers', icon: 'play', accent: ACCENTS.teal, index: 2 }),
          jsx(StatCard, { label: 'Estimated cost', value: totalCost ? `$${totalCost.toFixed(2)}` : 'n/a', sub: 'where recorded', icon: 'credit-card', accent: ACCENTS.rose, index: 3 })
        ]
      }),
      // Live credits — providers with a queryable balance
      jsx(Section, {
        title: 'Credits & balance',
        icon: 'credit-card',
        accent: ACCENTS.gold,
        extra: credits.length ? 'live' : 'no balance API configured',
        children: credits.length
          ? jsxs('div', {
              className: 'grid gap-3',
              style: { gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' },
              children: credits.map((c, i) => {
                if (c.error) {
                  return jsx('div', {
                    key: c.provider,
                    className: 'hc-fade-up flex items-center gap-2 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) p-4',
                    style: { animationDelay: `${i * 40}ms` },
                    children: [
                      jsx('span', { className: 'text-xs font-semibold text-(--ui-text-primary)', children: c.label }),
                      jsx('span', { className: 'ml-auto text-xs text-(--ui-error)', children: c.error })
                    ]
                  })
                }
                const remaining = c.remaining
                const total = c.total_credits
                const pct = total ? Math.round((remaining / total) * 100) : null
                return jsxs('div', {
                  key: c.provider,
                  className: 'hc-fade-up flex items-center gap-4 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) p-4 transition-all hover:-translate-y-0.5 hover:shadow-lg',
                  style: { animationDelay: `${i * 40}ms` },
                  children: [
                    jsx(RingGauge, {
                      value: remaining,
                      max: total || remaining || 1,
                      label: 'left',
                      from: pct != null && pct < 25 ? '#d64545' : '#2f9e63',
                      to: pct != null && pct < 25 ? '#d4578f' : '#0f9a9a',
                      size: 76
                    }),
                    jsxs('div', {
                      className: 'min-w-0 flex-1',
                      children: [
                        jsx('span', { className: 'block text-sm font-bold text-(--ui-text-primary)', children: c.label }),
                        jsx('span', { className: 'block text-[0.625rem] text-(--ui-text-tertiary)', children: remaining != null ? `$${remaining.toFixed(2)} remaining of $${total.toFixed(2)}` : `$${c.total_usage.toFixed(2)} used` }),
                        jsx('span', { className: 'block text-[0.625rem] text-(--ui-text-quaternary)', children: c.is_free_tier ? 'free tier' : c.limit != null ? `limit $${c.limit.toFixed(2)}` : 'prepaid credits' })
                      ]
                    })
                  ]
                })
              })
            })
          : jsx('div', {
              className: 'rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) p-4 text-xs text-(--ui-text-tertiary)',
              children: 'No provider with a queryable balance API is configured. Add an OPENROUTER_API_KEY to ~/.hermes/.env to see live credits.'
            })
      }),
      // Provider usage — real token data from local state
      jsx(Section, {
        title: 'Provider usage',
        icon: 'graph-line',
        accent: ACCENTS.gold,
        extra: `${providers.length} providers`,
        children: providers.length
          ? jsxs('div', {
              className: 'grid gap-2.5',
              style: { gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' },
              children: providers.map((p, i) => {
                const meta = providerMeta(p.provider)
                const total = (p.input || 0) + (p.output || 0)
                const maxTotal = Math.max(...providers.map(x => (x.input || 0) + (x.output || 0)), 1)
                return jsxs('div', {
                  key: p.provider + p.mode,
                  className: cn(
                    'hc-glow hc-fade-up flex flex-col gap-2.5 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) p-3.5 transition-all hover:-translate-y-0.5 hover:shadow-lg'
                  ),
                  style: { animationDelay: `${i * 30}ms` },
                  children: [
                    jsxs('div', {
                      className: 'flex items-center gap-2.5',
                      children: [
                        jsx('div', {
                          className: 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white',
                          style: { background: `linear-gradient(135deg, ${meta.accent.from} 0%, ${meta.accent.to} 100%)`, boxShadow: '0 4px 10px rgba(0,0,0,0.18)' },
                          children: jsx(Codicon, { name: meta.icon, className: 'text-sm' })
                        }),
                        jsxs('div', {
                          className: 'min-w-0 flex-1',
                          children: [
                            jsx('span', { className: 'block truncate text-xs font-bold text-(--ui-text-primary)', children: meta.label }),
                            jsx('span', { className: 'block truncate text-[0.625rem] text-(--ui-text-tertiary)', children: p.mode || 'default routing' })
                          ]
                        }),
                        jsx('span', {
                          className: 'shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-semibold tabular-nums',
                          style: { backgroundColor: meta.accent.bg, color: meta.accent.text },
                          children: p.cost ? `$${p.cost.toFixed(2)}` : fmtNum(total)
                        })
                      ]
                    }),
                    jsx('div', {
                      className: 'h-1.5 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)',
                      children: jsx('div', {
                        className: 'h-full rounded-full',
                        style: { width: `${Math.max(2, (total / maxTotal) * 100)}%`, background: `linear-gradient(90deg, ${meta.accent.from} 0%, ${meta.accent.to} 100%)` }
                      })
                    }),
                    jsxs('div', {
                      className: 'flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.625rem] text-(--ui-text-tertiary)',
                      children: [
                        p.images
                          ? jsx('span', { children: `${p.images} images` })
                          : jsx('span', { children: `${fmtNum(p.input)} in` }),
                        p.videos ? jsx('span', { children: `${p.videos} videos` }) : null,
                        !p.images && p.output ? jsx('span', { children: `${fmtNum(p.output)} out` }) : null,
                        p.cache_read ? jsx('span', { children: `${fmtNum(p.cache_read)} cache` }) : null,
                        p.reasoning ? jsx('span', { children: `${fmtNum(p.reasoning)} think` }) : null,
                        jsx('span', { className: 'ml-auto text-(--ui-text-quaternary)', children: p.images ? `${p.api_calls} generations` : `${p.api_calls} calls · ${p.models} models` })
                      ]
                    })
                  ]
                })
              })
            })
          : jsx(EmptyState, { title: 'No provider usage', description: 'No token usage recorded yet.' })
      })
    ]
  })
}

// ── Tools tab ──────────────────────────────────────────────────────────────

// Tool icon + accent by name; unknown tools get a neutral gear.
const TOOL_META = {
  terminal: { icon: 'terminal', label: 'Terminal', accent: { from: '#2f7fd4', to: '#5aa7f0', text: '#2f7fd4', bg: 'rgba(47,127,212,0.12)' } },
  patch: { icon: 'edit', label: 'Patch', accent: { from: '#7b5fd9', to: '#a48cf0', text: '#7b5fd9', bg: 'rgba(123,95,217,0.12)' } },
  read_file: { icon: 'file-code', label: 'Read file', accent: { from: '#0f9a9a', to: '#2fc4c4', text: '#0f9a9a', bg: 'rgba(15,154,154,0.12)' } },
  write_file: { icon: 'save', label: 'Write file', accent: { from: '#2f9e63', to: '#3ecf8e', text: '#2f9e63', bg: 'rgba(47,158,99,0.12)' } },
  execute_code: { icon: 'debug', label: 'Execute code', accent: { from: '#b7791f', to: '#e0a63d', text: '#b7791f', bg: 'rgba(183,121,31,0.12)' } },
  search_files: { icon: 'search', label: 'Search files', accent: { from: '#d4578f', to: '#f07ab0', text: '#d4578f', bg: 'rgba(212,87,143,0.12)' } },
  todo: { icon: 'checklist', label: 'Todo', accent: { from: '#2f9e63', to: '#3ecf8e', text: '#2f9e63', bg: 'rgba(47,158,99,0.12)' } },
  fact_store: { icon: 'database', label: 'Fact store', accent: { from: '#7b5fd9', to: '#a48cf0', text: '#7b5fd9', bg: 'rgba(123,95,217,0.12)' } },
  session_search: { icon: 'search', label: 'Session search', accent: { from: '#0f9a9a', to: '#2fc4c4', text: '#0f9a9a', bg: 'rgba(15,154,154,0.12)' } },
  memory: { icon: 'database', label: 'Memory', accent: { from: '#d4578f', to: '#f07ab0', text: '#d4578f', bg: 'rgba(212,87,143,0.12)' } },
  web_search: { icon: 'globe', label: 'Web search', accent: { from: '#2f7fd4', to: '#5aa7f0', text: '#2f7fd4', bg: 'rgba(47,127,212,0.12)' } },
  vision_analyze: { icon: 'eye', label: 'Vision', accent: { from: '#b7791f', to: '#e0a63d', text: '#b7791f', bg: 'rgba(183,121,31,0.12)' } },
  delegate_task: { icon: 'organization', label: 'Delegate', accent: { from: '#7b5fd9', to: '#a48cf0', text: '#7b5fd9', bg: 'rgba(123,95,217,0.12)' } },
  image_generate: { icon: 'device-camera', label: 'Image gen', accent: { from: '#d4578f', to: '#f07ab0', text: '#d4578f', bg: 'rgba(212,87,143,0.12)' } },
  skill_manage: { icon: 'book', label: 'Skill manage', accent: { from: '#0f9a9a', to: '#2fc4c4', text: '#0f9a9a', bg: 'rgba(15,154,154,0.12)' } },
  skill_view: { icon: 'book', label: 'Skill view', accent: { from: '#2f9e63', to: '#3ecf8e', text: '#2f9e63', bg: 'rgba(47,158,99,0.12)' } },
  browser_navigate: { icon: 'globe', label: 'Browser', accent: { from: '#2f7fd4', to: '#5aa7f0', text: '#2f7fd4', bg: 'rgba(47,127,212,0.12)' } }
}

function toolMeta(name) {
  if (TOOL_META[name]) return TOOL_META[name]
  const readable = String(name || 'unknown').replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim()
  return {
    icon: 'tools',
    label: readable || 'Unknown',
    accent: { from: '#8a8f98', to: '#c3c8cf', text: '#8a8f98', bg: 'rgba(138,143,152,0.12)' }
  }
}

function ToolsTab({ data }) {
  const tools = data.tools || []
  const totalCalls = tools.reduce((acc, t) => acc + (t.calls || 0), 0)
  const maxCalls = Math.max(...tools.map(t => t.calls), 1)

  return jsxs('div', {
    className: 'flex flex-col gap-4 p-6',
    children: [
      jsxs('div', {
        className: 'grid gap-3',
        style: { gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' },
        children: [
          jsx(StatCard, { label: 'Tools used', value: String(tools.length), sub: 'distinct tools', icon: 'tools', accent: ACCENTS.teal, index: 0 }),
          jsx(StatCard, { label: 'Total calls', value: fmtNum(totalCalls), sub: 'all time', icon: 'play', accent: ACCENTS.blue, index: 1 }),
          jsx(StatCard, { label: 'Most used', value: tools[0] ? toolMeta(tools[0].name).label : '—', sub: tools[0] ? `${fmtNum(tools[0].calls)} calls` : 'no usage yet', icon: 'star', accent: ACCENTS.gold, index: 2 }),
          jsx(StatCard, { label: 'Share of top', value: tools[0] && totalCalls ? `${Math.round((tools[0].calls / totalCalls) * 100)}%` : '—', sub: 'terminal of all calls', icon: 'graph-line', accent: ACCENTS.rose, index: 3 })
        ]
      }),
      jsx(Section, {
        title: 'Tool usage',
        icon: 'tools',
        accent: ACCENTS.teal,
        extra: `${tools.length} tools`,
        children: tools.length
          ? jsxs('div', {
              className: 'grid gap-2',
              style: { gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' },
              children: tools.map((t, i) => {
                const meta = toolMeta(t.name)
                const pct = Math.round((t.calls / maxCalls) * 100)
                return jsxs('div', {
                  key: t.name,
                  className: cn(
                    'hc-glow hc-fade-up flex items-center gap-2.5 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) p-3 transition-all hover:-translate-y-0.5 hover:shadow-lg'
                  ),
                  style: { animationDelay: `${i * 25}ms` },
                  children: [
                    jsx('div', {
                      className: 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white',
                      style: { background: `linear-gradient(135deg, ${meta.accent.from} 0%, ${meta.accent.to} 100%)`, boxShadow: '0 4px 10px rgba(0,0,0,0.18)' },
                      children: jsx(Codicon, { name: meta.icon, className: 'text-sm' })
                    }),
                    jsxs('div', {
                      className: 'min-w-0 flex-1',
                      children: [
                        jsx('span', { className: 'block truncate text-xs font-semibold text-(--ui-text-primary)', title: t.name, children: meta.label }),
                        jsx('div', {
                          className: 'mt-1 h-1.5 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)',
                          children: jsx('div', {
                            className: 'h-full rounded-full',
                            style: { width: `${Math.max(2, pct)}%`, background: `linear-gradient(90deg, ${meta.accent.from} 0%, ${meta.accent.to} 100%)` }
                          })
                        })
                      ]
                    }),
                    jsx('span', {
                      className: 'shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-semibold tabular-nums',
                      style: { backgroundColor: meta.accent.bg, color: meta.accent.text },
                      children: fmtNum(t.calls)
                    })
                  ]
                })
              })
            })
          : jsx(EmptyState, { title: 'No tool data', description: 'No tool usage recorded yet.' })
      })
    ]
  })
}

// ── System tab ─────────────────────────────────────────────────────────────

function fmtBytes(n) {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function fmtUptime(sec) {
  if (!sec) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

// Storage location metadata: per-location icon + color identity.
const STORAGE_META = {
  'state.db': { icon: 'database', accent: { from: '#7b5fd9', to: '#a48cf0', text: '#7b5fd9', bg: 'rgba(123,95,217,0.12)' } },
  logs: { icon: 'list-unordered', accent: { from: '#2f7fd4', to: '#5aa7f0', text: '#2f7fd4', bg: 'rgba(47,127,212,0.12)' } },
  sessions: { icon: 'history', accent: { from: '#0f9a9a', to: '#2fc4c4', text: '#0f9a9a', bg: 'rgba(15,154,154,0.12)' } },
  data: { icon: 'database', accent: { from: '#2f9e63', to: '#3ecf8e', text: '#2f9e63', bg: 'rgba(47,158,99,0.12)' } },
  skills: { icon: 'book', accent: { from: '#b7791f', to: '#e0a63d', text: '#b7791f', bg: 'rgba(183,121,31,0.12)' } },
  plugins: { icon: 'plug', accent: { from: '#d4578f', to: '#f07ab0', text: '#d4578f', bg: 'rgba(212,87,143,0.12)' } },
  memories: { icon: 'book', accent: { from: '#d4578f', to: '#f07ab0', text: '#d4578f', bg: 'rgba(212,87,143,0.12)' } },
  cron: { icon: 'clock', accent: { from: '#2f7fd4', to: '#5aa7f0', text: '#2f7fd4', bg: 'rgba(47,127,212,0.12)' } }
}

function SystemTab({ data }) {
  const storage = data.storage || []
  const totalBytes = data.total_bytes || storage.reduce((a, s) => a + (s.bytes || 0), 0)
  const maxBytes = Math.max(...storage.map(s => s.bytes), 1)

  return jsxs('div', {
    className: 'flex flex-col gap-4 p-6',
    children: [
      jsxs('div', {
        className: 'grid gap-3',
        style: { gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' },
        children: [
          jsx(StatCard, { label: 'Hermes home', value: fmtBytes(totalBytes), sub: 'tracked storage', icon: 'database', accent: ACCENTS.blue, index: 0 }),
          jsx(StatCard, { label: 'Commit', value: data.commit ? data.commit.slice(0, 7) : '—', sub: 'hermes-agent', icon: 'git-commit', accent: ACCENTS.purple, index: 1 }),
          jsx(StatCard, { label: 'Python', value: data.python || '—', sub: 'runtime', icon: 'code', accent: ACCENTS.teal, index: 2 }),
          jsx(StatCard, { label: 'Uptime', value: fmtUptime(data.uptime_sec), sub: 'backend process', icon: 'clock', accent: ACCENTS.gold, index: 3 })
        ]
      }),
      jsx(Section, {
        title: 'Storage',
        icon: 'database',
        accent: ACCENTS.blue,
        extra: `${fmtBytes(totalBytes)} tracked`,
        children: storage.length
          ? jsxs('div', {
              className: 'grid gap-2',
              style: { gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' },
              children: storage.map((s, i) => {
                const meta = STORAGE_META[s.name] || { icon: 'database', accent: modelColor(i % 6) }
                const pct = maxBytes ? Math.round((s.bytes / maxBytes) * 100) : 0
                return jsxs('div', {
                  key: s.name,
                  className: cn(
                    'hc-glow hc-fade-up flex items-center gap-2.5 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) p-3 transition-all hover:-translate-y-0.5 hover:shadow-lg'
                  ),
                  style: { animationDelay: `${i * 30}ms` },
                  children: [
                    jsx('div', {
                      className: 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white',
                      style: { background: `linear-gradient(135deg, ${meta.accent.from} 0%, ${meta.accent.to} 100%)`, boxShadow: '0 4px 10px rgba(0,0,0,0.18)' },
                      children: jsx(Codicon, { name: meta.icon, className: 'text-sm' })
                    }),
                    jsxs('div', {
                      className: 'min-w-0 flex-1',
                      children: [
                        jsx('span', { className: 'block truncate font-mono text-xs font-semibold text-(--ui-text-primary)', children: s.name }),
                        jsx('div', {
                          className: 'mt-1 h-1.5 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)',
                          children: jsx('div', {
                            className: 'h-full rounded-full',
                            style: { width: `${Math.max(2, pct)}%`, background: `linear-gradient(90deg, ${meta.accent.from} 0%, ${meta.accent.to} 100%)` }
                          })
                        })
                      ]
                    }),
                    jsx('span', {
                      className: 'shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-semibold tabular-nums',
                      style: { backgroundColor: meta.accent.bg, color: meta.accent.text },
                      children: fmtBytes(s.bytes)
                    })
                  ]
                })
              })
            })
          : jsx(EmptyState, { title: 'No storage data', description: 'Could not measure storage.' })
      }),
      jsx(Section, {
        title: 'Environment',
        icon: 'server',
        accent: ACCENTS.blue,
        extra: 'install details',
        children: jsxs('div', {
          className: 'grid gap-2',
          style: { gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' },
          children: [
            jsx(EnvCard, { icon: 'git-commit', label: 'Build', accent: ACCENTS.purple, rows: [['commit', data.commit || '—'], ['version', data.version || 'dev checkout']] }),
            jsx(EnvCard, { icon: 'code', label: 'Runtime', accent: ACCENTS.teal, rows: [['python', data.python || '—'], ['uptime', fmtUptime(data.uptime_sec)]] }),
            jsx(EnvCard, { icon: 'home', label: 'Home', accent: ACCENTS.gold, rows: [['path', data.home || '—']] })
          ]
        })
      })
    ]
  })
}

// Compact env card: gradient tile + label + colored value rows.
function EnvCard({ icon, label, accent, rows }) {
  return jsxs('div', {
    className: 'hc-fade-up flex items-start gap-2.5 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) p-3',
    children: [
      jsx('div', {
        className: 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white',
        style: { background: `linear-gradient(135deg, ${accent.text} 0%, ${accent.to || accent.text} 100%)`, boxShadow: '0 4px 10px rgba(0,0,0,0.15)' },
        children: jsx(Codicon, { name: icon, className: 'text-sm' })
      }),
      jsxs('div', {
        className: 'min-w-0 flex-1',
        children: [
          jsx('span', { className: 'block text-[0.625rem] font-semibold uppercase tracking-wide text-(--ui-text-quaternary)', children: label }),
          jsxs('div', {
            className: 'mt-0.5 flex flex-col gap-0.5',
            children: rows.map(r => (
              jsxs('div', {
                key: r[0],
                className: 'flex items-baseline gap-1.5 text-[0.6875rem]',
                children: [
                  jsx('span', { className: 'shrink-0 text-[0.5625rem] uppercase text-(--ui-text-quaternary)', children: r[0] }),
                  jsx('span', {
                    className: 'min-w-0 flex-1 truncate font-medium',
                    style: { color: accent.text },
                    title: r[1],
                    children: r[1]
                  })
                ]
              })
            ))
          })
        ]
      })
    ]
  })
}

// ── main page ──────────────────────────────────────────────────────────────

function CommandCenterPage() {
  usePolishCss()
  const [tab, setTab] = useState('overview')
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['command-center', tab],
    queryFn: () => rest(`/${tab === 'overview' || tab === 'memory' ? 'overview' : tab}`),
    refetchInterval: 30_000
  })

  const refresh = () => void refetch()

  return jsxs('div', {
    className: 'flex h-full flex-col',
    children: [
      // Tab bar — gradient pill for the active tab
      jsxs('div', {
        className: 'sticky top-0 z-20 flex items-center gap-1 border-b border-(--ui-stroke-secondary) bg-(--ui-bg-chrome)/95 px-6 py-2 backdrop-blur',
        children: [
          TABS.map(t => {
            const meta = TAB_META[t] || { icon: 'circle-filled', accent: ACCENTS.blue }
            const active = tab === t
            return jsxs('button', {
              key: t,
              type: 'button',
              className: cn(
                'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs capitalize transition-all',
                active ? 'text-white shadow-md' : 'text-(--ui-text-tertiary) hover:bg-(--ui-bg-quaternary) hover:text-(--ui-text-primary)'
              ),
              style: active ? { background: `linear-gradient(135deg, ${meta.accent.text} 0%, ${meta.accent.text}cc 100%)`, boxShadow: `0 4px 14px ${meta.accent.text}44` } : null,
              onClick: () => {
                haptic('tap')
                setTab(t)
              },
              children: [
                jsx(Codicon, { name: meta.icon, className: 'text-sm' }),
                t
              ]
            })
          }),
          jsx('button', {
            type: 'button',
            className: 'ml-auto flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-(--ui-text-tertiary) transition-colors hover:bg-(--ui-bg-quaternary) hover:text-(--ui-text-primary)',
            onClick: () => {
              haptic('tap')
              refresh()
            },
            children: [jsx(Codicon, { name: 'refresh', className: 'text-sm' }), 'Refresh']
          })
        ]
      }),
      jsx('div', {
        className: 'min-h-0 flex-1 overflow-y-auto',
        children: jsx('div', {
          className: 'mx-auto w-full max-w-[1200px]',
          children: isLoading
            ? jsxs('div', { className: 'flex flex-col gap-3 p-6', children: [jsx(Skeleton, { className: 'h-28 w-full rounded-xl' }), jsx(Skeleton, { className: 'h-28 w-full rounded-xl' }), jsx(Skeleton, { className: 'h-28 w-full rounded-xl' })] })
            : isError
              ? jsx(ErrorState, {
                  title: 'Could not load command center',
                  description: `${(error && error.message) || error} — is the command-center plugin enabled?`,
                  children: jsx(Button, { variant: 'secondary', onClick: () => refetch(), children: 'Retry' })
                })
              : tab === 'overview'
                ? jsx(OverviewTab, { data, onRefresh: refresh })
                : tab === 'activity'
                  ? jsx(ActivityTab, { data })
                  : tab === 'usage'
                    ? jsx(UsageTab, { data })
                    : tab === 'tools'
                      ? jsx(ToolsTab, { data })
                : tab === 'cron'
                  ? jsx(CronTab, { data })
                  : tab === 'plugins'
                    ? jsx(PluginsTab, { data })
                    : tab === 'models'
                      ? jsx(ModelsTab, { data })
                    : tab === 'skills'
                      ? jsx(SkillsTab, { data })
                      : tab === 'memory'
                        ? jsx(MemoryTab, { data })
                        : jsx(SystemTab, { data })
        })
      })
    ]
  })
}

// ── Plugin export ──────────────────────────────────────────────────────────

let rest

export default {
  id: ID,
  name: 'Hermes Center',
  description:
    'Read-only Hermes health and activity dashboard: processes, tokens, cron, plugins, models, skills, and memory in one place.',
  defaultEnabled: true,
  register(ctx) {
    rest = ctx.rest
    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/hermes-center' },
        title: 'Hermes Center',
        render: () => jsx(CommandCenterPage, {})
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 50,
        data: { path: '/hermes-center', label: 'Hermes Center', codicon: 'dashboard' }
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-center.open',
          label: 'Hermes Center: Open',
          keywords: ['hermes center', 'dashboard', 'health', 'cron', 'tokens', 'status'],
          run: () => {
            haptic('tap')
            host.navigate('/hermes-center')
          }
        }
      }
    ])
  }
}
