/**
 * What the conditions will be where a game is played.
 *
 * Only ever shown, never folded into a projection. Guessing a multiplier for
 * fourteen miles an hour of wind is the same mistake as discounting a
 * Questionable by a made-up fraction — the number would look precise and be
 * invented. This says what the sky is doing and leaves the judgement where it
 * belongs.
 *
 * A dome contributes nothing to a decision, so it is reported as a dome and
 * carries no forecast at all.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { statePath } from './paths.js'
import type { Game } from './schedule.js'

const CACHE = statePath('weather.json')
const MAX_AGE = 3 * 3600000

type Roof = 'dome' | 'retractable' | 'open'

/**
 * Where each club plays, and whether the sky reaches it. Retractable roofs are
 * kept separate from fixed ones because the club decides on the day, so a
 * forecast there is a possibility rather than a fact.
 */
const VENUE: Record<string, { lat: number; lon: number; roof: Roof }> = {
  ARI: { lat: 33.5276, lon: -112.2626, roof: 'retractable' },
  ATL: { lat: 33.7554, lon: -84.4008, roof: 'retractable' },
  BAL: { lat: 39.2780, lon: -76.6227, roof: 'open' },
  BUF: { lat: 42.7738, lon: -78.7870, roof: 'open' },
  CAR: { lat: 35.2258, lon: -80.8528, roof: 'open' },
  CHI: { lat: 41.8623, lon: -87.6167, roof: 'open' },
  CIN: { lat: 39.0955, lon: -84.5161, roof: 'open' },
  CLE: { lat: 41.5061, lon: -81.6995, roof: 'open' },
  DAL: { lat: 32.7473, lon: -97.0945, roof: 'retractable' },
  DEN: { lat: 39.7439, lon: -105.0201, roof: 'open' },
  DET: { lat: 42.3400, lon: -83.0456, roof: 'dome' },
  GB: { lat: 44.5013, lon: -88.0622, roof: 'open' },
  HOU: { lat: 29.6847, lon: -95.4107, roof: 'retractable' },
  IND: { lat: 39.7601, lon: -86.1639, roof: 'retractable' },
  JAX: { lat: 30.3239, lon: -81.6373, roof: 'open' },
  KC: { lat: 39.0489, lon: -94.4839, roof: 'open' },
  LAC: { lat: 33.9535, lon: -118.3392, roof: 'dome' },
  LAR: { lat: 33.9535, lon: -118.3392, roof: 'dome' },
  LV: { lat: 36.0909, lon: -115.1833, roof: 'dome' },
  MIA: { lat: 25.9580, lon: -80.2389, roof: 'open' },
  MIN: { lat: 44.9738, lon: -93.2578, roof: 'dome' },
  NE: { lat: 42.0909, lon: -71.2643, roof: 'open' },
  NO: { lat: 29.9511, lon: -90.0812, roof: 'dome' },
  NYG: { lat: 40.8135, lon: -74.0745, roof: 'open' },
  NYJ: { lat: 40.8135, lon: -74.0745, roof: 'open' },
  PHI: { lat: 39.9008, lon: -75.1675, roof: 'open' },
  PIT: { lat: 40.4468, lon: -80.0158, roof: 'open' },
  SEA: { lat: 47.5952, lon: -122.3316, roof: 'open' },
  SF: { lat: 37.4030, lon: -121.9698, roof: 'open' },
  TB: { lat: 27.9759, lon: -82.5033, roof: 'open' },
  TEN: { lat: 36.1665, lon: -86.7713, roof: 'open' },
  WAS: { lat: 38.9077, lon: -76.8645, roof: 'open' },
}

export interface Conditions {
  /** The club whose stadium it is. */
  venue: string
  roof: Roof
  tempF: number | null
  windMph: number | null
  /** Chance of precipitation at kickoff, as a percentage. */
  rainPct: number | null
  /** True when the conditions are worth a manager's attention. */
  notable: boolean
  /** One line, or null when there is nothing to say. */
  summary: string | null
}

/*
 * Thresholds for "worth saying". Below these the forecast is weather rather
 * than information: every outdoor game has some wind, and reporting all of it
 * trains you to ignore the field.
 */
const WIND_MPH = 15
const RAIN_PCT = 50
const COLD_F = 25

function describe(roof: Roof, tempF: number | null, windMph: number | null, rainPct: number | null) {
  if (roof === 'dome') return { notable: false, summary: 'indoors' }
  const bits: string[] = []
  if (windMph != null && windMph >= WIND_MPH) bits.push(`wind ${Math.round(windMph)} mph`)
  if (rainPct != null && rainPct >= RAIN_PCT) bits.push(`${Math.round(rainPct)}% rain`)
  if (tempF != null && tempF <= COLD_F) bits.push(`${Math.round(tempF)}°F`)
  if (!bits.length) return { notable: false, summary: null }
  return {
    notable: true,
    summary: bits.join(' · ') + (roof === 'retractable' ? ' — roof may be closed' : ''),
  }
}

interface Cache { at: number; season: number; week: number; by: Record<string, Conditions> }

/**
 * @param games this week's fixtures, which say who is at home and when.
 */
export async function forecast(
  season: number,
  week: number,
  games: Game[],
): Promise<Map<string, Conditions>> {
  if (existsSync(CACHE)) {
    try {
      const c = JSON.parse(readFileSync(CACHE, 'utf8')) as Cache
      if (c.season === season && c.week === week && Date.now() - c.at < MAX_AGE) {
        return new Map(Object.entries(c.by))
      }
    } catch {
      // A torn cache is not worth failing the week over.
    }
  }

  const by: Record<string, Conditions> = {}
  for (const g of games) {
    const v = VENUE[g.home]
    if (!v) continue
    const base: Conditions = {
      venue: g.home, roof: v.roof, tempF: null, windMph: null, rainPct: null,
      ...describe(v.roof, null, null, null),
    }
    // A dome needs no forecast; asking for one would be 16 calls a week for a
    // constant answer.
    if (v.roof !== 'dome') {
      try {
        const url =
          `https://api.open-meteo.com/v1/forecast?latitude=${v.lat}&longitude=${v.lon}` +
          `&hourly=temperature_2m,precipitation_probability,wind_speed_10m` +
          `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York&forecast_days=8`
        const res = await fetch(url)
        if (res.ok) {
          const j = (await res.json()) as any
          // nflverse writes kickoff in Eastern, and the forecast is requested
          // in the same zone, so the hour can be matched as a string.
          const [day, time] = g.kickoff.split(/\s+/)
          const want = `${day}T${(time ?? '13:00').slice(0, 2)}:00`
          const times: string[] = j.hourly?.time ?? []
          let i = times.indexOf(want)
          if (i < 0) i = times.findIndex((t) => t.startsWith(`${day}T13`))
          if (i >= 0) {
            const tempF = j.hourly.temperature_2m?.[i] ?? null
            const windMph = j.hourly.wind_speed_10m?.[i] ?? null
            const rainPct = j.hourly.precipitation_probability?.[i] ?? null
            Object.assign(base, { tempF, windMph, rainPct },
              describe(v.roof, tempF, windMph, rainPct))
          }
        }
      } catch {
        // No forecast is a missing column, not a failed week.
      }
    }
    by[g.home] = base
    by[g.away] = base
  }

  mkdirSync('fixtures', { recursive: true })
  writeFileSync(CACHE, JSON.stringify({ at: Date.now(), season, week, by } satisfies Cache))
  return new Map(Object.entries(by))
}

export const venueRoof = (team: string): Roof | null => VENUE[team]?.roof ?? null
